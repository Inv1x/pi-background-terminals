import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TerminalSnapshot } from "../src/domain.ts";
import type { TerminalReadModel } from "../src/manager.ts";
import {
	closeTerminalInspector,
	inspectorOverlayMaxHeight,
	openTerminalInspector,
	reconcileInspectorSelection,
} from "../src/ui/ps.ts";

test("inspector selection follows an id and clamps when it disappears", () => {
	const selection = { id: "bt-2", index: 1 };
	reconcileInspectorSelection(selection, [{ id: "bt-2" }, { id: "bt-1" }]);
	assert.deepEqual(selection, { id: "bt-2", index: 0 });
	reconcileInspectorSelection(selection, [{ id: "bt-1" }]);
	assert.deepEqual(selection, { id: "bt-1", index: 0 });
});

function snapshot(
	id: string,
	title: string,
	status: TerminalSnapshot["status"] = "running",
): TerminalSnapshot {
	return {
		id,
		title,
		status,
		command: `run ${title}`,
		cwd: "/tmp/project",
		pid: status === "running" ? 123 : undefined,
		createdAt: Date.now() - 5000,
		settledAt: status === "running" ? undefined : Date.now(),
		exitCode: status === "done" ? 0 : undefined,
		stdout: {
			text:
				id === "bt-1"
					? Array.from(
							{ length: 30 },
							(_, index) => `alpha line ${index}`,
						).join("\n")
					: "beta output",
			totalBytes: id === "bt-1" ? 400 : 11,
			truncatedBytes: 0,
		},
		stderr: {
			text: `${title} error output`,
			totalBytes: title.length + 13,
			truncatedBytes: 0,
		},
	};
}

const keyMap: Record<string, string[]> = {
	"tui.select.up": ["up"],
	"tui.select.down": ["down"],
	"tui.select.cancel": ["escape"],
	"app.interrupt": ["ctrl+c"],
	"tui.editor.pageUp": ["pageup"],
	"tui.editor.pageDown": ["pagedown"],
};

const inputMap: Record<string, string> = {
	"\u001b[A": "tui.select.up",
	"\u001b[B": "tui.select.down",
	"\u001b": "tui.select.cancel",
	"\u0003": "app.interrupt",
	"\u001b[5~": "tui.editor.pageUp",
	"\u001b[6~": "tui.editor.pageDown",
};

const keybindings = {
	getKeys: (binding: string) => keyMap[binding] ?? [],
	matches: (data: string, binding: string) => inputMap[data] === binding,
} as unknown as KeybindingsManager;

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

interface InspectorHarness {
	ctx: ExtensionCommandContext;
	view: TerminalReadModel;
	component: () => (Component & { dispose?(): void }) | undefined;
	calls: () => number;
	focuses: () => number;
	subscriptions: () => number;
	overlayOptions: () => { overlay?: boolean; anchor?: string };
	kills: string[];
	update(terminals: TerminalSnapshot[]): void;
}

function inspectorHarness(
	terminals: TerminalSnapshot[],
	terminalRows = 30,
	mode: "regular" | "fullscreen" = "regular",
): InspectorHarness {
	const current = terminals;
	let subscriptions = 0;
	let calls = 0;
	let focuses = 0;
	let mountedOverlay = false;
	let mountedAnchor: string | undefined;
	let component: (Component & { dispose?(): void }) | undefined;
	const kills: string[] = [];
	const listeners = new Set<() => void>();
	const view: TerminalReadModel = {
		list: () => current,
		get: (id) => current.find((snap) => snap.id === id),
		size: () => current.length,
		subscribe: (listener) => {
			subscriptions++;
			listeners.add(listener);
			return () => {
				subscriptions--;
				listeners.delete(listener);
			};
		},
		subscribeTo: () => () => {},
		requestKill: (id) => kills.push(id),
		setOnSettled: () => {},
	};
	const tui = {
		mode,
		requestRender: () => {},
		terminal: { rows: terminalRows },
	} as TUI;
	const custom = <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => Component & { dispose?(): void },
		options?: {
			overlay?: boolean;
			overlayOptions?: { anchor?: string };
			onHandle?: (handle: OverlayHandle) => void;
		},
	) =>
		new Promise<T>((resolve) => {
			calls++;
			const done = (value: T) => {
				component?.dispose?.();
				component = undefined;
				resolve(value);
			};
			component = factory(tui, theme, keybindings, done);
			mountedOverlay = options?.overlay === true;
			mountedAnchor = options?.overlayOptions?.anchor;
			options?.onHandle?.({
				focus: () => focuses++,
			} as unknown as OverlayHandle);
		});
	const ctx = {
		mode: "tui",
		ui: { custom, notify: () => {} },
	} as unknown as ExtensionCommandContext;
	return {
		ctx,
		view,
		component: () => component,
		calls: () => calls,
		focuses: () => focuses,
		subscriptions: () => subscriptions,
		overlayOptions: () => ({
			overlay: mountedOverlay,
			anchor: mountedAnchor,
		}),
		kills,
		update: (next) => {
			current.splice(0, current.length, ...next);
			for (const listener of listeners) listener();
		},
	};
}

test("inspector is singleton, focuses on reopen, and closes on abort", async () => {
	const harness = inspectorHarness([snapshot("bt-1", "alpha")]);
	const controller = new AbortController();
	const opened = openTerminalInspector(
		harness.ctx,
		harness.view,
		controller.signal,
	);
	assert.equal(harness.calls(), 1);
	assert.equal(harness.focuses(), 1);
	assert.deepEqual(harness.overlayOptions(), {
		overlay: true,
		anchor: "center",
	});
	await openTerminalInspector(harness.ctx, harness.view, controller.signal);
	assert.equal(harness.calls(), 1);
	assert.equal(harness.focuses(), 2);
	controller.abort();
	await opened;
	assert.equal(harness.subscriptions(), 0);

	const reopened = openTerminalInspector(harness.ctx, harness.view);
	assert.equal(harness.calls(), 2);
	closeTerminalInspector(harness.view);
	await reopened;
	assert.equal(harness.subscriptions(), 0);
});

test("inspector keeps historical output anchored while new lines arrive", async () => {
	const alpha = snapshot("bt-1", "alpha");
	const harness = inspectorHarness([alpha]);
	const opened = openTerminalInspector(harness.ctx, harness.view);
	const component = harness.component();
	assert.ok(component);
	component.handleInput?.("k");
	assert.doesNotMatch(component.render(120).join("\n"), /alpha line 29/);

	const appended = {
		...alpha,
		stdout: {
			...alpha.stdout,
			text: `${alpha.stdout.text.split("\n").slice(1).join("\n")}\nalpha line 30`,
			totalBytes: alpha.stdout.totalBytes + 14,
			truncatedBytes: 13,
		},
	};
	harness.update([appended]);
	assert.doesNotMatch(component.render(120).join("\n"), /alpha line 29/);

	component.handleInput?.("q");
	await opened;
});

test("inspector anchor stays stable across unchanged repeated output", async () => {
	const base = snapshot("bt-1", "repeated");
	const repeated = {
		...base,
		stdout: {
			...base.stdout,
			text: Array.from({ length: 30 }, () => "same line").join("\n"),
			totalBytes: 300,
		},
	};
	const harness = inspectorHarness([repeated]);
	const opened = openTerminalInspector(harness.ctx, harness.view);
	const component = harness.component();
	assert.ok(component);
	component.handleInput?.("k");
	assert.match(component.render(120).join("\n"), /Output · 1 lines below/);
	assert.match(component.render(120).join("\n"), /Output · 1 lines below/);
	component.handleInput?.("q");
	await opened;
});

test("inspector fits the fullscreen overlay height and component width", async () => {
	const terminalRows = 12;
	const harness = inspectorHarness(
		[snapshot("bt-1", "alpha")],
		terminalRows,
		"fullscreen",
	);
	const opened = openTerminalInspector(harness.ctx, harness.view);
	const component = harness.component();
	assert.ok(component);
	const rendered = component.render(100);
	assert.equal(rendered.length, inspectorOverlayMaxHeight(terminalRows));
	assert.ok(rendered.every((line) => visibleWidth(line) <= 100));
	assert.match(rendered.join("\n"), /Output/);
	component.handleInput?.("q");
	await opened;

	const tiny = inspectorHarness([snapshot("bt-1", "alpha")], 6, "fullscreen");
	const tinyOpened = openTerminalInspector(tiny.ctx, tiny.view);
	const tinyComponent = tiny.component();
	assert.ok(tinyComponent);
	assert.ok(tinyComponent.render(100).length <= inspectorOverlayMaxHeight(6));
	tinyComponent.handleInput?.("q");
	await tinyOpened;
});

test("inspector reserves output space on short terminals", async () => {
	const harness = inspectorHarness([snapshot("bt-1", "alpha")], 10);
	const opened = openTerminalInspector(harness.ctx, harness.view);
	const component = harness.component();
	assert.ok(component);
	const rendered = component.render(100).join("\n");
	assert.match(rendered, /Output/);
	assert.match(rendered, /alpha line 29/);
	component.handleInput?.("q");
	await opened;
});

test("inspector arrows select while j/k scroll output and labels keys consistently", async () => {
	const harness = inspectorHarness([
		snapshot("bt-1", "alpha"),
		snapshot("bt-2", "beta"),
		snapshot("bt-3", "settled", "done"),
	]);
	const opened = openTerminalInspector(harness.ctx, harness.view);
	const component = harness.component();
	assert.ok(component);
	const render = () => component.render(120).join("\n");

	assert.match(render(), /Background terminals/);
	assert.match(render(), /Terminal\s+bt-1/);
	assert.match(
		render(),
		/Up\/Down select · g\/G first\/last · j\/k scroll output/,
	);
	assert.match(render(), /Esc\/Ctrl\+C\/q close/);
	assert.doesNotMatch(render(), /\besc\b|\bescape\b/);

	component.handleInput?.("\u001b[107u"); // Kitty plain k
	assert.match(render(), /Terminal\s+bt-1/);
	assert.match(render(), /lines below/);
	component.handleInput?.("\u001b[106u"); // Kitty plain j
	assert.match(render(), /Terminal\s+bt-1/);

	component.handleInput?.("\u001b[B");
	assert.match(render(), /Terminal\s+bt-2/);
	assert.match(render(), /beta output/);
	component.handleInput?.("t");
	assert.match(render(), /beta · stderr/);
	assert.match(render(), /beta error output/);
	component.handleInput?.("x");
	assert.deepEqual(harness.kills, ["bt-2"]);

	component.handleInput?.("G");
	assert.match(render(), /Terminal\s+bt-3/);
	component.handleInput?.("x");
	assert.deepEqual(harness.kills, ["bt-2"]);
	component.handleInput?.("g");
	assert.match(render(), /Terminal\s+bt-1/);

	component.handleInput?.("\u001b[113u"); // Kitty plain q
	await opened;
	assert.equal(harness.subscriptions(), 0);
});
