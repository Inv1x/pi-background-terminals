import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	ConcurrencyLimitError,
	formatExit,
	SpawnError,
	type TerminalSnapshot,
	type TerminalStatus,
	UnknownTerminalError,
} from "./domain.ts";
import { OutputBuffer } from "./output.ts";
import { sanitizeTerminalLine } from "./terminal-text.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
export const SETTLED_RETENTION_MS = 5 * 60 * 1000;
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
export const MAX_SPILL_BYTES_PER_STREAM = 256 * 1024 * 1024;
export const MAX_SPILL_BYTES_PER_SESSION = 512 * 1024 * 1024;
const FORCE_KILL_AFTER_MS = 2_000;
const FINAL_KILL_WAIT_MS = 500;
const SETTLE_GRACE_MS = 1_000;
const SPILL_FLUSH_TIMEOUT_MS = 1_500;
const ERROR_TEXT_MAX_LENGTH = 4_096;

/** Pi's bash-tool-only session metadata must not leak into arbitrary children. */
export const PI_SESSION_ENVIRONMENT_KEYS = [
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
] as const;

export function backgroundProcessEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const childEnvironment = { ...environment };
	for (const key of PI_SESSION_ENVIRONMENT_KEYS) delete childEnvironment[key];
	return childEnvironment;
}

interface MutableSnapshot extends TerminalSnapshot {
	status: TerminalStatus;
	pid?: number;
	settledAt?: number;
	exitCode?: number;
	signal?: string;
	errorText?: string;
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

interface SpillState {
	readonly file: fs.WriteStream;
	readonly path: string;
	bytes: number;
}

interface Entry {
	snapshot: MutableSnapshot;
	child: ChildProcess;
	stdoutBuf: OutputBuffer;
	stderrBuf: OutputBuffer;
	spills: SpillState[];
	settled: Deferred;
	killSignaled: boolean;
	processErrored: boolean;
	exited: boolean;
	stdioClosed: boolean;
	outputFrozen: boolean;
	settling?: Promise<void>;
	termination?: Promise<void>;
	exitCleanupTimer?: ReturnType<typeof setTimeout>;
	retentionTimer?: ReturnType<typeof setTimeout>;
	stdoutData?: (chunk: string) => void;
	stderrData?: (chunk: string) => void;
}

export interface StartOptions {
	readonly command: string;
	readonly title: string;
	readonly cwd: string;
}

export interface KillResult {
	readonly id: string;
	readonly title: string;
	readonly status: TerminalStatus;
	readonly wasRunning: boolean;
	readonly killed: boolean;
	readonly exit: string;
}

export interface TerminalReadModel {
	list(): ReadonlyArray<TerminalSnapshot>;
	get(id: string): TerminalSnapshot | undefined;
	size(): number;
	subscribe(listener: () => void): () => void;
	subscribeTo(id: string, listener: () => void): () => void;
	requestKill(id: string): void;
	setOnSettled(
		hook: ((snap: TerminalSnapshot, killPending: boolean) => void) | undefined,
	): void;
}

export interface TerminalManagerOptions {
	/** Test/integration overrides; production callers use the bounded defaults. */
	readonly maxTracked?: number;
	readonly settledRetentionMs?: number;
	readonly retainedPerStream?: number;
	readonly maxSpillBytesPerStream?: number;
	readonly maxSpillBytesPerSession?: number;
}

export interface TerminalManager {
	start(options: StartOptions): Promise<TerminalSnapshot>;
	status(id: string): Promise<TerminalSnapshot>;
	kill(ids: ReadonlyArray<string>): Promise<ReadonlyArray<KillResult>>;
	list(): ReadonlyArray<TerminalSnapshot>;
	disposeAll(): Promise<void>;
	readonly view: TerminalReadModel;
}

function defer(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function boundedWait(promise: Promise<unknown>, ms: number) {
	await Promise.race([promise, delay(ms)]);
}

function boundedError(error: unknown) {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		ERROR_TEXT_MAX_LENGTH,
	);
}

/** Detach one coherent public value from the live output accessors. */
export function detachTerminalSnapshot(
	snapshot: TerminalSnapshot,
): TerminalSnapshot {
	// Each accessor is intentionally read once: joining a large live buffer twice
	// is wasteful and could mix versions if this helper ever gains an await.
	const stdout = snapshot.stdout;
	const stderr = snapshot.stderr;
	return {
		id: snapshot.id,
		command: snapshot.command,
		title: snapshot.title,
		cwd: snapshot.cwd,
		pid: snapshot.pid,
		status: snapshot.status,
		createdAt: snapshot.createdAt,
		settledAt: snapshot.settledAt,
		exitCode: snapshot.exitCode,
		signal: snapshot.signal,
		errorText: snapshot.errorText,
		stdout: { ...stdout },
		stderr: { ...stderr },
	};
}

function appendError(snapshot: MutableSnapshot, text: string) {
	const next = snapshot.errorText ? `${snapshot.errorText}; ${text}` : text;
	snapshot.errorText = next.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function shellInvocation(command: string) {
	if (process.platform === "win32") {
		return {
			shell: process.env.ComSpec ?? "cmd.exe",
			args: ["/d", "/s", "/c", command],
		};
	}
	return { shell: "/bin/sh", args: ["-c", command] };
}

/** Signal the process group on POSIX and the complete task tree on Windows. */
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
	if (process.platform === "win32" && child.pid) {
		try {
			const killer = spawn(
				"taskkill",
				[
					"/pid",
					String(child.pid),
					"/T",
					...(signal === "SIGKILL" ? ["/F"] : []),
				],
				{ stdio: "ignore", windowsHide: true },
			);
			const fallback = () => {
				try {
					child.kill(signal);
				} catch {
					// The process already exited.
				}
			};
			killer.once("error", fallback);
			killer.once("exit", (code) => {
				if (code !== 0) fallback();
			});
			killer.unref();
			return;
		} catch {
			// Fall through to direct termination.
		}
	}
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The process group may already be gone.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// The process already exited.
	}
}

function waitForClose(entry: Entry) {
	if (entry.stdioClosed) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const onClose = () => {
			entry.child.off("close", onClose);
			resolve();
		};
		entry.child.once("close", onClose);
	});
}

function posixGroupExists(pid: number) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalPosixGroup(pid: number, signal: NodeJS.Signals) {
	try {
		process.kill(-pid, signal);
	} catch {
		// The process group is already gone.
	}
}

async function waitForPosixGroupExit(pid: number, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	while (posixGroupExists(pid) && Date.now() < deadline) await delay(25);
	return !posixGroupExists(pid);
}

export function createTerminalManager(
	options: TerminalManagerOptions = {},
): TerminalManager {
	const maxTracked = options.maxTracked ?? MAX_TRACKED;
	const settledRetentionMs = options.settledRetentionMs ?? SETTLED_RETENTION_MS;
	const retainedPerStream = options.retainedPerStream ?? RETAINED_PER_STREAM;
	const maxSpillBytesPerStream =
		options.maxSpillBytesPerStream ?? MAX_SPILL_BYTES_PER_STREAM;
	const maxSpillBytesPerSession =
		options.maxSpillBytesPerSession ?? MAX_SPILL_BYTES_PER_SESSION;
	const entries = new Map<string, Entry>();
	const killInterest = new Map<string, number>();
	const listeners = new Set<() => void>();
	const idListeners = new Map<string, Set<() => void>>();
	let counter = 0;
	let disposed = false;
	let spillDir: string | undefined | null;
	let spillBytes = 0;
	const posixGroups = new Set<number>();
	let onSettled:
		| ((snap: TerminalSnapshot, killPending: boolean) => void)
		| undefined;

	const notify = (id?: string) => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// UI listeners must not affect process lifecycle.
			}
		}
		if (id) {
			for (const listener of [...(idListeners.get(id) ?? [])]) {
				try {
					listener();
				} catch {
					// Same.
				}
			}
		}
	};

	const resolveSpillDir = () => {
		if (spillDir !== undefined) return spillDir ?? undefined;
		try {
			const base = path.join(os.tmpdir(), "pi-background-terminals");
			fs.mkdirSync(base, { recursive: true, mode: 0o700 });
			fs.chmodSync(base, 0o700);
			spillDir = fs.mkdtempSync(path.join(base, "session-"));
			fs.chmodSync(spillDir, 0o700);
		} catch {
			spillDir = null;
		}
		return spillDir ?? undefined;
	};

	const makeSpill = (
		entry: () => Entry | undefined,
		id: string,
		stream: "stdout" | "stderr",
		resumeSource: () => void,
	) => {
		const dir = resolveSpillDir();
		if (!dir) return undefined;
		const spillPath = path.join(dir, `${id}.${stream}.log`);
		try {
			const file = fs.createWriteStream(spillPath, {
				flags: "a",
				mode: 0o600,
			});
			const state: SpillState = { file, path: spillPath, bytes: 0 };
			let broken = false;
			let capped = false;
			file.on("error", (error) => {
				broken = true;
				resumeSource();
				const current = entry();
				if (
					!current ||
					current.outputFrozen ||
					current.snapshot.status !== "running"
				)
					return;
				const buffer =
					stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
				buffer.spillPath = undefined;
				appendError(
					current.snapshot,
					`Full-log spill failed: ${boundedError(error)}`,
				);
			});
			return {
				state,
				spillPath,
				write(chunk: string) {
					if (broken || capped || file.writableEnded) return true;
					const bytes = Buffer.byteLength(chunk, "utf8");
					const streamLimitReached =
						state.bytes + bytes > maxSpillBytesPerStream;
					const sessionLimitReached =
						spillBytes + bytes > maxSpillBytesPerSession;
					if (streamLimitReached || sessionLimitReached) {
						capped = true;
						const current = entry();
						if (
							current &&
							!current.outputFrozen &&
							current.snapshot.status === "running"
						) {
							const buffer =
								stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
							buffer.spillPath = undefined;
							appendError(
								current.snapshot,
								streamLimitReached
									? `${stream} full-log spill reached its ${maxSpillBytesPerStream}-byte safety limit`
									: `Session full-log spills reached their ${maxSpillBytesPerSession}-byte aggregate safety limit`,
							);
						}
						return true;
					}
					state.bytes += bytes;
					spillBytes += bytes;
					const accepted = file.write(chunk);
					if (!accepted) file.once("drain", resumeSource);
					return accepted;
				},
			};
		} catch {
			return undefined;
		}
	};

	const flushSpills = async (entry: Entry) => {
		const streams = entry.spills.map((spill) => spill.file);
		const flush = Promise.all(
			streams.map(
				(stream) =>
					new Promise<void>((resolve) => {
						if (stream.writableEnded || stream.destroyed) {
							resolve();
							return;
						}
						try {
							stream.end(resolve);
						} catch {
							resolve();
						}
					}),
			),
		);
		let timedOut = true;
		await Promise.race([
			flush.then(() => {
				timedOut = false;
			}),
			delay(SPILL_FLUSH_TIMEOUT_MS),
		]);
		if (timedOut) {
			for (const stream of streams) {
				if (!stream.destroyed) stream.destroy();
			}
			entry.stdoutBuf.spillPath = undefined;
			entry.stderrBuf.spillPath = undefined;
			appendError(entry.snapshot, "Full-log spill flush timed out");
		}
	};

	const deleteSpills = (entry: Entry) => {
		for (const spill of entry.spills) {
			if (!spill.file.destroyed) spill.file.destroy();
			try {
				fs.rmSync(spill.path, { force: true });
			} catch {
				// Private temporary output cleanup is best effort.
			}
			spillBytes = Math.max(0, spillBytes - spill.bytes);
			spill.bytes = 0;
		}
		entry.stdoutBuf.spillPath = undefined;
		entry.stderrBuf.spillPath = undefined;
	};

	const cleanupEntryResources = (entry: Entry) => {
		if (entry.exitCleanupTimer) clearTimeout(entry.exitCleanupTimer);
		entry.exitCleanupTimer = undefined;
		if (entry.retentionTimer) clearTimeout(entry.retentionTimer);
		entry.retentionTimer = undefined;
		if (entry.stdoutData) entry.child.stdout?.off("data", entry.stdoutData);
		if (entry.stderrData) entry.child.stderr?.off("data", entry.stderrData);
		entry.stdoutData = undefined;
		entry.stderrData = undefined;
		entry.child.removeAllListeners();
		deleteSpills(entry);
	};

	const removeSettledEntry = (entry: Entry) => {
		const id = entry.snapshot.id;
		if (entries.get(id) !== entry || entry.snapshot.status === "running")
			return;
		entries.delete(id);
		cleanupEntryResources(entry);
		// Global subscribers include every open /ps inspector. Notify after the
		// removal so id-based selection can reconcile without jumping needlessly.
		notify(id);
		idListeners.delete(id);
	};

	const scheduleRetentionExpiry = (entry: Entry) => {
		const settledAt = entry.snapshot.settledAt;
		if (settledAt === undefined) return;
		const expire = () => {
			const remaining = settledAt + settledRetentionMs - Date.now();
			if (remaining > 0) {
				entry.retentionTimer = setTimeout(expire, remaining);
				entry.retentionTimer.unref?.();
				return;
			}
			entry.retentionTimer = undefined;
			removeSettledEntry(entry);
		};
		entry.retentionTimer = setTimeout(
			expire,
			Math.max(0, settledAt + settledRetentionMs - Date.now()),
		);
		entry.retentionTimer.unref?.();
	};

	const settle = (entry: Entry) => {
		const snapshot = entry.snapshot;
		if (snapshot.status !== "running") return;
		snapshot.settledAt = Date.now();
		snapshot.status = entry.killSignaled
			? "killed"
			: entry.processErrored
				? "failed"
				: snapshot.exitCode === 0
					? "done"
					: "failed";
		const killPending = (killInterest.get(snapshot.id) ?? 0) > 0;
		const detached = detachTerminalSnapshot(snapshot);
		entry.outputFrozen = true;
		if (entry.stdoutData) entry.child.stdout?.off("data", entry.stdoutData);
		if (entry.stderrData) entry.child.stderr?.off("data", entry.stderrData);
		entry.stdoutData = undefined;
		entry.stderrData = undefined;
		entry.settled.resolve();
		scheduleRetentionExpiry(entry);
		notify(snapshot.id);
		try {
			if (!disposed) onSettled?.(detached, killPending);
		} catch {
			// A delivery hook cannot undo process settlement.
		}
	};

	const settleAfterFlush = (entry: Entry) => {
		if (entry.snapshot.status !== "running") return entry.settled.promise;
		entry.settling ??= flushSpills(entry).then(() => settle(entry));
		return entry.settling;
	};

	const forceSettlement = (entry: Entry) => {
		if (entry.snapshot.status !== "running") return entry.settled.promise;
		entry.settling ??= (async () => {
			entry.outputFrozen = true;
			if (entry.stdoutData) entry.child.stdout?.off("data", entry.stdoutData);
			if (entry.stderrData) entry.child.stderr?.off("data", entry.stderrData);
			entry.stdoutData = undefined;
			entry.stderrData = undefined;
			entry.child.stdout?.pause();
			entry.child.stderr?.pause();
			// A stream that never closed cannot have a complete spill. Keep its
			// partial retained tail, but never advertise the partial file as full.
			entry.stdoutBuf.spillPath = undefined;
			entry.stderrBuf.spillPath = undefined;
			await flushSpills(entry);
			settle(entry);
		})();
		return entry.settling;
	};

	const reapPosixGroup = async (pid: number) => {
		if (process.platform === "win32") return;
		if (!posixGroupExists(pid)) {
			posixGroups.delete(pid);
			return;
		}
		signalPosixGroup(pid, "SIGTERM");
		if (!(await waitForPosixGroupExit(pid, FORCE_KILL_AFTER_MS))) {
			signalPosixGroup(pid, "SIGKILL");
			await waitForPosixGroupExit(pid, FINAL_KILL_WAIT_MS);
		}
		if (!posixGroupExists(pid)) posixGroups.delete(pid);
	};

	const terminateEntry = (entry: Entry) => {
		entry.termination ??= (async () => {
			if (!entry.stdioClosed) {
				entry.killSignaled ||=
					!entry.exited && entry.snapshot.status === "running";
				killTree(entry.child, "SIGTERM");
				await boundedWait(waitForClose(entry), FORCE_KILL_AFTER_MS);
			}
			if (!entry.stdioClosed) {
				killTree(entry.child, "SIGKILL");
				await boundedWait(waitForClose(entry), FINAL_KILL_WAIT_MS);
			}
			if (entry.snapshot.status === "running") {
				await boundedWait(entry.settled.promise, SETTLE_GRACE_MS);
			}
			if (entry.snapshot.status === "running") {
				if (!entry.stdioClosed) {
					appendError(
						entry.snapshot,
						"stdio did not close after termination; output may be incomplete",
					);
				}
				await forceSettlement(entry);
			}
		})();
		return entry.termination;
	};

	const addKillInterest = (ids: readonly string[]) => {
		for (const id of ids) {
			killInterest.set(id, (killInterest.get(id) ?? 0) + 1);
		}
	};
	const releaseKillInterest = (ids: readonly string[]) => {
		for (const id of ids) {
			const count = (killInterest.get(id) ?? 1) - 1;
			if (count <= 0) killInterest.delete(id);
			else killInterest.set(id, count);
		}
	};

	const start = async (options: StartOptions) => {
		if (disposed) {
			throw new SpawnError("Background terminal manager is shutting down.");
		}
		const running = [...entries.values()].filter(
			(entry) => entry.snapshot.status === "running",
		).length;
		if (running >= MAX_RUNNING) {
			throw new ConcurrencyLimitError(
				`Max ${MAX_RUNNING} background terminals can run concurrently. Stop one with bg_kill before starting another.`,
			);
		}
		if (entries.size >= maxTracked) {
			throw new ConcurrencyLimitError(
				`Max ${maxTracked} background terminals can be retained at once. Wait for a settled terminal's five-minute retention to expire.`,
			);
		}

		const { shell, args } = shellInvocation(options.command);
		let child: ChildProcess;
		try {
			child = spawn(shell, args, {
				cwd: options.cwd,
				env: backgroundProcessEnvironment(),
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch (error) {
			throw new SpawnError(boundedError(error));
		}

		const id = `bt-${++counter}`;
		const entryRef = () => entries.get(id);
		const stdoutSpill = makeSpill(entryRef, id, "stdout", () =>
			child.stdout?.resume(),
		);
		const stderrSpill = makeSpill(entryRef, id, "stderr", () =>
			child.stderr?.resume(),
		);
		const stdoutBuf = new OutputBuffer(retainedPerStream, stdoutSpill?.write);
		const stderrBuf = new OutputBuffer(retainedPerStream, stderrSpill?.write);
		stdoutBuf.spillPath = stdoutSpill?.spillPath;
		stderrBuf.spillPath = stderrSpill?.spillPath;
		const snapshot: MutableSnapshot = {
			id,
			command: options.command,
			title: options.title,
			cwd: options.cwd,
			pid: child.pid,
			status: "running",
			createdAt: Date.now(),
			get stdout() {
				return stdoutBuf.view();
			},
			get stderr() {
				return stderrBuf.view();
			},
		};
		const entry: Entry = {
			snapshot,
			child,
			stdoutBuf,
			stderrBuf,
			spills: [stdoutSpill?.state, stderrSpill?.state].filter(
				(spill): spill is SpillState => spill !== undefined,
			),
			settled: defer(),
			killSignaled: false,
			processErrored: false,
			exited: false,
			stdioClosed: false,
			outputFrozen: false,
		};
		entries.set(id, entry);
		if (process.platform !== "win32" && child.pid) posixGroups.add(child.pid);

		child.stdout?.setEncoding("utf8");
		entry.stdoutData = (chunk: string) => {
			if (entry.outputFrozen || snapshot.status !== "running") return;
			if (!stdoutBuf.push(chunk)) child.stdout?.pause();
			notify(id);
		};
		child.stdout?.on("data", entry.stdoutData);
		child.stderr?.setEncoding("utf8");
		entry.stderrData = (chunk: string) => {
			if (entry.outputFrozen || snapshot.status !== "running") return;
			if (!stderrBuf.push(chunk)) child.stderr?.pause();
			notify(id);
		};
		child.stderr?.on("data", entry.stderrData);
		child.once("error", (error) => {
			entry.exited = true;
			if (snapshot.status !== "running") return;
			entry.processErrored = true;
			appendError(snapshot, boundedError(error));
			void settleAfterFlush(entry);
		});
		child.once("exit", (code, signal) => {
			entry.exited = true;
			if (snapshot.status !== "running") return;
			snapshot.exitCode = code ?? undefined;
			snapshot.signal = signal ?? undefined;
			if (!entry.exitCleanupTimer) {
				entry.exitCleanupTimer = setTimeout(() => {
					entry.exitCleanupTimer = undefined;
					if (!entry.stdioClosed && snapshot.status === "running") {
						void terminateEntry(entry);
					}
				}, SETTLE_GRACE_MS);
				entry.exitCleanupTimer.unref?.();
			}
		});
		child.once("close", (code, signal) => {
			entry.exited = true;
			entry.stdioClosed = true;
			if (snapshot.status === "running") {
				if (!entry.processErrored) {
					snapshot.exitCode ??= code ?? undefined;
					snapshot.signal ??= signal ?? undefined;
				}
				void settleAfterFlush(entry);
			}
			// A shell can exit after spawning descendants whose stdio was redirected.
			// `close` then says nothing about the detached POSIX process group, so reap
			// it independently. Windows has no equivalent without a Job Object.
			if (child.pid) void reapPosixGroup(child.pid);
		});

		if (disposed) {
			await terminateEntry(entry);
			throw new SpawnError(
				"Background terminal manager shut down while starting.",
			);
		}
		notify(id);
		return detachTerminalSnapshot(snapshot);
	};

	const requireEntries = (ids: ReadonlyArray<string>) => {
		const unique = [...new Set(ids)];
		const unknown = unique.filter((id) => !entries.has(id));
		if (unknown.length > 0) {
			throw new UnknownTerminalError(
				`Unknown terminal id(s): ${unknown.map(sanitizeTerminalLine).join(", ")}. Known: ${[...entries.keys()].map(sanitizeTerminalLine).join(", ") || "none"}.`,
			);
		}
		return unique.map((id) => entries.get(id) as Entry);
	};

	const status = async (id: string) =>
		detachTerminalSnapshot(requireEntries([id])[0].snapshot);

	const kill = async (ids: ReadonlyArray<string>) => {
		const selected = requireEntries(ids);
		const running = selected.filter(
			(entry) => entry.snapshot.status === "running",
		);
		const runningIds = running.map((entry) => entry.snapshot.id);
		addKillInterest(runningIds);
		try {
			const terminations = running.map((entry) => terminateEntry(entry));
			await Promise.all(running.map((entry) => entry.settled.promise));
			await Promise.all(terminations);
			return selected.map((entry): KillResult => {
				const wasRunning = runningIds.includes(entry.snapshot.id);
				return {
					id: entry.snapshot.id,
					title: entry.snapshot.title,
					status: entry.snapshot.status,
					wasRunning,
					killed: wasRunning && entry.snapshot.status === "killed",
					exit: formatExit(entry.snapshot),
				};
			});
		} finally {
			releaseKillInterest(runningIds);
		}
	};

	const disposeAll = async () => {
		if (disposed) return;
		disposed = true;
		const all = [...entries.values()];
		await Promise.all(all.map((entry) => terminateEntry(entry)));
		// Repeat the POSIX group sweep at session disposal. This covers shells
		// that closed earlier while descendants kept redirected stdio and resisted
		// the close-time TERM. On Windows, taskkill is best effort while the root
		// exists; robust post-root reaping requires Job Objects, which Pi does not
		// currently provide.
		await Promise.all([...posixGroups].map((pid) => reapPosixGroup(pid)));
		for (const entry of all) cleanupEntryResources(entry);
		entries.clear();
		posixGroups.clear();
		idListeners.clear();
		const dir = spillDir;
		spillDir = null;
		if (dir) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Private temp output is best-effort cleanup.
			}
		}
		notify();
		listeners.clear();
	};

	const view: TerminalReadModel = {
		list: () =>
			[...entries.values()].map((entry) =>
				detachTerminalSnapshot(entry.snapshot),
			),
		get: (id) => {
			const entry = entries.get(id);
			return entry ? detachTerminalSnapshot(entry.snapshot) : undefined;
		},
		size: () => entries.size,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		subscribeTo: (id, listener) => {
			let set = idListeners.get(id);
			if (!set) {
				set = new Set();
				idListeners.set(id, set);
			}
			set.add(listener);
			return () => {
				set.delete(listener);
				if (set.size === 0) idListeners.delete(id);
			};
		},
		requestKill: (id) => {
			const entry = entries.get(id);
			if (entry) void terminateEntry(entry);
		},
		setOnSettled: (hook) => {
			onSettled = hook;
		},
	};

	return { start, status, kill, list: view.list, disposeAll, view };
}
