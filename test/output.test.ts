import assert from "node:assert/strict";
import test from "node:test";
import { OutputBuffer } from "../src/output.ts";

test("captures bytes and evicts old chunks while keeping streams bounded", () => {
	const output = new OutputBuffer(8);
	output.push("aaaa");
	output.push("bbbb");
	output.push("cccc");
	assert.deepEqual(output.view(), {
		text: "bbbbcccc",
		totalBytes: 12,
		truncatedBytes: 4,
		spillPath: undefined,
	});
});

test("oversized UTF-8 chunks retain a valid tail and spill the complete input", () => {
	const spilled: string[] = [];
	const output = new OutputBuffer(5, (chunk) => spilled.push(chunk));
	output.push("ééééé");
	assert.equal(output.view().text, "éé");
	assert.equal(output.view().totalBytes, 10);
	assert.equal(output.view().truncatedBytes, 6);
	assert.ok(!output.view().text.includes("�"));
	assert.deepEqual(spilled, ["ééééé"]);
});

test("builds a bounded UTF-8 tail without advertising the spill", () => {
	const output = new OutputBuffer(64);
	output.spillPath = "/tmp/full.log";
	output.push("prefix-ééé-tail");
	const tail = output.tail(9);
	assert.equal(tail.text, "éé-tail");
	assert.equal(tail.totalBytes, 18);
	assert.equal(tail.truncatedBytes, 9);
	assert.equal(tail.spillPath, undefined);
	assert.ok(!tail.text.includes("�"));
});

test("reports spill backpressure without losing retained output", () => {
	const output = new OutputBuffer(32, () => false);
	assert.equal(output.push("queued"), false);
	assert.equal(output.view().text, "queued");
});
