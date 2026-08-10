/**
 * Background terminals — start long-running shell processes the model can
 * inspect and stop, but never write to (stdin is ignored at the OS level).
 *
 * Tools (for the LLM):
 * - bg_start: fire-and-forget spawn (command, title, working_dir). Max 8
 *   running at once. The model is notified exactly once when a process exits.
 * - bg_status: peek at one terminal's status + tail-truncated output.
 * - bg_list: list all tracked terminals (running and settled).
 * - bg_kill: SIGTERM→SIGKILL the whole process tree; returns final state.
 *
 * While ≥1 process runs, a selectable footer status shows the running count
 * and `/ps`. `/ps` opens one read-only, two-pane terminal inspector.
 *
 * Architecture: a plain TypeScript session runtime owns one process manager;
 * this file is the Pi API boundary. Node stream plumbing is callback-driven.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TerminalSnapshot } from "./domain.ts";
import type { TerminalManager } from "./manager.ts";
import {
	BG_KILL_PARAMETER_DESCRIPTIONS,
	BG_KILL_TOOL_DESCRIPTION,
	BG_LIST_TOOL_DESCRIPTION,
	BG_START_PARAMETER_DESCRIPTIONS,
	BG_START_PROMPT_GUIDELINES,
	BG_START_PROMPT_SNIPPET,
	BG_START_TOOL_DESCRIPTION,
	BG_STATUS_PARAMETER_DESCRIPTIONS,
	BG_STATUS_TOOL_DESCRIPTION,
	buildKillReport,
	buildStartResult,
	buildStatusResult,
	buildTerminalResultMessage,
	describeTerminal,
} from "./prompt.ts";
import { createDeferredResultDelivery } from "./result-delivery.ts";
import { renderTerminalResultMessage } from "./result-renderer.ts";
import {
	createTerminalRuntime,
	runTool,
	type TerminalRuntime,
} from "./runtime.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./terminal-text.ts";
import { openTerminalInspector } from "./ui/ps.ts";
import {
	UI_CUSTOMIZATION_STATUS_ACTIVATION_EVENT,
	UI_CUSTOMIZATION_STATUS_OPTIONS_EVENT,
	type UIStatusActivationEvent,
	type UIStatusOptionsEvent,
} from "./ui-customization.ts";

export {
	renderTerminalResultMessage,
	type TerminalResultDetails,
} from "./result-renderer.ts";
export {
	UI_CUSTOMIZATION_STATUS_ACTIVATION_EVENT,
	UI_CUSTOMIZATION_STATUS_OPTIONS_EVENT,
	type UIStatusActivationEvent,
	type UIStatusOptionsEvent,
} from "./ui-customization.ts";

const STATUS_KEY = "background-terminals";

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Literal tool-result renderer shared by all four tools. Tool result builders
 * already sanitize at the API boundary; the idempotent pass here protects
 * extension calls that provide synthetic or stale result objects. */
function renderLiteralToolResult(
	result: { content: ReadonlyArray<{ type: string; text?: string }> },
	_options: unknown,
	theme: Theme,
) {
	const text = result.content
		.filter(
			(item): item is { type: string; text: string } =>
				item.type === "text" && typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");
	return new Text(theme.fg("toolOutput", sanitizeTerminalText(text)), 0, 0);
}

function renderToolCall(theme: Theme, label: string, summary = "") {
	const title = theme.fg("toolTitle", theme.bold(label));
	return new Text(
		summary
			? `${title} ${theme.fg("accent", sanitizeTerminalLine(summary))}`
			: title,
		0,
		0,
	);
}

export default function (pi: ExtensionAPI) {
	let runtime: TerminalRuntime | undefined;
	let managerPromise: Promise<TerminalManager> | undefined;
	let sessionContext: ExtensionContext | undefined;
	let sessionAbort: AbortController | undefined;
	let ui: ExtensionUIContext | undefined;
	let unsubStatus: (() => void) | undefined;
	let unsubActivation: (() => void) | undefined;
	const resultDelivery = createDeferredResultDelivery<TerminalSnapshot>();

	const getRuntime = () => (runtime ??= createTerminalRuntime());

	/** Resolve the manager service once per runtime and wire the extension hooks. */
	const getManager = () => {
		managerPromise ??= Promise.resolve(getRuntime().manager).then((manager) => {
			manager.view.setOnSettled(onSettled);
			unsubStatus?.();
			unsubStatus = manager.view.subscribe(() => updateStatus(manager));
			updateStatus(manager);
			return manager;
		});
		return managerPromise;
	};

	/** One-line footer status, only while ≥1 terminal is running. Called on
	 * every manager notification (including per-output-chunk), so it updates
	 * Pi's status registry only when the visible running count changes. */
	let statusRunning = 0;
	const updateStatus = (manager: TerminalManager) => {
		if (!ui) return;
		try {
			const running = manager.view
				.list()
				.filter((snap) => snap.status === "running").length;
			if (running === statusRunning) return;
			statusRunning = running;
			if (running === 0) {
				ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const line = ui.theme.fg(
				"accent",
				`■ ${running} background terminal${running === 1 ? "" : "s"} running · /ps`,
			);
			ui.setStatus(STATUS_KEY, line);
		} catch {
			// UI may be unavailable (print/RPC modes or teardown).
		}
	};

	const deliverResult = (snap: TerminalSnapshot) => {
		try {
			pi.sendMessage(
				{
					customType: "background-terminal-result",
					content: buildTerminalResultMessage(snap),
					display: true,
					details: {
						id: sanitizeTerminalLine(snap.id),
						title: sanitizeTerminalLine(snap.title),
						status: snap.status,
						exitCode: snap.exitCode,
						signal: snap.signal ? sanitizeTerminalLine(snap.signal) : undefined,
					},
				},
				// followUp: queued until the agent has no more tool calls — never
				// interrupts a mid-turn stream. triggerTurn: wakes the model
				// immediately iff idle; if busy, the queued follow-up is delivered
				// when the current run settles. Either way exactly one delivery.
				{ deliverAs: "followUp", triggerTurn: true },
			);
			return true;
		} catch (error) {
			// Session may be shutting down, but retain the snapshot so any later
			// agent-settled flush can retry instead of silently dropping it.
			console.error("background-terminals: failed to deliver result", error);
			return false;
		}
	};

	const flushResults = () => {
		for (const snap of resultDelivery.drain()) {
			if (!deliverResult(snap)) resultDelivery.defer(snap);
		}
	};

	const onSettled = (snap: TerminalSnapshot, killPending: boolean) => {
		// Always retain the automatic delivery until the bg_kill tool has
		// successfully returned. An aborted tool wait must not consume a process
		// settlement even though its termination continues in the background.
		resultDelivery.defer({
			...snap,
			stdout: { ...snap.stdout },
			stderr: { ...snap.stderr },
		});
		// Held kill results are skipped by drains while the tool still has the
		// opportunity to return this exact settlement itself.
		if (!killPending && sessionContext?.isIdle()) flushResults();
	};

	const openPs = async (ctx: ExtensionContext) => {
		const manager = await getManager();
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) {
				const terminals = manager.view.list();
				ctx.ui.notify(
					terminals.length === 0
						? "No background terminals."
						: terminals.map((snap) => describeTerminal(snap)).join("\n"),
					"info",
				);
			}
			return;
		}
		if (manager.view.size() === 0) {
			ctx.ui.notify(
				"No background terminals yet. The agent starts them with bg_start.",
				"info",
			);
			return;
		}
		await openTerminalInspector(ctx, manager.view, sessionAbort?.signal);
	};

	pi.on("session_start", (_event, ctx) => {
		const statusOptions: UIStatusOptionsEvent = {
			key: STATUS_KEY,
			preserveSelectedColors: true,
		};
		pi.events.emit(UI_CUSTOMIZATION_STATUS_OPTIONS_EVENT, statusOptions);
		sessionAbort?.abort();
		sessionAbort = new AbortController();
		sessionContext = ctx;
		if (ctx.hasUI) ui = ctx.ui;
		unsubActivation?.();
		unsubActivation = pi.events.on(
			UI_CUSTOMIZATION_STATUS_ACTIVATION_EVENT,
			(data) => {
				const activation = data as Partial<UIStatusActivationEvent>;
				if (
					activation.key !== STATUS_KEY ||
					activation.sessionId !== ctx.sessionManager.getSessionId()
				)
					return;
				void openPs(ctx).catch((error) =>
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"error",
					),
				);
			},
		);
	});

	// Drain deferred results when the agent settles: together with the
	// isIdle() fast path above and the Map-keyed delivery (drain clears),
	// double delivery is structurally impossible — whoever drains first wins.
	pi.on("agent_settled", flushResults);

	// /new, /resume, /fork, /reload, and quit all emit session_shutdown for
	// the old extension instance. Processes never survive a session
	// transition: disposing the runtime runs the manager finalizer →
	// disposeAll → every entry scope → SIGTERM→SIGKILL tree kill, each close
	// bounded so a wedged process cannot hang shutdown.
	pi.on("session_shutdown", async () => {
		sessionContext = undefined;
		sessionAbort?.abort();
		sessionAbort = undefined;
		resultDelivery.clear();
		unsubStatus?.();
		unsubStatus = undefined;
		unsubActivation?.();
		unsubActivation = undefined;
		try {
			ui?.setStatus(STATUS_KEY, undefined);
		} catch {
			// UI may already be gone.
		}
		statusRunning = 0;
		ui = undefined;
		const closing = runtime;
		runtime = undefined;
		managerPromise = undefined;
		await closing?.dispose();
	});

	// --- Tools -------------------------------------------------------------

	pi.registerTool({
		name: "bg_start",
		label: "Start Background Terminal",
		description: BG_START_TOOL_DESCRIPTION,
		promptSnippet: BG_START_PROMPT_SNIPPET,
		promptGuidelines: BG_START_PROMPT_GUIDELINES,
		parameters: Type.Object(
			{
				command: Type.String({
					description: BG_START_PARAMETER_DESCRIPTIONS.command,
					minLength: 1,
				}),
				title: Type.String({
					description: BG_START_PARAMETER_DESCRIPTIONS.title,
					minLength: 1,
				}),
				working_dir: Type.Optional(
					Type.String({
						description: BG_START_PARAMETER_DESCRIPTIONS.workingDir,
					}),
				),
			},
			{ additionalProperties: false },
		),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall(args, theme) {
			const title = stringValue(args.title) || "terminal";
			const command = stringValue(args.command);
			const cwd = stringValue(args.working_dir);
			const summary = `"${title}"${command ? ` · ${command}` : ""}${cwd ? ` · ${cwd}` : ""}`;
			return renderToolCall(theme, "bg_start", summary);
		},
		renderResult: renderLiteralToolResult,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const manager = await getManager();

			const command = params.command.trim();
			if (!command) throw new Error("command must not be empty.");

			const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
			let isDirectory = false;
			try {
				isDirectory = fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
			} catch {
				// Report only the literal path below; native fs errors may echo it raw.
			}
			if (!isDirectory) {
				throw new Error(
					`working_dir is not a directory: ${sanitizeTerminalLine(cwd)}`,
				);
			}

			const title =
				sanitizeTerminalLine(params.title).slice(0, 80) || "terminal";
			const snap = await runTool(
				getRuntime(),
				manager.start({ command, title, cwd }),
			);

			return {
				content: [{ type: "text", text: buildStartResult(snap) }],
				details: {
					id: sanitizeTerminalLine(snap.id),
					title: sanitizeTerminalLine(snap.title),
					cwd: sanitizeTerminalLine(cwd),
					pid: snap.pid,
				},
			};
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Check Background Terminal",
		description: BG_STATUS_TOOL_DESCRIPTION,
		parameters: Type.Object(
			{
				id: Type.String({
					description: BG_STATUS_PARAMETER_DESCRIPTIONS.id,
					minLength: 1,
				}),
			},
			{ additionalProperties: false },
		),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall: (args, theme) =>
			renderToolCall(theme, "bg_status", stringValue(args.id)),
		renderResult: renderLiteralToolResult,
		async execute(_toolCallId, params) {
			const manager = await getManager();
			const snap = manager.view.get(params.id);
			if (!snap) {
				const known = manager.view.list().map((s) => s.id);
				throw new Error(
					`Unknown terminal id "${sanitizeTerminalLine(params.id)}". Known: ${known.map(sanitizeTerminalLine).join(", ") || "none"}.`,
				);
			}

			// This status is returning the settlement itself; a pending automatic
			// follow-up for the same settle would be a duplicate.
			if (snap.status !== "running") resultDelivery.consume([snap.id]);

			return {
				content: [{ type: "text", text: buildStatusResult(snap) }],
				details: {
					id: sanitizeTerminalLine(snap.id),
					status: snap.status,
					pid: snap.pid,
					exitCode: snap.exitCode,
					signal: snap.signal ? sanitizeTerminalLine(snap.signal) : undefined,
				},
			};
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "List Background Terminals",
		description: BG_LIST_TOOL_DESCRIPTION,
		parameters: Type.Object({}, { additionalProperties: false }),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall: (_args, theme) => renderToolCall(theme, "bg_list"),
		renderResult: renderLiteralToolResult,
		async execute() {
			const manager = await getManager();
			const terminals = manager.view.list();
			const text =
				terminals.length === 0
					? "No background terminals."
					: terminals.map((snap) => describeTerminal(snap)).join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					terminals: terminals.map((snap) => ({
						id: sanitizeTerminalLine(snap.id),
						title: sanitizeTerminalLine(snap.title),
						status: snap.status,
						pid: snap.pid,
					})),
				},
			};
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Kill Background Terminals",
		description: BG_KILL_TOOL_DESCRIPTION,
		parameters: Type.Object(
			{
				ids: Type.Array(Type.String({ minLength: 1 }), {
					description: BG_KILL_PARAMETER_DESCRIPTIONS.ids,
					minItems: 1,
				}),
			},
			{ additionalProperties: false },
		),
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderCall(args, theme) {
			const ids = Array.isArray(args.ids)
				? args.ids.map(stringValue).filter(Boolean).join(", ")
				: "";
			return renderToolCall(theme, "bg_kill", ids);
		},
		renderResult: renderLiteralToolResult,
		async execute(_toolCallId, params, signal) {
			const manager = await getManager();
			const ids = [...new Set(params.ids)];
			if (ids.length === 0)
				throw new Error("Provide at least one terminal id.");

			const known = manager.view.list().map((snap) => snap.id);
			const unknown = ids.filter((id) => !manager.view.get(id));
			if (unknown.length > 0) {
				throw new Error(
					`Unknown terminal id(s): ${unknown.map(sanitizeTerminalLine).join(", ")}. Known: ${known.map(sanitizeTerminalLine).join(", ") || "none"}.`,
				);
			}

			const releaseDelivery = resultDelivery.hold(ids);
			const operation = manager.kill(ids);
			let report: Awaited<typeof operation>;
			try {
				report = await runTool(getRuntime(), operation, {
					signal,
					interruptMessage:
						"Kill wait aborted; termination continues in the background.",
				});
			} catch (error) {
				// The manager operation is intentionally uncancelled. Release the hold
				// without consuming anything, then flush when termination finishes; this
				// also covers agent_settled racing ahead of process termination.
				releaseDelivery(false);
				void operation.then(flushResults, flushResults);
				throw error;
			}

			// Only a successfully returning tool consumes automatic delivery.
			releaseDelivery(true);

			return {
				content: [{ type: "text", text: buildKillReport(report) }],
				details: {
					results: report.map((entry) => ({
						id: sanitizeTerminalLine(entry.id),
						title: sanitizeTerminalLine(entry.title),
						status: entry.status,
						killed: entry.killed,
					})),
				},
			};
		},
	});

	// --- Result message rendering ------------------------------------------

	pi.registerMessageRenderer(
		"background-terminal-result",
		renderTerminalResultMessage,
	);

	// --- Command ------------------------------------------------------------

	pi.registerCommand("ps", {
		description: "List and inspect background terminals",
		handler: async (_args, ctx) => openPs(ctx),
	});
}
