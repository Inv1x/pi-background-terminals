import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ConcurrencyLimitError, type TerminalSnapshot } from "../src/domain.ts";
import {
	backgroundProcessEnvironment,
	createTerminalManager,
	MAX_RUNNING,
	PI_SESSION_ENVIRONMENT_KEYS,
	type TerminalManager,
} from "../src/manager.ts";
import { createDeferredResultDelivery } from "../src/result-delivery.ts";
import { createTerminalRuntime, runTool } from "../src/runtime.ts";

function nodeCommand(script: string) {
	const encoded = Buffer.from(script).toString("base64");
	return `"${process.execPath.replaceAll('"', '\\"')}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

async function withManager(run: (manager: TerminalManager) => Promise<void>) {
	const manager = createTerminalManager();
	try {
		await run(manager);
	} finally {
		await manager.disposeAll();
	}
}

function settled(
	manager: TerminalManager,
	id: string,
): Promise<TerminalSnapshot> {
	const current = manager.view.get(id);
	if (current && current.status !== "running") return Promise.resolve(current);
	return new Promise<TerminalSnapshot>((resolve) => {
		const unsubscribe = manager.view.subscribeTo(id, () => {
			const snapshot = manager.view.get(id);
			if (snapshot && snapshot.status !== "running") {
				unsubscribe();
				resolve(snapshot);
			}
		});
	});
}

async function poll(check: () => boolean, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return true;
}

test("background children omit Pi session metadata but inherit process markers", async () => {
	const environment: NodeJS.ProcessEnv = {
		AI_AGENT: "pi",
		PI_CODING_AGENT: "true",
		PI_SESSION_ID: "session-id",
		PI_SESSION_FILE: "/private/session.jsonl",
		PI_PROVIDER: "provider",
		PI_MODEL: "model",
		PI_REASONING_LEVEL: "high",
	};
	const filtered = backgroundProcessEnvironment(environment);
	assert.equal(filtered.AI_AGENT, "pi");
	assert.equal(filtered.PI_CODING_AGENT, "true");
	for (const key of PI_SESSION_ENVIRONMENT_KEYS)
		assert.equal(filtered[key], undefined);

	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(environment)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	try {
		await withManager(async (manager) => {
			const keys = [
				"AI_AGENT",
				"PI_CODING_AGENT",
				...PI_SESSION_ENVIRONMENT_KEYS,
			];
			const started = await manager.start({
				command: nodeCommand(
					`process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((key)=>[key,process.env[key]??null]))))`,
				),
				title: "environment",
				cwd: process.cwd(),
			});
			const done = await settled(manager, started.id);
			const childEnvironment = JSON.parse(done.stdout.text) as Record<
				string,
				string | null
			>;
			assert.equal(childEnvironment.AI_AGENT, "pi");
			assert.equal(childEnvironment.PI_CODING_AGENT, "true");
			for (const key of PI_SESSION_ENVIRONMENT_KEYS)
				assert.equal(childEnvironment[key], null);
		});
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("captures stdout/stderr separately, observes stdin EOF, and settles once", async () => {
	await withManager(async (manager) => {
		const followups: Array<{ id: string; killPending: boolean }> = [];
		manager.view.setOnSettled((snapshot, killPending) => {
			followups.push({ id: snapshot.id, killPending });
		});
		const started = await manager.start({
			command: nodeCommand(
				"process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('eof\\n'));",
			),
			title: "capture",
			cwd: process.cwd(),
		});
		const done = await settled(manager, started.id);
		assert.equal(done.status, "done");
		assert.equal(done.exitCode, 0);
		assert.equal(done.stdout.text, "out\neof\n");
		assert.equal(done.stderr.text, "err\n");
		assert.deepEqual(followups, [{ id: started.id, killPending: false }]);
		if (done.stdout.spillPath) {
			assert.equal(
				fs.readFileSync(done.stdout.spillPath, "utf8"),
				"out\neof\n",
			);
		}
	});
});

test("kill terminates the process tree and marks its completion reserved", async () => {
	await withManager(async (manager) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bt-tree-test-"));
		const heartbeat = path.join(directory, "heartbeat");
		const grandchild = Buffer.from(
			`const fs=require('fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),40)`,
		).toString("base64");
		const events: Array<{ status: string; killPending: boolean }> = [];
		manager.view.setOnSettled((snapshot, killPending) => {
			events.push({ status: snapshot.status, killPending });
		});
		try {
			const started = await manager.start({
				command: nodeCommand(
					`require('child_process').spawn(process.execPath,['-e',"eval(Buffer.from('${grandchild}','base64').toString())"],{stdio:'ignore'});setInterval(()=>{},1000)`,
				),
				title: "tree",
				cwd: process.cwd(),
			});
			assert.ok(
				await poll(() => fs.existsSync(heartbeat)),
				"grandchild started",
			);
			const [result] = await manager.kill([started.id]);
			assert.equal(result.status, "killed");
			assert.equal(result.wasRunning, true);
			assert.equal(result.killed, true);
			assert.deepEqual(events, [{ status: "killed", killPending: true }]);
			const value = fs.readFileSync(heartbeat, "utf8");
			await new Promise((resolve) => setTimeout(resolve, 200));
			assert.equal(fs.readFileSync(heartbeat, "utf8"), value);
			const [again] = await manager.kill([started.id]);
			assert.equal(again.wasRunning, false);
			assert.equal(again.killed, false);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

test("aborted kill wait continues termination and retains automatic delivery", {
	skip: process.platform === "win32",
}, async () => {
	const runtime = createTerminalRuntime();
	const delivery = createDeferredResultDelivery<TerminalSnapshot>();
	runtime.manager.view.setOnSettled((snapshot) => {
		delivery.defer(snapshot);
	});
	try {
		const started = await runtime.manager.start({
			command: nodeCommand(
				"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
			),
			title: "abort kill",
			cwd: process.cwd(),
		});
		const releaseDelivery = delivery.hold([started.id]);
		const operation = runtime.manager.kill([started.id]);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			runTool(runtime, operation, { signal: controller.signal }),
			/aborted/,
		);
		releaseDelivery(false);
		await operation;
		assert.equal(runtime.manager.view.get(started.id)?.status, "killed");
		assert.deepEqual(
			delivery.drain().map((snapshot) => snapshot.id),
			[started.id],
		);
	} finally {
		await runtime.dispose();
	}
});

test("reaps POSIX descendants with redirected stdio after the root closes", {
	skip: process.platform === "win32",
}, async () => {
	await withManager(async (manager) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bt-reap-test-"));
		const heartbeat = path.join(directory, "heartbeat");
		const descendant = Buffer.from(
			`const fs=require('fs');const beat=()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now()));beat();setInterval(beat,30)`,
		).toString("base64");
		try {
			const started = await manager.start({
				command: nodeCommand(
					`require('child_process').spawn(process.execPath,['-e',"eval(Buffer.from('${descendant}','base64').toString())"],{stdio:'ignore'}).unref();setTimeout(()=>{},150);`,
				),
				title: "redirected descendant",
				cwd: process.cwd(),
			});
			await settled(manager, started.id);
			assert.ok(
				await poll(() => fs.existsSync(heartbeat)),
				"descendant started",
			);
			assert.ok(
				await poll(() => {
					const before = fs.readFileSync(heartbeat, "utf8");
					return Date.now() - Number(before) > 150;
				}),
				"descendant stopped after root close",
			);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

test("bounds aggregate spills and deletes spill files for pruned records", async () => {
	const manager = createTerminalManager({
		maxTracked: 1,
		retainedPerStream: 4,
		maxSpillBytesPerStream: 100,
		maxSpillBytesPerSession: 10,
	});
	try {
		const first = await manager.start({
			command: nodeCommand(
				"process.stdout.write('123456');process.stderr.write('abcdef')",
			),
			title: "aggregate",
			cwd: process.cwd(),
		});
		const firstDone = await settled(manager, first.id);
		const views = [firstDone.stdout, firstDone.stderr];
		assert.equal(
			views.filter((view) => view.spillPath !== undefined).length,
			1,
		);
		assert.match(firstDone.errorText ?? "", /aggregate safety limit/);
		const spillPath = views.find((view) => view.spillPath)?.spillPath;
		assert.ok(spillPath && fs.existsSync(spillPath));
		assert.ok(fs.statSync(spillPath).size <= 10);

		const second = await manager.start({
			command: nodeCommand("process.stdout.write('next')"),
			title: "prune",
			cwd: process.cwd(),
		});
		await settled(manager, second.id);
		assert.equal(manager.view.get(first.id), undefined);
		assert.equal(fs.existsSync(spillPath), false);
	} finally {
		await manager.disposeAll();
	}
});

test("enforces eight running terminals and shutdown reaps all of them", async () => {
	const manager = createTerminalManager();
	const command = nodeCommand("setInterval(()=>{},1000)");
	const started = await Promise.all(
		Array.from({ length: MAX_RUNNING }, (_, index) =>
			manager.start({ command, title: `worker-${index}`, cwd: process.cwd() }),
		),
	);
	await assert.rejects(
		manager.start({ command, title: "too-many", cwd: process.cwd() }),
		ConcurrencyLimitError,
	);
	assert.equal(
		manager.view.list().filter((snapshot) => snapshot.status === "running")
			.length,
		MAX_RUNNING,
	);
	await manager.disposeAll();
	assert.equal(manager.view.size(), 0);
	for (const terminal of started) {
		if (!terminal.pid) continue;
		assert.ok(
			await poll(() => {
				try {
					process.kill(terminal.pid as number, 0);
					return false;
				} catch {
					return true;
				}
			}),
			`pid ${terminal.pid} was reaped`,
		);
	}
});
