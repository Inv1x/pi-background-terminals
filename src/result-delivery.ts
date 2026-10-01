/**
 * One-shot delivery map: a prebuilt bounded result remains here only until it
 * is committed at a Pi boundary, queued as an idle follow-up, or consumed by
 * a tool call (bg_kill / bg_status) that returns the settlement itself.
 * Boundary proposals use peek() and acknowledge only persisted entries;
 * uncommitted or rejected drafts remain eligible for the next boundary.
 */
export function createDeferredResultDelivery<T extends { id: string }>() {
	const pending = new Map<string, T>();
	const holds = new Map<string, number>();

	return {
		defer(result: T) {
			pending.set(result.id, result);
		},
		/** Hold ids out of global drains while a tool may return their result. */
		hold(ids: Iterable<string>) {
			const unique = [...new Set(ids)];
			for (const id of unique) holds.set(id, (holds.get(id) ?? 0) + 1);
			let released = false;
			return (consume: boolean) => {
				if (released) return;
				released = true;
				for (const id of unique) {
					const count = (holds.get(id) ?? 1) - 1;
					if (count <= 0) holds.delete(id);
					else holds.set(id, count);
					if (consume) pending.delete(id);
				}
			};
		},
		consume(ids: Iterable<string>) {
			for (const id of ids) pending.delete(id);
		},
		/** Inspect eligible payloads without acknowledging uncommitted drafts. */
		peek() {
			return [...pending.values()].filter((result) => !holds.has(result.id));
		},
		drain() {
			const results: T[] = [];
			for (const [id, result] of pending) {
				if (holds.has(id)) continue;
				results.push(result);
				pending.delete(id);
			}
			return results;
		},
		clear() {
			pending.clear();
			holds.clear();
		},
	};
}
