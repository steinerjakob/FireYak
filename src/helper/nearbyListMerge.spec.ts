import { describe, expect, it } from 'vitest';
import {
	LIST_QUIET_MS,
	listInUse,
	mergeSilentUpdate,
	type MergeableEntry
} from '@/helper/nearbyListMerge';

type Entry = MergeableEntry & { id: string };
const e = (id: string, metres: number): Entry => ({
	id,
	distance: 300,
	routedDistance: metres,
	sortDistance: metres
});
const ids = (list: Entry[]) => list.map((x) => x.id);

describe('silent recompute of the nearby list (plan section 10, question 5)', () => {
	const shown = [e('a', 515), e('b', 700), e('c', 900)];
	// The DEM landed: a is really 1,350 m (the road round the scarp).
	const fresh = [e('b', 700), e('c', 900.4), e('a', 1350)];

	it('not in use: takes the fresh order and reports the changed metres', () => {
		const r = mergeSilentUpdate(shown, fresh, (x) => x.id, true);
		expect(ids(r.list)).toEqual(['b', 'c', 'a']);
		expect(r.changed).toEqual(['a']);
		expect(r.resortPending).toBe(false);
	});

	it('in use: metres update in place, the order waits', () => {
		const r = mergeSilentUpdate(shown, fresh, (x) => x.id, false);
		expect(ids(r.list)).toEqual(['a', 'b', 'c']);
		expect(r.list[0].routedDistance).toBe(1350);
		expect(r.resortPending).toBe(true);
	});

	it('dropped entries go, new ones are appended', () => {
		const r = mergeSilentUpdate(shown, [e('c', 900), e('d', 950), e('a', 515)], (x) => x.id, false);
		expect(ids(r.list)).toEqual(['a', 'c', 'd']);
		expect(r.changed).toEqual([]);
	});

	it('the list counts as in use for 3 s after a touch', () => {
		expect(listInUse(1000, 1000 + LIST_QUIET_MS - 1)).toBe(true);
		expect(listInUse(1000, 1000 + LIST_QUIET_MS)).toBe(false);
	});
});
