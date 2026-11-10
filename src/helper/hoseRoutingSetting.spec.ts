import { describe, expect, it } from 'vitest';
import {
	modeFromToggles,
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

// Plan section 6.7, migration table: [stored state, phases 3-4 with the preview flag,
// phases 3-4 without it, from phase 5].
const TABLE: [string, StoredHoseRouting, HoseRoutingMode, HoseRoutingMode, HoseRoutingMode][] = [
	["hose_routing = 'optimized'", stored('optimized', null), 'optimized', 'direct', 'optimized'],
	["hose_routing = 'roads'", stored('roads', null), 'roads', 'roads', 'roads'],
	["hose_routing = 'direct'", stored('direct', null), 'direct', 'direct', 'optimized'],
	["no hose_routing, clamp 'true'", stored(null, 'true'), 'roads', 'roads', 'roads'],
	["no hose_routing, clamp 'false'", stored(null, 'false'), 'direct', 'direct', 'optimized'],
	['no hose_routing, clamp absent', stored(null, null), 'direct', 'direct', 'optimized'],
	['any other value', stored('fastest', null), 'direct', 'direct', 'optimized'],
	['any other value, clamp true', stored('', 'true'), 'direct', 'direct', 'optimized'],
	['hose_routing wins over the old key', stored('direct', 'true'), 'direct', 'direct', 'optimized']
];

describe('resolveHoseRouting (plan section 6.7)', () => {
	it.each(TABLE)('%s: phases 3-4', (_name, input, withFlag, withoutFlag) => {
		expect(resolveHoseRouting(input, 'transitional', true)).toEqual({
			mode: withFlag,
			shouldPersist: false
		});
		expect(resolveHoseRouting(input, 'transitional', false)).toEqual({
			mode: withoutFlag,
			shouldPersist: false
		});
	});

	it('phases 3-4: the migrated value is never persisted', () => {
		for (const [, input] of TABLE) {
			for (const flag of [true, false]) {
				expect(resolveHoseRouting(input, 'transitional', flag).shouldPersist).toBe(false);
			}
		}
	});

	it.each(TABLE)('%s: from phase 5', (_name, input, _withFlag, _withoutFlag, final) => {
		expect(resolveHoseRouting(input, 'final').mode).toBe(final);
	});

	it('from phase 5 the default is written once and the old key dropped', () => {
		expect(resolveHoseRouting(stored(null, null), 'final').shouldPersist).toBe(true);
		expect(resolveHoseRouting(stored('direct', null), 'final').shouldPersist).toBe(true);
		expect(resolveHoseRouting(stored('roads', 'true'), 'final').shouldPersist).toBe(true);
		expect(resolveHoseRouting(stored('optimized', null), 'final').shouldPersist).toBe(false);
		expect(resolveHoseRouting(stored('roads', null), 'final').shouldPersist).toBe(false);
	});
});

describe('modeFromToggles (phases 3-4)', () => {
	it('the road toggle wins; off maps to direct unless the preview picks optimized', () => {
		expect(modeFromToggles(true, true, true)).toBe('roads');
		expect(modeFromToggles(true, false, false)).toBe('roads');
		expect(modeFromToggles(false, false, true)).toBe('direct');
		expect(modeFromToggles(false, true, true)).toBe('optimized');
		// Production build: no preview, the toggle keeps today's behaviour.
		expect(modeFromToggles(false, true, false)).toBe('direct');
	});
});
