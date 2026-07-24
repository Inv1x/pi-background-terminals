/** Domain model for one session-scoped background terminal. */

export type TerminalStatus = "running" | "done" | "failed" | "killed";

export interface OutputView {
	readonly text: string;
	readonly totalBytes: number;
	readonly truncatedBytes: number;
	readonly spillPath?: string;
}

export interface TerminalSnapshot {
	readonly id: string;
	readonly command: string;
	readonly title: string;
	readonly cwd: string;
	readonly pid?: number;
	readonly status: TerminalStatus;
	readonly createdAt: number;
	readonly settledAt?: number;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly errorText?: string;
	readonly stdout: OutputView;
	readonly stderr: OutputView;
}

export function formatElapsed(snap: TerminalSnapshot) {
	const end = snap.settledAt ?? Date.now();
	const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0
		? `${minutes}m${seconds.toString().padStart(2, "0")}s`
		: `${seconds}s`;
}

export function formatExit(snap: TerminalSnapshot) {
	if (snap.status === "running") return "running";
	if (snap.signal) return snap.signal;
	if (snap.exitCode !== undefined) return `exit ${snap.exitCode}`;
	return snap.status;
}

export class SpawnError extends Error {
	readonly name = "SpawnError";
}

export class ConcurrencyLimitError extends Error {
	readonly name = "ConcurrencyLimitError";
}

export class UnknownTerminalError extends Error {
	readonly name = "UnknownTerminalError";
}
