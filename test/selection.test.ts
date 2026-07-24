import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { TerminalSnapshot } from "../src/domain.ts";
import type { TerminalReadModel } from "../src/manager.ts";
import {
	openTerminalPicker,
	reconcileDashboardSelection,
} from "../src/ui/ps.ts";

test("picker selection follows an id and clamps when it disappears", () => {
	const selection = { id: "bt-2", index: 1 };
	reconcileDashboardSelection(selection, [{ id: "bt-2" }, { id: "bt-1" }]);
	assert.deepEqual(selection, { id: "bt-2", index: 0 });
	reconcileDashboardSelection(selection, [{ id: "bt-1" }]);
	assert.deepEqual(selection, { id: "bt-1", index: 0 });
});

function pickerHarness(openDetail: boolean) {
	const snapshot = {
		id: "bt-1",
		status: "running",
	} as TerminalSnapshot;
	let subscriptions = 0;
	const subscribe = () => {
		subscriptions++;
		return () => subscriptions--;
	};
	const view: TerminalReadModel = {
		list: () => [snapshot],
		get: (id) => (id === snapshot.id ? snapshot : undefined),
		size: () => 1,
		subscribe,
		subscribeTo: (_id, _listener) => subscribe(),
		requestKill: () => {},
		setOnSettled: () => {},
	};
	const tui = { requestRender: () => {}, terminal: { rows: 30 } } as TUI;
	const theme = {} as Theme;
	const keybindings = {} as KeybindingsManager;
	let calls = 0;
	const custom = <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => Component & { dispose?(): void },
	) =>
		new Promise<T>((resolve) => {
			calls++;
			let component: (Component & { dispose?(): void }) | undefined;
			const done = (value: T) => {
				component?.dispose?.();
				resolve(value);
			};
			component = factory(tui, theme, keybindings, done);
			if (openDetail && calls === 1) {
				queueMicrotask(() => done(snapshot.id as T));
			}
		});
	const ctx = {
		ui: { custom, notify: () => {} },
	} as unknown as ExtensionCommandContext;
	return { ctx, view, subscriptions: () => subscriptions, calls: () => calls };
}

test("picker dashboard and detail overlays close when the session aborts", async () => {
	for (const openDetail of [false, true]) {
		const harness = pickerHarness(openDetail);
		const controller = new AbortController();
		const opened = openTerminalPicker(
			harness.ctx,
			harness.view,
			controller.signal,
		);
		if (openDetail) {
			while (harness.calls() < 2) await new Promise(setImmediate);
		}
		controller.abort();
		await opened;
		assert.equal(harness.subscriptions(), 0);
	}
});
