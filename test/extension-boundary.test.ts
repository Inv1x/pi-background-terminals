import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import backgroundTerminals from "../src/index.ts";

function nodeCommand(script: string) {
	const encoded = Buffer.from(script).toString("base64");
	// setup-node puts a shell-safe `node` shim on PATH on every CI platform;
	// avoiding an absolute Program Files path also avoids cmd.exe /s quote folding.
	return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

async function poll(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

type ExtensionHandler = (
	event: unknown,
	ctx: ExtensionContext,
) => unknown | Promise<unknown>;

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

function renderedCall(tool: ToolDefinition, args: Record<string, unknown>) {
	assert.ok(tool.renderCall);
	return tool
		.renderCall(args, plainTheme, {} as never)
		.render(160)
		.join("\n");
}

function renderedResult(
	tool: ToolDefinition,
	result: Awaited<ReturnType<ToolDefinition["execute"]>>,
) {
	assert.ok(tool.renderResult);
	return tool
		.renderResult(
			result,
			{ expanded: true, isPartial: false },
			plainTheme,
			{} as never,
		)
		.render(160)
		.join("\n");
}

function assertTerminalLiteral(text: string) {
	assert.doesNotMatch(text, /[\u001b\u009b\u0000\u202A-\u202E\u2066-\u2069]/);
}

function createBoundaryHarness() {
	const handlers = new Map<string, ExtensionHandler[]>();
	const tools = new Map<string, ToolDefinition>();
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const bus = new Map<string, Set<(data: unknown) => void>>();
	let idle = false;

	const api = {
		on: (name: string, handler: ExtensionHandler) => {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		sendMessage: (message: unknown, options: unknown) =>
			messages.push({ message, options }),
		events: {
			on: (name: string, listener: (data: unknown) => void) => {
				const listeners = bus.get(name) ?? new Set();
				listeners.add(listener);
				bus.set(name, listeners);
				return () => listeners.delete(listener);
			},
			emit: (name: string, data: unknown) => {
				for (const listener of bus.get(name) ?? []) listener(data);
			},
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: process.cwd(),
		mode: "json",
		hasUI: false,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => "test-session" },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: () => {},
			notify: () => {},
		},
	} as unknown as ExtensionContext;

	backgroundTerminals(api);
	const emit = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler({ type: name }, ctx);
		}
	};

	return {
		ctx,
		tools,
		messages,
		emit,
		setIdle(value: boolean) {
			idle = value;
		},
	};
}

test("all extension tool call/result render paths reject title and process-output injection", async (t) => {
	if (process.platform === "win32") {
		t.skip("cmd.exe cannot portably transport the raw control-byte fixture");
		return;
	}
	const harness = createBoundaryHarness();
	await harness.emit("session_start");
	const start = harness.tools.get("bg_start");
	const status = harness.tools.get("bg_status");
	const list = harness.tools.get("bg_list");
	const kill = harness.tools.get("bg_kill");
	assert.ok(start && status && list && kill);
	const osc52 = "\u001b]52;c;c2VjcmV0\u0007";
	const title = `safe-title${osc52}\u001b[2J\u202E\u001b]52;c;unterminated`;
	const output = `visible${osc52}\u001b[31m-red\u001b[0m\u2066\u0000\nlast\u001b[12345`;

	try {
		for (const call of [
			renderedCall(start, {
				command: `echo${osc52}`,
				title,
				working_dir: `.${osc52}`,
			}),
			renderedCall(status, { id: `bt-1${osc52}` }),
			renderedCall(list, {}),
			renderedCall(kill, { ids: [`bt-1${osc52}`] }),
		]) {
			assertTerminalLiteral(call);
			assert.doesNotMatch(call, /c2VjcmV0|unterminated/);
		}

		const started = await start.execute(
			"unsafe-start",
			{
				command: nodeCommand(
					`process.stdout.write(${JSON.stringify(output)});setInterval(()=>{},1000)`,
				),
				title,
			},
			undefined,
			undefined,
			harness.ctx,
		);
		assertTerminalLiteral(renderedResult(start, started));
		assertTerminalLiteral(JSON.stringify(started.details));
		assert.doesNotMatch(JSON.stringify(started.details), /c2VjcmV0/);
		const id = (started.details as { id: string }).id;

		let statusResult:
			| Awaited<ReturnType<ToolDefinition["execute"]>>
			| undefined;
		assert.ok(
			await poll(async () => {
				statusResult = await status.execute(
					"unsafe-status",
					{ id },
					undefined,
					undefined,
					harness.ctx,
				);
				return (
					(statusResult.content[0] as { text?: string }).text?.includes(
						"visible",
					) === true
				);
			}),
		);
		assert.ok(statusResult);
		const statusText = renderedResult(status, statusResult);
		assertTerminalLiteral(statusText);
		assert.match(statusText, /visible-red/);
		assert.doesNotMatch(statusText, /c2VjcmV0|unterminated/);

		const listed = await list.execute(
			"unsafe-list",
			{},
			undefined,
			undefined,
			harness.ctx,
		);
		assertTerminalLiteral(renderedResult(list, listed));
		assertTerminalLiteral(JSON.stringify(listed.details));

		const killed = await kill.execute(
			"unsafe-kill",
			{ ids: [id] },
			undefined,
			undefined,
			harness.ctx,
		);
		assertTerminalLiteral(renderedResult(kill, killed));
		assertTerminalLiteral(JSON.stringify(killed.details));
	} finally {
		await harness.emit("session_shutdown");
	}
});

test("extension boundary delivers completion exactly once across idle/settled races", async () => {
	const harness = createBoundaryHarness();
	await harness.emit("session_start");
	const start = harness.tools.get("bg_start");
	const list = harness.tools.get("bg_list");
	assert.ok(start && list);

	try {
		harness.setIdle(false);
		const first = await start.execute(
			"call-1",
			{
				command: nodeCommand("setTimeout(()=>process.exit(0),80)"),
				title: "busy settlement",
			},
			undefined,
			undefined,
			harness.ctx,
		);
		const firstPid = (first.details as { pid?: number }).pid;
		assert.ok(firstPid);
		assert.ok(
			await poll(() => {
				try {
					process.kill(firstPid, 0);
					return false;
				} catch {
					return true;
				}
			}),
		);
		assert.ok(
			await poll(async () => {
				const result = await list.execute(
					"list-1",
					{},
					undefined,
					undefined,
					harness.ctx,
				);
				const terminals = (
					result.details as {
						terminals: Array<{ id: string; status: string }>;
					}
				).terminals;
				return terminals.some(
					(terminal) =>
						terminal.id === (first.details as { id: string }).id &&
						terminal.status !== "running",
				);
			}),
		);
		assert.equal(harness.messages.length, 0);
		harness.setIdle(true);
		await harness.emit("agent_settled");
		await harness.emit("agent_settled");
		assert.equal(harness.messages.length, 1);

		const second = await start.execute(
			"call-2",
			{
				command: nodeCommand("setTimeout(()=>process.exit(0),100)"),
				title: "idle settlement",
			},
			undefined,
			undefined,
			harness.ctx,
		);
		assert.ok((second.details as { pid?: number }).pid);
		// This drain happens before settlement; the isIdle fast path must still
		// deliver when settlement wins the other side of the race.
		await harness.emit("agent_settled");
		assert.ok(await poll(() => harness.messages.length === 2));
		await harness.emit("agent_settled");
		assert.equal(harness.messages.length, 2);
		assert.deepEqual(
			harness.messages.map(({ options }) => options),
			[
				{ deliverAs: "followUp", triggerTurn: true },
				{ deliverAs: "followUp", triggerTurn: true },
			],
		);
	} finally {
		await harness.emit("session_shutdown");
	}
});

test("session shutdown through the extension boundary reaps a running child", async () => {
	const harness = createBoundaryHarness();
	await harness.emit("session_start");
	const start = harness.tools.get("bg_start");
	assert.ok(start);
	let shutdown = false;
	try {
		const result = await start.execute(
			"call-shutdown",
			{
				command: nodeCommand("setInterval(()=>{},1000)"),
				title: "shutdown cleanup",
			},
			undefined,
			undefined,
			harness.ctx,
		);
		const pid = (result.details as { pid?: number }).pid;
		assert.ok(pid);
		await harness.emit("session_shutdown");
		shutdown = true;
		assert.ok(
			await poll(() => {
				try {
					process.kill(pid, 0);
					return false;
				} catch {
					return true;
				}
			}),
			`pid ${pid} was reaped during session_shutdown`,
		);
	} finally {
		if (!shutdown) await harness.emit("session_shutdown");
	}
});
