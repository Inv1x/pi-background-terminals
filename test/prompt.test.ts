import assert from "node:assert/strict";
import test from "node:test";
import type { OutputView, TerminalSnapshot } from "../src/domain.ts";
import {
	BG_START_PARAMETER_DESCRIPTIONS,
	BG_START_TOOL_DESCRIPTION,
	buildKillReport,
	buildStartResult,
	buildStatusResult,
	buildTerminalResultMessage,
	describeTerminal,
} from "../src/prompt.ts";

const empty: OutputView = { text: "", totalBytes: 0, truncatedBytes: 0 };
function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
	return {
		id: "bt-1",
		command: "command",
		title: "test",
		cwd: "/tmp",
		pid: 123,
		status: "done",
		createdAt: Date.now() - 1000,
		settledAt: Date.now(),
		exitCode: 0,
		stdout: empty,
		stderr: empty,
		...overrides,
	};
}

test("start prompt documents shell, no-stdin, limits, and session lifetime", () => {
	assert.match(BG_START_TOOL_DESCRIPTION, /NO stdin/);
	assert.match(BG_START_TOOL_DESCRIPTION, /session-scoped/);
	assert.match(BG_START_TOOL_DESCRIPTION, /Max 8/);
	assert.match(BG_START_PARAMETER_DESCRIPTIONS.command, /sh -c on POSIX/);
	assert.match(BG_START_PARAMETER_DESCRIPTIONS.command, /cmd\.exe/);
});

test("status and completion expose bounded tails and spill pointers", () => {
	const lines = Array.from({ length: 500 }, (_, index) => `line-${index}`).join(
		"\n",
	);
	const snap = snapshot({
		status: "failed",
		exitCode: 2,
		stdout: {
			text: lines,
			totalBytes: Buffer.byteLength(lines) + 10_000,
			truncatedBytes: 10_000,
			spillPath: "/tmp/full.log",
		},
	});
	const status = buildStatusResult(snap);
	const result = buildTerminalResultMessage(snap);
	assert.match(status, /Full log: \/tmp\/full\.log/);
	assert.match(result, /exited \(exit 2\)/);
	assert.match(result, /line-499/);
	assert.ok(result.length < status.length);
});

test("all tool-result builders make titles, output, errors, and spill paths terminal-literal", () => {
	const osc52 = "\u001b]52;c;c2VjcmV0\u0007";
	const unsafe = `${osc52}\u001b[31mVISIBLE\u001b[0m\u202E\u0000`;
	const snap = snapshot({
		title: `title-${unsafe}`,
		cwd: `/tmp/${unsafe}`,
		signal: unsafe,
		errorText: unsafe,
		stdout: {
			text: `${unsafe}\nend\u001b]52;c;unterminated`,
			totalBytes: 100_000,
			truncatedBytes: 1,
			spillPath: `/tmp/${unsafe}.log`,
		},
	});
	const rendered = [
		buildStartResult(snap),
		describeTerminal(snap),
		buildStatusResult(snap),
		buildTerminalResultMessage(snap),
		buildKillReport([
			{
				id: snap.id,
				title: snap.title,
				status: snap.status,
				wasRunning: false,
				killed: false,
				exit: unsafe,
			},
		]),
	].join("\n");
	assert.match(rendered, /VISIBLE/);
	assert.doesNotMatch(rendered, /\u001b|\u009b|\u202E|\u0000|c2VjcmV0/);
	assert.doesNotMatch(rendered, /unterminated/);
});

test("truncated output never claims /ps has a full log without a spill", () => {
	const status = buildStatusResult(
		snapshot({
			stdout: {
				text: "tail",
				totalBytes: 100,
				truncatedBytes: 96,
			},
		}),
	);
	assert.match(status, /Earlier output is unavailable/);
	assert.match(status, /\/ps also shows only the retained tail/);
	assert.doesNotMatch(status, /Full output in the \/ps viewer/);
});
