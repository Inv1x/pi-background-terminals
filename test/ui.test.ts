import assert from "node:assert/strict";
import test from "node:test";
import {
	buildOutputLines,
	createOutputLineCache,
	sanitizeText,
} from "../src/ui/output-view.ts";

test("sanitizes ANSI, OSC, controls, and tabs before TUI rendering", () => {
	const unsafe = "\u001b]0;title\u0007\u001b[31mred\u001b[0m\tX\u0000";
	assert.equal(sanitizeText(unsafe), "red  X");
});

test("progress output keeps its final carriage-return state and wraps", () => {
	assert.deepEqual(buildOutputLines("old\rnew\nabcdefghijk", 10), [
		"new",
		"abcdefghij",
		"k",
	]);
});

test("line cache reuses a layout until output version or width changes", () => {
	const cache = createOutputLineCache();
	const first = cache.get("hello", 1, 20);
	assert.equal(cache.get("ignored", 1, 20), first);
	assert.notEqual(cache.get("changed", 2, 20), first);
});
