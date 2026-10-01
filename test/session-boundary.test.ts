import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("..", import.meta.url));
const zeroUsage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("AgentSession commits active completions once and defers settled-handler wakeups", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-session-"));
	let session: AgentSession | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			cacheWarming: "off",
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(dir, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider("offline-boundary-test", {
			baseUrl: "http://127.0.0.1:1",
			api: "openai-completions",
			apiKey: "offline-test-not-a-credential",
			models: [
				{
					id: "test",
					name: "test",
					reasoning: false,
					input: ["text"],
					contextWindow: 100_000,
					maxTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		const model = modelRuntime.getModel("offline-boundary-test", "test");
		assert.ok(model);
		let settledWakeup = false;
		const order: string[] = [];
		const observer = (pi: ExtensionAPI) => {
			pi.on("agent_start", () => {
				order.push("start");
			});
			pi.on("agent_settled", () => {
				order.push("settled-first");
				if (!settledWakeup) {
					settledWakeup = true;
					pi.sendMessage(
						{
							customType: "test-wakeup",
							content: "settled wakeup",
							display: false,
						},
						{ triggerTurn: true },
					);
				}
			});
			pi.on("agent_settled", () => {
				order.push("settled-last");
			});
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: dir,
			settingsManager,
			additionalExtensionPaths: [path.join(root, "src/index.ts")],
			extensionFactories: [observer],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: dir,
			resourceLoader,
			settingsManager,
			modelRuntime,
			model,
			sessionManager: SessionManager.inMemory(root),
		}));
		const active = session;
		const errors: string[] = [];
		await active.bindExtensions({
			mode: "json",
			onError: (event) => errors.push(event.error),
		});
		let calls = 0;
		const requests: string[] = [];
		active.agent.streamFunction = async (_model, context) => {
			calls++;
			assert.ok(calls <= 3, "boundary continuation must not loop");
			requests.push(JSON.stringify(context.messages));
			if (calls === 1) {
				const start = active.getToolDefinition("bg_start");
				const list = active.getToolDefinition("bg_list");
				assert.ok(start && list);
				await start.execute(
					"start",
					{
						command: "node -e \"process.stdout.write('boundary-output')\"",
						title: "during model request",
						working_dir: null,
					},
					undefined,
					undefined,
					{ cwd: root } as never,
				);
				const deadline = Date.now() + 10_000;
				while (true) {
					const result = await list.execute("list", {}, undefined, undefined, {
						cwd: root,
					} as never);
					const terminals = (
						result.details as { terminals: Array<{ status: string }> }
					).terminals;
					if (
						terminals.length &&
						terminals.every((terminal) => terminal.status !== "running")
					)
						break;
					assert.ok(Date.now() < deadline, "terminal did not settle");
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			}
			const message = {
				role: "assistant" as const,
				api: "openai-completions" as const,
				provider: model.provider,
				model: model.id,
				content: [{ type: "text" as const, text: `reply ${calls}` }],
				usage: zeroUsage,
				stopReason: "stop" as const,
				timestamp: Date.now(),
			};
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: message };
					yield { type: "done", reason: "stop", message };
				},
				result: async () => message,
			} as unknown as Awaited<ReturnType<typeof active.agent.streamFunction>>;
		};
		await active.prompt("Start the offline boundary test");
		await active.waitForIdle();
		assert.deepEqual(errors, []);
		assert.equal(
			calls,
			3,
			"initial request, completion continuation, and settled wakeup",
		);
		assert.match(requests[1] ?? "", /boundary-output/);
		assert.match(requests[2] ?? "", /settled wakeup/);
		const completions = active.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "background-terminal-result",
			);
		assert.equal(completions.length, 1);
		assert.equal(active.agent.hasQueuedMessages(), false);
		assert.deepEqual(order, [
			"start",
			"settled-first",
			"settled-last",
			"start",
			"settled-first",
			"settled-last",
		]);
	} finally {
		if (session) {
			await session.reload();
			session.dispose();
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
