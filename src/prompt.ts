/** All model-facing strings for the background-terminals tools. */

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { formatElapsed, formatExit, type TerminalSnapshot } from "./domain.ts";
import { type KillResult, MAX_RUNNING, MAX_TRACKED } from "./manager.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./terminal-text.ts";

/** bg_status stdout tail. */
export const STATUS_STDOUT_MAX = 16 * 1024;
/** bg_status stderr tail. */
export const STATUS_STDERR_MAX = 8 * 1024;
/** Completion follow-up stdout tail. Keep this concise; /ps has the detailed view. */
export const RESULT_STDOUT_MAX = 8 * 1024;
/** Completion follow-up stderr tail. Keep this concise; /ps has the detailed view. */
export const RESULT_STDERR_MAX = 4 * 1024;
const STATUS_STDOUT_MAX_LINES = 400;
const STATUS_STDERR_MAX_LINES = 200;
const RESULT_STDOUT_MAX_LINES = 40;
const RESULT_STDERR_MAX_LINES = 20;

export const BG_START_TOOL_DESCRIPTION =
	"Start a long-running shell command as a background terminal (executed via the platform shell — sh -c on POSIX, cmd.exe /d /s /c on Windows). " +
	"Fire-and-forget: this returns immediately with an id, and you get a model-visible, transcript-quiet message with the final output when the process exits. " +
	"The process receives NO stdin (immediate EOF) and there is no way to send input later — interactive commands will not work; use bg_kill to stop a stuck one. " +
	`Terminals are session-scoped: they are killed when the session ends or reloads. Settled terminals remain available to /ps for five minutes. Output shown to you is tail-truncated (stdout ${formatSize(STATUS_STDOUT_MAX)}, stderr ${formatSize(STATUS_STDERR_MAX)}); /ps is the user's detailed output surface, showing retained tails and a private spill path when a complete spill is available. ` +
	`Max ${MAX_RUNNING} background terminals can run at once and ${MAX_TRACKED} running-or-retained terminals can be tracked; the latter bound rejects new starts rather than shortening retention.`;

export const BG_START_PROMPT_SNIPPET =
	"Run a long-lived shell command in the background (dev servers, builds, watchers); output is captured and you're notified on exit";

export const BG_START_PROMPT_GUIDELINES = [
	"Use bg_start for commands expected to run long or indefinitely (servers, watch modes, long builds); use the regular bash tool for quick commands.",
	"bg_start processes receive no stdin — never start a command that requires interactive input.",
	"After bg_start, keep working; the exit result arrives automatically. Use bg_status only when you need current output before continuing.",
];

export const BG_START_PARAMETER_DESCRIPTIONS = {
	command:
		"Shell command line to run in the background (sh -c on POSIX, cmd.exe /d /s /c on Windows). It receives no stdin (EOF immediately); interactive commands will not work.",
	title: "Short human-readable name shown in listings and the UI",
	workingDir: "Working directory, or null to use the current working directory",
};

export const BG_STATUS_TOOL_DESCRIPTION =
	"Peek at a background terminal's status and current output (tail-truncated) without blocking. If the terminal already exited, this returns its final state.";

export const BG_STATUS_PARAMETER_DESCRIPTIONS = {
	id: 'Terminal id, e.g. "bt-1"',
};

export const BG_LIST_TOOL_DESCRIPTION =
	"List running background terminals and terminals settled within the last five minutes, with pid, elapsed time, exit status, and output sizes.";

export const BG_KILL_TOOL_DESCRIPTION =
	"Stop one or more running background terminals (SIGTERM to the whole process tree, escalating to SIGKILL). Returns each terminal's final state; already-settled ids are reported as such.";

export const BG_KILL_PARAMETER_DESCRIPTIONS = {
	ids: 'Terminal ids to stop, e.g. ["bt-1"]',
};

export function buildStartResult(snap: TerminalSnapshot) {
	const id = sanitizeTerminalLine(snap.id);
	const title = sanitizeTerminalLine(snap.title);
	const cwd = sanitizeTerminalLine(snap.cwd);
	return (
		`Started background terminal ${id} "${title}" (pid ${snap.pid ?? "?"}, ${cwd}).\n` +
		`It runs in the background with no stdin. You'll get a message when it exits, ` +
		`or use bg_status(id: "${id}") to peek, bg_kill to stop it, bg_list to see all.`
	);
}

/** One metadata line: `bt-1 [running] "dev server" (pid 12345, 3m12s, exit -, /path)`. */
export function describeTerminal(snap: TerminalSnapshot) {
	const details = [
		`pid ${snap.pid ?? "?"}`,
		formatElapsed(snap),
		snap.status === "running"
			? "exit -"
			: sanitizeTerminalLine(formatExit(snap)),
		sanitizeTerminalLine(snap.cwd),
		`stdout ${formatSize(snap.stdout.totalBytes)}, stderr ${formatSize(snap.stderr.totalBytes)}`,
	];
	return `${sanitizeTerminalLine(snap.id)} [${snap.status}] "${sanitizeTerminalLine(snap.title)}" (${details.join(", ")})`;
}

/** Tail-truncated labeled output section with a pointer at the full log. */
function outputSection(
	label: string,
	view: TerminalSnapshot["stdout"],
	maxBytes: number,
	maxLines: number,
) {
	if (view.totalBytes === 0) return `${label}: (empty)`;
	// Sanitize the complete retained tail before truncating it. Truncating first
	// could split an escape sequence and make a second sanitization behave
	// differently; the shared sanitizer is idempotent as an additional guard.
	const truncation = truncateTail(sanitizeTerminalText(view.text), {
		maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
		maxLines: Math.min(maxLines, DEFAULT_MAX_LINES),
	});
	let text = `${label}:\n${truncation.content}`;
	const shownBytes = truncation.outputBytes;
	if (truncation.truncated || view.truncatedBytes > 0) {
		const where = view.spillPath
			? `Full log: ${sanitizeTerminalLine(view.spillPath)}`
			: view.truncatedBytes > 0
				? "Earlier output is unavailable; /ps also shows only the retained tail"
				: "More retained output is available in /ps";
		text += `\n[${label} truncated: showing last ${formatSize(shownBytes)} of ${formatSize(view.totalBytes)}. ${where}]`;
	}
	return text;
}

export function buildStatusResult(snap: TerminalSnapshot) {
	let text = describeTerminal(snap);
	if (snap.errorText)
		text += `\nError: ${sanitizeTerminalText(snap.errorText)}`;
	text += `\n\n${outputSection("stdout", snap.stdout, STATUS_STDOUT_MAX, STATUS_STDOUT_MAX_LINES)}`;
	text += `\n\n${outputSection("stderr", snap.stderr, STATUS_STDERR_MAX, STATUS_STDERR_MAX_LINES)}`;
	return text;
}

/** The async completion follow-up injected into the model's context. */
export function buildTerminalResultMessage(snap: TerminalSnapshot) {
	const how =
		snap.status === "killed"
			? "was killed"
			: `exited (${sanitizeTerminalLine(formatExit(snap))})`;
	let text = `Background terminal ${sanitizeTerminalLine(snap.id)} "${sanitizeTerminalLine(snap.title)}" ${how} after ${formatElapsed(snap)}.`;
	if (snap.errorText)
		text += `\nError: ${sanitizeTerminalText(snap.errorText)}`;
	text += `\n\n${outputSection("stdout", snap.stdout, RESULT_STDOUT_MAX, RESULT_STDOUT_MAX_LINES)}`;
	if (snap.stderr.totalBytes > 0) {
		text += `\n\n${outputSection("stderr", snap.stderr, RESULT_STDERR_MAX, RESULT_STDERR_MAX_LINES)}`;
	}
	return text;
}

export function buildKillReport(results: ReadonlyArray<KillResult>) {
	return results
		.map((entry) => {
			const id = sanitizeTerminalLine(entry.id);
			const title = sanitizeTerminalLine(entry.title);
			const exit = sanitizeTerminalLine(entry.exit);
			if (entry.killed) return `Killed ${id} "${title}" (${exit}).`;
			if (entry.wasRunning) {
				// The natural exit won the race with the kill signal.
				return `${id} "${title}" exited on its own before the kill landed (${exit}).`;
			}
			return `${id} "${title}" was already ${entry.status} (${exit}).`;
		})
		.join("\n");
}
