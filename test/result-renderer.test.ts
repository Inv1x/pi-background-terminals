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
		"summary\n# heading\n- list item\n**not bold**\n<script>literal</script>\n\u001b[31mred\u001b[0m",
	display: true,
	details: {
		id: "bt-1",
		title: "literal",
		status: "done",
		exitCode: 0,
	},
	timestamp: Date.now(),
};

test("completion output is sanitized and rendered literally instead of as Markdown", () => {
	const component = renderTerminalResultMessage(
		message,
		{ expanded: true, outputPad: 0 },
		theme,
	);
	assert.ok(component);
	const rendered = component.render(80).join("\n");
	assert.match(rendered, /# heading/);
	assert.match(rendered, /- list item/);
	assert.match(rendered, /\*\*not bold\*\*/);
	assert.match(rendered, /<script>literal<\/script>/);
	assert.match(rendered, /red/);
	assert.doesNotMatch(rendered, /\u001b/);
});

test("completion renderer sanitizes title metadata, OSC 52, bidi, and unterminated controls", () => {
	const unsafeMessage = {
		...message,
		content:
			"summary\nvisible\u001b]52;c;c2VjcmV0\u0007\u001b[31mred\u001b[0m\u202E\nlast\u001b]52;c;unterminated",
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
	assert.match(rendered, /visible.*red/);
	assert.doesNotMatch(
		rendered,
		/\u001b|\u009b|\u202E|\u2066|\u2069|c2VjcmV0|dGl0bGU|unterminated/,
	);
});

test("completion renderer honors Pi custom-message output padding", () => {
	const withoutPadding = renderTerminalResultMessage(
		message,
		{ expanded: false, outputPad: 0 },
		theme,
	);
	const withPadding = renderTerminalResultMessage(
		message,
		{ expanded: false, outputPad: 1 },
		theme,
	);
	assert.ok(withoutPadding && withPadding);
	const unpaddedLines = withoutPadding.render(80);
	const paddedLines = withPadding.render(80);
	const unpaddedContent = unpaddedLines.find((line) =>
		line.includes("terminal"),
	);
	const paddedContent = paddedLines.find((line) => line.includes("terminal"));
	assert.ok(unpaddedContent && paddedContent);
	assert.equal(unpaddedContent.startsWith(" "), false);
	assert.equal(paddedContent.startsWith(" "), true);
	assert.ok(paddedLines.every((line) => visibleWidth(line) <= 80));
});
