/**
 * Deferred one-shot delivery map (same semantics as subagents'): a settled
 * terminal's result is held here until it is either drained into a follow-up
 * message or consumed by a tool call (bg_kill / bg_status) that already
 * returned the settlement itself. Keyed by id, so double delivery is
 * structurally impossible — whoever drains first wins.
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
