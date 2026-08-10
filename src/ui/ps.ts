/**
 * /ps UI — one read-only, two-pane inspector over TerminalReadModel.
 * Arrows select terminals while j/k scroll the selected stdout/stderr tail.
 * Background terminals have no stdin by design.
 */

import type {
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatElapsed, formatExit, type TerminalSnapshot } from "../domain.ts";
import type { TerminalReadModel } from "../manager.ts";
import { createOutputLineCache, sanitizeText } from "./output-view.ts";

/** Keep model/process-provided text inside one fixed-height UI row. */
function oneLine(text: string): string {
	return sanitizeText(text.replace(/\s+/g, " "));
}

const KEY_NAMES: Readonly<Record<string, string>> = {
	escape: "Esc",
	enter: "Enter",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	pageup: "PageUp",
	pagedown: "PageDown",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	home: "Home",
	end: "End",
	space: "Space",
};

function keyLabel(key: string): string {
	return key
		.split("+")
		.map((part, index, parts) => {
			const lower = part.toLowerCase();
			if (lower === "ctrl") return "Ctrl";
			if (lower === "alt") return "Alt";
			if (lower === "shift") return "Shift";
			const named = KEY_NAMES[lower];
			if (named) return named;
			if (part.length === 1)
				return parts.length > 1 && index === parts.length - 1
					? part.toUpperCase()
					: part;
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join("+");
}

function configuredKeys(
	keybindings: KeybindingsManager,
	binding: Parameters<KeybindingsManager["getKeys"]>[0],
): string[] {
	return keybindings.getKeys(binding).map(keyLabel);
}

function configuredKeyGroup(
	keybindings: KeybindingsManager,
	bindings: Array<Parameters<KeybindingsManager["getKeys"]>[0]>,
	extra: string[] = [],
): string {
	const keys = bindings.flatMap((binding) =>
		configuredKeys(keybindings, binding),
	);
	return [...new Set([...keys, ...extra])].join("/") || "Unbound";
}

function statusColor(
	status: TerminalSnapshot["status"],
): Parameters<Theme["fg"]>[0] {
	switch (status) {
		case "running":
			return "warning";
		case "done":
			return "success";
		case "failed":
			return "error";
		case "killed":
			return "muted";
	}
}

function statusGlyph(snap: TerminalSnapshot, theme: Theme): string {
	return theme.fg(statusColor(snap.status), "■");
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function splitColumns(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width, "");
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;
	const rightWidth = Math.min(
		visibleWidth(right),
		Math.max(1, Math.floor(width * 0.45)),
	);
	const fittedRight = truncateToWidth(right, rightWidth, "");
	const fittedLeft = truncateToWidth(
		left,
		Math.max(0, width - visibleWidth(fittedRight) - 1),
		"…",
	);
	return fit(`${fittedLeft} ${fittedRight}`, width);
}

function panel(
	theme: Theme,
	title: string,
	rows: string[],
	width: number,
	height: number,
	focused = false,
): string[] {
	const inner = Math.max(0, width - 2);
	const borderColor = focused ? "borderAccent" : "borderMuted";
	const border = (text: string) => theme.fg(borderColor, text);
	const titleText = truncateToWidth(` ${title} `, Math.max(0, inner - 2), "");
	const topFill = Math.max(0, inner - visibleWidth(titleText) - 1);
	const lines = [
		`${border("╭─")}${theme.fg(focused ? "accent" : "muted", theme.bold(titleText))}${border(`${"─".repeat(topFill)}╮`)}`,
	];
	for (let index = 0; index < Math.max(0, height - 2); index++)
		lines.push(`${border("│")}${fit(rows[index] ?? "", inner)}${border("│")}`);
	lines.push(border(`╰${"─".repeat(inner)}╯`));
	return lines.map((line) => truncateToWidth(line, width, ""));
}

export function inspectorOverlayMaxHeight(terminalRows: number): number {
	// Keep in sync with /ps overlayOptions (90% max height, one-row margin).
	return Math.max(
		1,
		Math.min(Math.floor(terminalRows * 0.9), Math.max(1, terminalRows - 2)),
	);
}

export interface InspectorSelection {
	id?: string;
	index: number;
}

export function reconcileInspectorSelection(
	selection: InspectorSelection,
	terminals: ReadonlyArray<Pick<TerminalSnapshot, "id">>,
): void {
	const stableIndex = selection.id
		? terminals.findIndex((snap) => snap.id === selection.id)
		: -1;
	selection.index =
		stableIndex >= 0
			? stableIndex
			: Math.min(
					Math.max(0, selection.index),
					Math.max(0, terminals.length - 1),
				);
	selection.id = terminals[selection.index]?.id;
}

interface InspectorOverlayState {
	handle?: OverlayHandle;
	close?: () => void;
}

const activeInspectors = new WeakMap<
	TerminalReadModel,
	InspectorOverlayState
>();

export function closeTerminalInspector(view: TerminalReadModel): void {
	activeInspectors.get(view)?.close?.();
}

export async function openTerminalInspector(
	ctx: ExtensionContext,
	view: TerminalReadModel,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	if (view.size() === 0) {
		ctx.ui.notify("No background terminals", "info");
		return;
	}
	const existing = activeInspectors.get(view);
	if (existing) {
		existing.handle?.focus();
		return;
	}
	const state: InspectorOverlayState = {};
	activeInspectors.set(view, state);
	try {
		await ctx.ui.custom<undefined>(
			(tui, theme, keybindings, done) => {
				let closed = false;
				const close = () => {
					if (closed) return;
					closed = true;
					state.close = undefined;
					if (activeInspectors.get(view) === state)
						activeInspectors.delete(view);
					done(undefined);
				};
				state.close = close;
				return new TerminalInspector(
					tui,
					theme,
					keybindings,
					view,
					close,
					signal,
				);
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "94%",
					minWidth: 60,
					maxHeight: "90%",
					margin: 1,
				},
				onHandle: (handle) => {
					state.handle = handle;
					handle.focus();
				},
			},
		);
	} finally {
		state.close = undefined;
		if (activeInspectors.get(view) === state) activeInspectors.delete(view);
	}
}

class TerminalInspector implements Component {
	private selection: InspectorSelection = { index: 0 };
	private stream: "stdout" | "stderr" = "stdout";
	/** Lines above the live tail; zero stays pinned to new output. */
	private scrollOffset = 0;
	private outputViewportRows = 1;
	private outputLayoutKey?: string;
	private outputLineCount = 0;
	private outputAnchor?: {
		key: string;
		lines: string[];
		index: number;
		version: number;
		available: number;
	};
	private lineCache = createOutputLineCache();
	private unsubscribe: () => void;
	private renderTimer?: ReturnType<typeof setTimeout>;
	private ticker: ReturnType<typeof setInterval>;
	private closed = false;
	private removeAbort = () => {};

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly view: TerminalReadModel,
		private readonly done: () => void,
		signal?: AbortSignal,
	) {
		this.reconcile();
		this.unsubscribe = view.subscribe(() => this.scheduleRender());
		this.ticker = setInterval(() => this.tui.requestRender(), 1000);
		this.ticker.unref?.();
		if (signal) {
			const onAbort = () => this.close();
			signal.addEventListener("abort", onAbort, { once: true });
			this.removeAbort = () => signal.removeEventListener("abort", onAbort);
			if (signal.aborted) this.close();
		}
	}

	private terminals(): ReadonlyArray<TerminalSnapshot> {
		return this.view.list();
	}

	private selected(terminals = this.terminals()): TerminalSnapshot | undefined {
		reconcileInspectorSelection(this.selection, terminals);
		return terminals[this.selection.index];
	}

	private resetOutput(): void {
		this.scrollOffset = 0;
		this.outputLayoutKey = undefined;
		this.outputLineCount = 0;
		this.outputAnchor = undefined;
		this.lineCache = createOutputLineCache();
	}

	private reconcile(): ReadonlyArray<TerminalSnapshot> {
		const terminals = this.terminals();
		const previousId = this.selection.id;
		reconcileInspectorSelection(this.selection, terminals);
		if (previousId && previousId !== this.selection.id) this.resetOutput();
		return terminals;
	}

	private select(
		index: number,
		terminals: ReadonlyArray<TerminalSnapshot>,
	): void {
		const next = Math.min(
			Math.max(0, index),
			Math.max(0, terminals.length - 1),
		);
		if (next === this.selection.index) return;
		this.selection.index = next;
		this.selection.id = terminals[next]?.id;
		this.resetOutput();
	}

	private scheduleRender(): void {
		if (this.renderTimer) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (!this.closed) this.tui.requestRender();
		}, 50);
		this.renderTimer.unref?.();
	}

	private cleanup(): boolean {
		if (this.closed) return false;
		this.closed = true;
		this.unsubscribe();
		this.removeAbort();
		clearInterval(this.ticker);
		if (this.renderTimer) clearTimeout(this.renderTimer);
		this.renderTimer = undefined;
		return true;
	}

	private close(): void {
		if (this.cleanup()) this.done();
	}

	dispose(): void {
		this.cleanup();
	}

	handleInput(data: string): void {
		const terminals = this.reconcile();
		if (
			this.keybindings.matches(data, "app.interrupt") ||
			this.keybindings.matches(data, "tui.select.cancel") ||
			data === "q"
		) {
			this.close();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up"))
			this.select(this.selection.index - 1, terminals);
		else if (this.keybindings.matches(data, "tui.select.down"))
			this.select(this.selection.index + 1, terminals);
		else if (data === "g") this.select(0, terminals);
		else if (data === "G") this.select(terminals.length - 1, terminals);
		else if (data === "k") this.scrollOffset += 1;
		else if (data === "j")
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		else if (this.keybindings.matches(data, "tui.editor.pageUp"))
			this.scrollOffset += this.outputViewportRows;
		else if (this.keybindings.matches(data, "tui.editor.pageDown"))
			this.scrollOffset = Math.max(
				0,
				this.scrollOffset - this.outputViewportRows,
			);
		else if (data === "t") {
			this.stream = this.stream === "stdout" ? "stderr" : "stdout";
			this.resetOutput();
		} else if (data === "x") {
			const snap = this.selected(terminals);
			if (snap?.status === "running") this.view.requestKill(snap.id);
		} else if (data !== "r") return;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 60)
			return [
				truncateToWidth(
					"Background terminals need at least 60 columns. Esc closes.",
					width,
				),
			];
		const terminals = this.reconcile();
		const terminalRows = this.tui.terminal?.rows ?? 30;
		const maxHeight = inspectorOverlayMaxHeight(terminalRows);
		if (maxHeight < 7)
			return [
				truncateToWidth("Terminal is too short for /ps. Esc closes.", width),
			];
		const panelHeight = Math.min(20, maxHeight - 2);
		const bodyHeight = panelHeight - 2;
		const leftWidth = Math.max(28, Math.floor(width * 0.38));
		const rightWidth = width - leftWidth - 1;
		const leftInner = leftWidth - 2;
		const rightInner = rightWidth - 2;
		const running = terminals.filter(
			(snap) => snap.status === "running",
		).length;
		const header = splitColumns(
			` ${this.theme.bold(this.theme.fg("accent", "Background terminals"))}`,
			this.theme.fg(
				"dim",
				`${running} running · ${terminals.length} tracked · current session `,
			),
			width,
		);
		const start = Math.max(
			0,
			Math.min(
				this.selection.index - bodyHeight + 1,
				Math.max(0, terminals.length - bodyHeight),
			),
		);
		const leftRows = terminals
			.slice(start, start + bodyHeight)
			.map((snap, offset) => {
				const index = start + offset;
				const selected = index === this.selection.index;
				const marker = selected ? this.theme.fg("accent", "❯") : " ";
				const title = selected
					? this.theme.fg("accent", oneLine(snap.title))
					: this.theme.fg("text", oneLine(snap.title));
				const left = `${marker} ${statusGlyph(snap, this.theme)} ${title}`;
				return splitColumns(left, this.theme.fg("dim", snap.status), leftInner);
			});
		const snap = terminals[this.selection.index];
		const rightRows = this.renderDetails(snap, rightInner, bodyHeight);
		const leftPanel = panel(
			this.theme,
			`Terminals · ${terminals.length}`,
			leftRows,
			leftWidth,
			panelHeight,
		);
		const rightPanel = panel(
			this.theme,
			snap ? `${oneLine(snap.title)} · ${this.stream}` : "Details",
			rightRows,
			rightWidth,
			panelHeight,
			true,
		);
		const lines = [header];
		for (let index = 0; index < panelHeight; index++)
			lines.push(`${leftPanel[index] ?? ""} ${rightPanel[index] ?? ""}`);

		const selectKeys = configuredKeyGroup(this.keybindings, [
			"tui.select.up",
			"tui.select.down",
		]);
		const closeKeys = configuredKeyGroup(
			this.keybindings,
			["tui.select.cancel", "app.interrupt"],
			["q"],
		);
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					` ${selectKeys} select · g/G first/last · j/k scroll output · t stdout/stderr · x kill · r refresh · ${closeKeys} close`,
				),
				width,
				"",
			),
		);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderDetails(
		snap: TerminalSnapshot | undefined,
		width: number,
		height: number,
	): string[] {
		if (!snap) {
			this.outputViewportRows = 1;
			return [this.theme.fg("dim", "No tracked terminals.")];
		}
		const detail = (label: string, value: string) =>
			truncateToWidth(
				`${this.theme.fg("dim", label.padEnd(9))}${value}`,
				width,
				"",
			);
		const streamData = this.stream === "stdout" ? snap.stdout : snap.stderr;
		const streamLabel = (name: "stdout" | "stderr", size: number) =>
			name === this.stream
				? this.theme.fg(
						"accent",
						this.theme.bold(`${name} ${formatSize(size)}`),
					)
				: this.theme.fg("dim", `${name} ${formatSize(size)}`);
		const primary = [
			detail("Terminal", this.theme.fg("text", snap.id)),
			detail(
				"State",
				`${statusGlyph(snap, this.theme)} ${this.theme.fg(statusColor(snap.status), snap.status)}`,
			),
			detail("Runtime", `pid ${snap.pid ?? "-"} · ${formatElapsed(snap)}`),
			`${streamLabel("stdout", snap.stdout.totalBytes)}${this.theme.fg("dim", " · ")}${streamLabel("stderr", snap.stderr.totalBytes)}`,
		];
		const optional = [
			...(snap.status === "running" ? [] : [detail("Exit", formatExit(snap))]),
			detail("Cwd", oneLine(snap.cwd)),
			detail("Command", oneLine(snap.command)),
			...(snap.errorText
				? [
						truncateToWidth(
							this.theme.fg("error", `Error: ${oneLine(snap.errorText)}`),
							width,
							"",
						),
					]
				: []),
			...(streamData.truncatedBytes > 0
				? [
						truncateToWidth(
							this.theme.fg(
								"dim",
								`First ${formatSize(streamData.truncatedBytes)} unavailable · spill ${oneLine(streamData.spillPath ?? "unavailable")}`,
							),
							width,
							"",
						),
					]
				: []),
		];
		const prefix = [...primary, ...optional].slice(0, Math.max(1, height - 2));
		const output = this.lineCache.get(
			streamData.text,
			streamData.totalBytes,
			Math.max(10, width),
		);
		const available = Math.max(1, height - prefix.length - 1);
		this.outputViewportRows = available;
		const outputLayoutKey = `${snap.id}:${this.stream}:${width}`;
		const anchor =
			this.scrollOffset > 0 &&
			this.outputAnchor?.key === outputLayoutKey &&
			(this.outputAnchor.version !== streamData.totalBytes ||
				this.outputAnchor.available !== available)
				? this.outputAnchor
				: undefined;
		let anchorIndex = -1;
		let anchorDistance = Number.POSITIVE_INFINITY;
		if (anchor) {
			for (let index = 0; index < output.length; index++) {
				if (
					!anchor.lines.every(
						(anchorLine, offset) => anchorLine === output[index + offset],
					)
				)
					continue;
				const distance = Math.abs(index - anchor.index);
				if (distance < anchorDistance) {
					anchorIndex = index;
					anchorDistance = distance;
				}
			}
		}
		if (anchorIndex >= 0)
			this.scrollOffset = Math.max(
				0,
				output.length - (anchorIndex + available),
			);
		else if (
			this.outputLayoutKey === outputLayoutKey &&
			this.scrollOffset > 0 &&
			output.length > this.outputLineCount
		)
			this.scrollOffset += output.length - this.outputLineCount;
		this.outputLayoutKey = outputLayoutKey;
		this.outputLineCount = output.length;
		const maxOffset = Math.max(0, output.length - available);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const end = output.length - this.scrollOffset;
		const visibleStart = Math.max(0, end - available);
		const visible = output.slice(visibleStart, end);
		this.outputAnchor =
			this.scrollOffset > 0 && visible.length > 0
				? {
						key: outputLayoutKey,
						lines: visible.slice(0, 3),
						index: visibleStart,
						version: streamData.totalBytes,
						available,
					}
				: undefined;
		prefix.push(
			this.theme.fg(
				"muted",
				this.scrollOffset > 0
					? `Output · ${this.scrollOffset} lines below`
					: "Output",
			),
		);
		if (visible.length === 0)
			prefix.push(this.theme.fg("dim", `(no ${this.stream} yet)`));
		else
			prefix.push(
				...visible.flatMap((line) =>
					wrapTextWithAnsi(this.theme.fg("toolOutput", line), width),
				),
			);
		return prefix.slice(0, height);
	}

	invalidate(): void {
		this.reconcile();
	}
}
