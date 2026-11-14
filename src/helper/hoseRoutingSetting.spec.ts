import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	modeFromToggle,
	resolveHoseRouting,
	type HoseRoutingMode,
	type StoredHoseRouting
} from '@/helper/hoseRoutingSetting';

const stored = (
	hoseRouting: string | null,
	clampHosesToRoads: string | null
): StoredHoseRouting => ({
	hoseRouting,
	clampHosesToRoads
});

// Plan section 6.7, migration table, "from phase 5" column.
const TABLE: [string, StoredHoseRouting, HoseRoutingMode][] = [
	["hose_routing = 'optimized'", stored('optimized', null), 'optimized'],
	["hose_routing = 'roads'", stored('roads', null), 'roads'],
	["hose_routing = 'direct' (removed mode)", stored('direct', null), 'optimized'],
	["no hose_routing, clamp 'true'", stored(null, 'true'), 'roads'],
	["no hose_routing, clamp 'false'", stored(null, 'false'), 'optimized'],
	['no hose_routing, clamp absent', stored(null, null), 'optimized'],
	['any other value', stored('fastest', null), 'optimized'],
	['any other value, clamp true', stored('', 'true'), 'optimized'],
	['hose_routing wins over the old key', stored('direct', 'true'), 'optimized']
];

describe('resolveHoseRouting (plan section 6.7, from phase 5)', () => {
	it.each(TABLE)('%s', (_name, input, mode) => {
		expect(resolveHoseRouting(input).mode).toBe(mode);
	});

	it('never yields a mode outside optimized | roads', () => {
		const values = [null, '', 'direct', 'terrain', 'OPTIMIZED', 'Roads', 'true', 'false', '1'];
		for (const h of values) {
			for (const c of values) {
				expect(['optimized', 'roads']).toContain(resolveHoseRouting(stored(h, c)).mode);
			}
		}
	});

	it('shouldPersist is true exactly once: after the write-back nothing is written again', () => {
		for (const [, input, mode] of TABLE) {
			const first = resolveHoseRouting(input);
			// After the write-back the store holds the mode and no old key.
			const second = resolveHoseRouting(stored(first.mode, null));
			expect(second).toEqual({ mode, shouldPersist: false });
		}
	});

	it('writes the default and drops the old key when needed', () => {
		expect(resolveHoseRouting(stored(null, null)).shouldPersist).toBe(true);
		expect(resolveHoseRouting(stored(null, 'false')).shouldPersist).toBe(true);
		expect(resolveHoseRouting(stored(null, 'true')).shouldPersist).toBe(true);
		expect(resolveHoseRouting(stored('direct', null)).shouldPersist).toBe(true);
		expect(resolveHoseRouting(stored('roads', 'true')).shouldPersist).toBe(true);
		expect(resolveHoseRouting(stored('optimized', null)).shouldPersist).toBe(false);
		expect(resolveHoseRouting(stored('roads', null)).shouldPersist).toBe(false);
	});
});

describe('HoseRoutingMode', () => {
	it('has exactly two modes; direct is gone (type level, checked by the typecheck)', () => {
		expectTypeOf<HoseRoutingMode>().toEqualTypeOf<'optimized' | 'roads'>();
		// @ts-expect-error 'direct' was removed in phase 5
		const removed: HoseRoutingMode = 'direct';
		expect(resolveHoseRouting(stored(removed, null)).mode).toBe('optimized');
	});
});

describe('modeFromToggle', () => {
	it('on = roads, off = optimized', () => {
		expect(modeFromToggle(true)).toBe('roads');
		expect(modeFromToggle(false)).toBe('optimized');
	});
});
