import { createTerminalManager, type TerminalManager } from "./manager.ts";

/** Small session runtime: one plain TypeScript manager plus bounded disposal. */
export interface TerminalRuntime {
	readonly manager: TerminalManager;
	dispose(): Promise<void>;
}

export function createTerminalRuntime(): TerminalRuntime {
	const manager = createTerminalManager();
	return {
		manager,
		dispose: () => manager.disposeAll(),
	};
}

/**
 * Await already-started work while allowing a tool caller to stop waiting.
 * The underlying operation is deliberately not cancelled (notably, a kill
 * continues its SIGTERM/SIGKILL escalation after the tool wait is aborted).
 */
export async function runTool<A>(
	operation: Promise<A>,
	options: { signal?: AbortSignal; interruptMessage?: string } = {},
) {
	const { signal } = options;
	if (!signal) return operation;
	if (signal.aborted) {
		throw new Error(options.interruptMessage ?? "Operation was aborted.");
	}
	let removeAbort = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		const onAbort = () =>
			reject(new Error(options.interruptMessage ?? "Operation was aborted."));
		signal.addEventListener("abort", onAbort, { once: true });
		removeAbort = () => signal.removeEventListener("abort", onAbort);
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		removeAbort();
	}
}
