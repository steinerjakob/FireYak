import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MAX_HOSE_PRESSURE_BAR,
	evaluateDownhillPressure,
	parseHydrantPressure,
	parseStoredMaxHosePressure,
	stretchesAlongLine
} from '@/helper/hosePressure';

/** Heights of a line that drops `drop` metres from the source at the end. */
const dropping = (drop: number) => [500, 500 - drop / 2, 500 - drop];

describe('parseHydrantPressure', () => {
	it.each([
		[{ 'fire_hydrant:pressure': '6' }, 6],
		[{ 'fire_hydrant:pressure': '4.5' }, 4.5],
		[{ 'fire_hydrant:pressure': 'suction' }, null],
		[{ 'fire_hydrant:pressure': '0' }, null],
		[{}, null],
		[undefined, null]
	])('%o → %s', (tags, expected) => {
		expect(parseHydrantPressure(tags as Record<string, string> | undefined)).toBe(expected);
	});
});

describe('maxHosePressure setting (migration of installs without it)', () => {
	it('defaults to 16 bar', () => {
		expect(DEFAULT_MAX_HOSE_PRESSURE_BAR).toBe(16);
		expect(parseStoredMaxHosePressure(null)).toBe(16);
		expect(parseStoredMaxHosePressure(undefined)).toBe(16);
		expect(parseStoredMaxHosePressure('')).toBe(16);
	});

	it('keeps a stored value and rejects unusable ones', () => {
		expect(parseStoredMaxHosePressure('12')).toBe(12);
		expect(parseStoredMaxHosePressure('10.5')).toBe(10.5);
		expect(parseStoredMaxHosePressure('abc')).toBe(16);
		expect(parseStoredMaxHosePressure('0')).toBe(16);
		expect(parseStoredMaxHosePressure('-3')).toBe(16);
	});
});

describe('downhill pressure rule: threshold table (plan section 6.13)', () => {
	const level = (drop: number, sourceBar: number) =>
		evaluateDownhillPressure([{ heights: dropping(drop), sourceBar }], 16)!.level;

	it('pump at the source, 8 bar: caution from 40 m, warning from 80 m', () => {
		expect(level(39, 8)).toBe('ok');
		expect(level(40, 8)).toBe('caution');
		expect(level(79, 8)).toBe('caution');
		expect(level(80, 8)).toBe('warning');
	});

	it('hydrant, 6 bar: caution from 60 m, warning from 100 m', () => {
		expect(level(59, 6)).toBe('ok');
		expect(level(60, 6)).toBe('caution');
		expect(level(100, 6)).toBe('warning');
	});

	it('hydrant, 4 bar: caution from 80 m, warning from 120 m', () => {
		expect(level(79, 4)).toBe('ok');
		expect(level(80, 4)).toBe('caution');
		expect(level(119, 4)).toBe('caution');
		expect(level(120, 4)).toBe('warning');
	});

	it('scales with the setting: 12 bar hoses warn from 40 m below an 8 bar pump', () => {
		expect(evaluateDownhillPressure([{ heights: dropping(40), sourceBar: 8 }], 12)!.level).toBe(
			'warning'
		);
	});

	it('Innsbruck: 177 m of drop warns even with no source pressure', () => {
		const result = evaluateDownhillPressure([{ heights: dropping(177), sourceBar: 0 }], 16)!;
		expect(result.staticPressureMaxBar).toBeCloseTo(17.7, 6);
		expect(result.level).toBe('warning');
	});

	it('an uphill-only profile is ok: no rule applies', () => {
		const result = evaluateDownhillPressure([{ heights: [100, 150, 300], sourceBar: 13 }], 16)!;
		expect(result.level).toBe('ok');
	});

	it('uses the lowest point downstream of the source, not the end point', () => {
		// Drops 90 m into a valley, then climbs back to 10 m below the source.
		const result = evaluateDownhillPressure(
			[{ heights: [500, 450, 410, 470, 490], sourceBar: 8 }],
			16
		)!;
		expect(result.staticPressureMaxBar).toBeCloseTo(17, 6);
		expect(result.level).toBe('warning');
	});

	it('returns null without heights', () => {
		expect(evaluateDownhillPressure([], 16)).toBeNull();
	});
});

describe('stretchesAlongLine (pump line with booster pumps)', () => {
	it('evaluates each stretch from its own pump', () => {
		const s = [0, 100, 200, 300, 400];
		const h = [300, 320, 340, 280, 250];
		const stretches = stretchesAlongLine(s, h, 8, [{ atM: 200, sourceBar: 8 }]);
		expect(stretches.map((st) => st.heights)).toEqual([
			[300, 320, 340],
			[340, 280, 250]
		]);
		// The second stretch drops 90 m below its pump: 8 + 9 = 17 bar.
		expect(evaluateDownhillPressure(stretches, 16)!.staticPressureMaxBar).toBeCloseTo(17, 6);
	});
});
