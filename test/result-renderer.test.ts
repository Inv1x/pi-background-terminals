import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTerminalResultMessage } from "../src/result-renderer.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const message: Parameters<typeof renderTerminalResultMessage>[0] = {
	role: "custom",
	customType: "background-terminal-result",
	content:
		"summary\nsecret stdout\n# heading\n\u001b[31mred\u001b[0m\n/tmp/secret",
	display: true,
	details: {
		id: "bt-1",
		title: "literal",
		status: "done",
		exitCode: 0,
	},
	timestamp: Date.now(),
};

function render(expanded: boolean, outputPad = 0) {
	const component = renderTerminalResultMessage(
		message,
		{ expanded, outputPad },
		theme,
	);
	assert.ok(component);
	return component.render(80).join("\n");
}

test("historical completion renderer is compact and expansion-invariant", () => {
	const collapsed = render(false);
	const expanded = render(true);
	assert.equal(expanded, collapsed);
	assert.match(expanded, /terminal bt-1 · literal · exit 0/);
	assert.doesNotMatch(
		expanded,
		/secret stdout|heading|red|\/tmp\/secret|Ctrl\+O|\u001b/,
	);
});

test("completion renderer sanitizes metadata controls", () => {
	const unsafeMessage = {
		...message,
		details: {
			...message.details,
			title:
				"title\u001b]52;c;dGl0bGU=\u0007\u001b[2J\u2066safe\u2069\u001b]52;c;unterminated",
			signal: "SIG\u001b[31mTERM\u001b[0m",
		},
	};
	const component = renderTerminalResultMessage(
		unsafeMessage,
		{ expanded: true, outputPad: 0 },
		theme,
	);
	assert.ok(component);
	const rendered = component.render(100).join("\n");
	assert.match(rendered, /title.*safe/);
	assert.match(rendered, /SIGTERM/);
	assert.doesNotMatch(
		rendered,
		/\u001b|\u009b|\u202E|\u2066|\u2069|dGl0bGU|unterminated/,
	);
});

test("completion renderer honors Pi custom-message output padding", () => {
	const unpaddedLines = render(false, 0).split("\n");
	const paddedLines = render(false, 1).split("\n");
	const unpaddedContent = unpaddedLines.find((line) =>
		line.includes("terminal"),
	);
	const paddedContent = paddedLines.find((line) => line.includes("terminal"));
	assert.ok(unpaddedContent && paddedContent);
	assert.equal(unpaddedContent.startsWith(" "), false);
	assert.equal(paddedContent.startsWith(" "), true);
	assert.ok(paddedLines.every((line) => visibleWidth(line) <= 80));
});
