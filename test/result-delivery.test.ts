import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredResultDelivery } from "../src/result-delivery.ts";

test("deferred completion is drained exactly once", () => {
	const delivery = createDeferredResultDelivery<{
		id: string;
		value: number;
	}>();
	delivery.defer({ id: "bt-1", value: 1 });
	delivery.defer({ id: "bt-1", value: 2 });
	assert.deepEqual(delivery.drain(), [{ id: "bt-1", value: 2 }]);
	assert.deepEqual(delivery.drain(), []);
});

test("status or kill consumption prevents a duplicate follow-up", () => {
	const delivery = createDeferredResultDelivery<{ id: string }>();
	delivery.defer({ id: "bt-1" });
	delivery.consume(["bt-1"]);
	assert.deepEqual(delivery.drain(), []);
});

test("an in-flight kill retains settlement until the tool succeeds", () => {
	const delivery = createDeferredResultDelivery<{ id: string }>();
	const releaseAborted = delivery.hold(["bt-1"]);
	delivery.defer({ id: "bt-1" });
	delivery.defer({ id: "unrelated" });
	// Global drains can deliver other results without stealing the held kill.
	assert.deepEqual(delivery.drain(), [{ id: "unrelated" }]);
	releaseAborted(false);
	assert.deepEqual(delivery.drain(), [{ id: "bt-1" }]);

	const releaseSuccessful = delivery.hold(["bt-2"]);
	delivery.defer({ id: "bt-2" });
	releaseSuccessful(true);
	assert.deepEqual(delivery.drain(), []);
});

test("a failed send can be deferred again for retry", () => {
	const delivery = createDeferredResultDelivery<{ id: string }>();
	const result = { id: "bt-1" };
	delivery.defer(result);
	for (const item of delivery.drain()) delivery.defer(item);
	assert.deepEqual(delivery.drain(), [result]);
});
