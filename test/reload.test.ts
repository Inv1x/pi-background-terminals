import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedTools = ["bg_start", "bg_status", "bg_list", "bg_kill"];

function nodeCommand(script: string) {
	const encoded = Buffer.from(script).toString("base64");
	return `"${process.execPath.replaceAll('"', '\\"')}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

async function poll(check: () => boolean, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

function assertToolsRemainExposed(session: {
	getAllTools(): Array<{ name: string }>;
	getActiveToolNames(): string[];
	getToolDefinition(name: string):
		| {
				parameters: unknown;
				constrainedSampling?: unknown;
		  }
		| undefined;
}): void {
	const registered = new Set(session.getAllTools().map((tool) => tool.name));
	const active = new Set(session.getActiveToolNames());
	for (const name of expectedTools) {
		assert.equal(
			registered.has(name),
			true,
			`${name} should remain registered`,
		);
		assert.equal(active.has(name), true, `${name} should remain active`);
		const definition = session.getToolDefinition(name);
		assert.ok(definition);
		assert.deepEqual(definition.constrainedSampling, {
			type: "json_schema",
			strict: "prefer",
		});
		assert.equal(
			(definition.parameters as { additionalProperties?: boolean })
				.additionalProperties,
			false,
		);
	}
	const killSchema = session.getToolDefinition("bg_kill")?.parameters as {
		properties?: {
			ids?: { minItems?: number; items?: { minLength?: number } };
		};
	};
	assert.equal(killSchema.properties?.ids?.minItems, 1);
	assert.equal(killSchema.properties?.ids?.items?.minLength, 1);
}

test("background terminal tools remain registered and active after reload", async () => {
	const agentDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-background-terminals-reload-"),
	);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: [packageRoot] }),
	);
	const settingsManager = SettingsManager.create(packageRoot, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: packageRoot,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});

	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: packageRoot,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			assertToolsRemainExposed(session);
			const start = session.getToolDefinition("bg_start");
			assert.ok(start);
			const result = await start.execute(
				"reload-cleanup",
				{
					command: nodeCommand("setInterval(()=>{},1000)"),
					title: "reload cleanup",
				},
				undefined,
				undefined,
				{ cwd: packageRoot } as never,
			);
			const pid = (result.details as { pid?: number }).pid;
			assert.ok(pid);

			await session.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			assertToolsRemainExposed(session);
			assert.ok(
				await poll(() => {
					try {
						process.kill(pid, 0);
						return false;
					} catch {
						return true;
					}
				}),
				`pid ${pid} was reaped during reload`,
			);
		} finally {
			session.dispose();
		}
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
