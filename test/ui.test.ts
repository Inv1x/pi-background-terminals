import assert from "node:assert/strict";
import test from "node:test";
import {
	buildOutputLines,
	createOutputLineCache,
	sanitizeText,
} from "../src/ui/output-view.ts";

test("sanitizes ANSI, OSC 52, controls, bidi, and unterminated escapes idempotently", () => {
	const unsafe =
		"\u001b]52;c;c2VjcmV0\u0007\u001b[31mred\u001b[0m\tX\u0000\u202Ertl\u2066isolate\u2069";
	const safe = sanitizeText(unsafe);
	assert.equal(safe, "red  Xrtlisolate");
	assert.equal(sanitizeText(safe), safe);
	assert.equal(sanitizeText("before\u001b]52;c;unterminated"), "before");
	assert.equal(sanitizeText("before\u001b[12345"), "before");
	assert.equal(
		sanitizeText("paired 😀 lone \ud800 and \udfff"),
		"paired 😀 lone � and �",
	);
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
