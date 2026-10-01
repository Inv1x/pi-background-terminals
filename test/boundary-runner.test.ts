import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createEventBus,
	discoverAndLoadExtensions,
	ExtensionRunner,
	type ModelRegistry,
	type SessionBoundaryDraft,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("..", import.meta.url));
async function eventually(check: () => Promise<boolean>) {
	const end = Date.now() + 10_000;
	while (!(await check())) {
		assert.ok(Date.now() < end, "terminal failed to settle");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("real ExtensionRunner retains rejected proposals, commits once, and respects hard exits", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-boundary-"));
	const loaded = await discoverAndLoadExtensions(
		[path.join(root, "src/index.ts")],
		root,
		dir,
		createEventBus(),
	);
	assert.deepEqual(loaded.errors, []);
	const manager = SessionManager.inMemory(root);
	// /reload restarts terminal ids but keeps the conversation history.
	manager.appendCustomMessageEntry(
		"background-terminal-result",
		"previous runtime completion",
		false,
		{ id: "bt-1", deliveryId: "previous-runtime" },
	);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		root,
		manager,
		{} as ModelRegistry,
	);
	let idle = false;
	const wakeups: unknown[] = [];
	runner.bindCore(
		{
			sendMessage: (message: unknown) => {
				wakeups.push(message);
			},
		} as Parameters<ExtensionRunner["bindCore"]>[0],
		{
			isIdle: () => idle,
			getModel: () => undefined,
			getScopedModels: () => [],
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort() {},
			hasPendingMessages: () => false,
			shutdown() {},
			getContextUsage: () => undefined,
			compact() {},
			getSystemPrompt: () => "",
		},
	);
	const errors: string[] = [];
	runner.onError((error) => errors.push(error.error));
	await runner.emit({ type: "session_start", reason: "startup" });
	const start = runner.getToolDefinition("bg_start");
	const list = runner.getToolDefinition("bg_list");
	assert.ok(start && list);
	const launch = async () => {
		const result = await start.execute(
			"start",
			{
				command: "node -e \"process.stdout.write('done')\"",
				title: "boundary test",
				working_dir: null,
			},
			undefined,
			undefined,
			runner.createContext(),
		);
		const id = (result.details as { id: string }).id;
		await eventually(async () => {
			const result = await list.execute(
				"list",
				{},
				undefined,
				undefined,
				runner.createContext(),
			);
			return (
				result.details as { terminals: Array<{ id: string; status: string }> }
			).terminals.some(
				(terminal) => terminal.id === id && terminal.status !== "running",
			);
		});
		return id;
	};
	const preview = (_entries: SessionBoundaryDraft[]) => ({
		contextEntries: manager.buildSessionProjection().entries,
		contextMessages: manager.buildSessionContext().messages,
		llmMessages: [],
		pendingMessages: [],
		canContinue: true,
	});
	try {
		await launch();
		assert.equal(wakeups.length, 0);
		const invalid = await runner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			(entries) => {
				if (entries.length) throw new Error("rejected by host validation");
				return preview(entries);
			},
		);
		assert.equal(invalid.valid, false);
		assert.match(errors.join("\n"), /rejected by host validation/);
		const proposal = await runner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			preview,
		);
		assert.equal(proposal.valid, true);
		assert.equal(proposal.continue, true);
		assert.equal(proposal.entries.length, 1);
		for (const entry of proposal.entries) {
			assert.equal(entry.type, "custom_message");
			if (entry.type === "custom_message") {
				assert.equal(entry.display, false);
				assert.deepEqual(
					JSON.parse(JSON.stringify(entry.details)),
					entry.details,
				);
				manager.appendCustomMessageEntry(
					entry.customType,
					entry.content,
					entry.display,
					entry.details,
				);
			}
		}
		await runner.emit({
			type: "turn_start",
			turnIndex: 1,
			timestamp: Date.now(),
		});
		const repeated = await runner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			preview,
		);
		assert.deepEqual(repeated.entries, []);
		assert.equal(repeated.continue, false);
		idle = true;
		await runner.emit({ type: "agent_settled" });
		assert.equal(wakeups.length, 0);

		idle = false;
		await runner.emit({ type: "agent_start" });
		await launch();
		const aborted = await runner.emitBoundary(
			{ type: "agent_before_settle", outcome: "aborted" },
			preview,
		);
		assert.deepEqual(aborted.entries, []);
		assert.equal(aborted.continue, false);
		idle = true;
		await runner.emit({ type: "agent_settled" });
		assert.equal(wakeups.length, 0, "abort must not wake the model back up");
		idle = false;
		await runner.emit({ type: "agent_start" });
		const resumed = await runner.emitBoundary(
			{ type: "agent_before_settle", outcome: "completed" },
			preview,
		);
		assert.equal(
			resumed.entries.length,
			1,
			"unconsumed result survives until the next user run",
		);
	} finally {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
