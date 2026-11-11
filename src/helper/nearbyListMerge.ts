/**
 * How the nearby list takes a silent recompute (plan §6.9, §10 question 5):
 * the metres of every entry update at once (and the changed entries are
 * reported, for a short highlight); the ORDER follows only when the user is
 * not touching the list, so an entry never jumps away under the finger. A
 * deferred re-sort runs once the list has been left alone (see
 * `composable/nearbyWaterSource.ts`). Pure.
 */

/** The list counts as "in use" for this long after the last touch, scroll or wheel. */
export const LIST_QUIET_MS = 3000;

/** Metres that change by less than this are not highlighted. */
export const CHANGE_SHOWN_M = 1;

export interface MergeableEntry {
	sortDistance: number;
	distance: number;
	routedDistance: number | null;
}

/** The list order: ranking key, then straight distance. */
export function compareEntries(a: MergeableEntry, b: MergeableEntry): number {
	return a.sortDistance - b.sortDistance || a.distance - b.distance;
}

/** True when the list was touched within {@link LIST_QUIET_MS} of `now`. */
export function listInUse(lastInteractionAt: number, now: number): boolean {
	return now - lastInteractionAt < LIST_QUIET_MS;
}

export interface MergeResult<T> {
	list: T[];
	/** Keys whose shown metres changed by at least {@link CHANGE_SHOWN_M}. */
	changed: string[];
	/** The fresh order differs from the list as shown (a re-sort is still due). */
	resortPending: boolean;
}

/**
 * Merges a silent recompute (`fresh`, already sorted) into the list as shown.
 * With `resort`, the fresh order is taken; without, entries keep their places
 * and take the fresh values; entries no longer present are dropped, new ones
 * are appended in fresh order.
 */
export function mergeSilentUpdate<T extends MergeableEntry>(
	current: T[],
	fresh: T[],
	keyOf: (entry: T) => string,
	resort: boolean
): MergeResult<T> {
	const before = new Map(current.map((e) => [keyOf(e), e]));
	const shown = (e: T) => e.routedDistance ?? e.distance;
	const changed = fresh
		.filter((e) => {
			const old = before.get(keyOf(e));
			return old !== undefined && Math.abs(shown(old) - shown(e)) >= CHANGE_SHOWN_M;
		})
		.map(keyOf);
	if (resort) return { list: [...fresh], changed, resortPending: false };

	const byKey = new Map(fresh.map((e) => [keyOf(e), e]));
	const list: T[] = [];
	for (const old of current) {
		const updated = byKey.get(keyOf(old));
		if (updated) {
			list.push(updated);
			byKey.delete(keyOf(old));
		}
	}
	for (const e of fresh) if (byKey.has(keyOf(e))) list.push(e);
	const resortPending = list.some((e, i) => keyOf(e) !== keyOf(fresh[i]));
	return { list, changed, resortPending };
}
