import { describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import de from '@/locales/de.json';
import type { HoseRoute } from '@/mapHandler/nearbyRouting';
import {
	BARRIERS_UNKNOWN_CHIP,
	crossCountryNoteDue,
	formatMeters,
	routeChips,
	routeLabel,
	showsRoadComparison
} from '@/helper/routeLabel';

type Messages = Record<string, unknown>;

/** A minimal `t` over the locale files ("{name}" placeholders). */
function translator(messages: Messages) {
	return (key: string, values: Record<string, unknown> = {}) => {
		const text = key
			.split('.')
			.reduce<unknown>((node, part) => (node as Messages)?.[part], messages);
		if (typeof text !== 'string') throw new Error(`missing i18n key ${key}`);
		return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
	};
}

function route(overrides: Partial<HoseRoute> = {}): HoseRoute {
	return {
		points: [],
		meters: 1367,
		planMeters: 1340,
		segments: [],
		climbM: 197,
		metersOver25: 0,
		metersOver50: 0,
		maxGradePct: null,
		offRoadMeters: 0,
		staticPressureMaxBar: null,
		pressureLevel: null,
		notRecommended: false,
		roadOnlyMeters: null,
		demZoom: 14,
		fallback: null,
		coverage: { basemap: 'full', dem: 'z14', barriers: 'unknown' },
		routed: true,
		profile: null,
		cellM: 8,
		...overrides
	};
}

const deOptions = { t: translator(de), locale: 'de', tubeLength: 20, hoseName: 'B' };
const enOptions = { t: translator(en), locale: 'en', tubeLength: 20, hoseName: 'B' };

describe('routeLabel (plan section 6.8)', () => {
	it('1,367 m / 20 m hoses / +197 m, de: estimate, hoses and signed climb', () => {
		expect(routeLabel(route(), deOptions)).toBe('ca. 1.367 m · ~69 B-Schläuche · ↑197 m');
	});

	it('en: the same with the English separator and estimate prefix', () => {
		expect(routeLabel(route(), enOptions)).toBe('approx. 1,367 m · ~69 B-hoses · ↑197 m');
	});

	it('is always marked as an estimate', () => {
		for (const r of [route(), route({ routed: false, climbM: null })]) {
			expect(routeLabel(r, deOptions).startsWith('ca. ')).toBe(true);
			expect(routeLabel(r, enOptions).startsWith('approx. ')).toBe(true);
		}
	});

	it('negative climb shows a down arrow', () => {
		expect(routeLabel(route({ climbM: -42.4 }), deOptions)).toContain('↓42 m');
		expect(routeLabel(route({ climbM: -42.4 }), deOptions)).not.toContain('↑');
	});

	it('the map label writes the climb with + / - (its font has no arrow glyphs)', () => {
		const map = { ...deOptions, climbSigns: 'plusMinus' as const };
		expect(routeLabel(route(), map)).toBe('ca. 1.367 m · ~69 B-Schläuche · +197 m');
		expect(routeLabel(route({ climbM: -42 }), map)).toContain('· -42 m');
	});

	it('no climb part without DEM or below 1 m', () => {
		expect(routeLabel(route({ climbM: null }), deOptions)).toBe('ca. 1.367 m · ~69 B-Schläuche');
		expect(routeLabel(route({ climbM: 0.4 }), deOptions)).toBe('ca. 1.367 m · ~69 B-Schläuche');
	});

	it('road-only length differing by 16 % is appended', () => {
		const label = routeLabel(route({ meters: 1000, roadOnlyMeters: 1160 }), deOptions);
		expect(label).toBe('ca. 1.000 m · ~50 B-Schläuche · ↑197 m · Straße 1.160 m');
		// Shorter by 16 % counts too.
		expect(routeLabel(route({ meters: 1000, roadOnlyMeters: 840 }), deOptions)).toContain(
			'Straße 840 m'
		);
	});

	it('road-only length differing by 14 % adds nothing', () => {
		expect(routeLabel(route({ meters: 1000, roadOnlyMeters: 1140 }), deOptions)).not.toContain(
			'Straße'
		);
		expect(routeLabel(route({ meters: 1000, roadOnlyMeters: 860 }), deOptions)).not.toContain(
			'Straße'
		);
		expect(showsRoadComparison(1000, null)).toBe(false);
	});

	it('any route with off-road metres shows them', () => {
		expect(routeLabel(route({ offRoadMeters: 340 }), deOptions)).toBe(
			'ca. 1.367 m · ~69 B-Schläuche · ↑197 m · 340 m querfeldein'
		);
		expect(routeLabel(route({ offRoadMeters: 340 }), enOptions)).toContain('340 m off-road');
		// Both parts, in this order: off-road, then the road comparison.
		expect(
			routeLabel(route({ meters: 1367, offRoadMeters: 340, roadOnlyMeters: 1604 }), deOptions)
		).toBe('ca. 1.367 m · ~69 B-Schläuche · ↑197 m · 340 m querfeldein · Straße 1.604 m');
	});

	it('a few metres off-road or a straight fallback line show no off-road part', () => {
		expect(routeLabel(route({ offRoadMeters: 9 }), deOptions)).not.toContain('querfeldein');
		expect(routeLabel(route({ offRoadMeters: 300, routed: false }), deOptions)).not.toContain(
			'querfeldein'
		);
	});

	it('formats metres with the locale thousands separator', () => {
		expect(formatMeters(12345.6, 'de')).toBe('12.346 m');
		expect(formatMeters(12345.6, 'en')).toBe('12,346 m');
	});
});

describe('routeChips: warnings and coverage (plan sections 6.8, 6.11)', () => {
	const keys = (chips: { key: string }[]) => chips.map((c) => c.key);

	it('"Hindernisse (Zäune) unknown" on a route with an off-road stretch, with coverage chips on', () => {
		const offRoad = route({ offRoadMeters: 120 });
		expect(routeChips(offRoad, null, { coverage: true })).toContainEqual(BARRIERS_UNKNOWN_CHIP);
		expect(translator(de)(BARRIERS_UNKNOWN_CHIP.key)).toBe('Hindernisse (Zäune) unbekannt');
		// Not repeated on the list rows, not on road-only or straight lines.
		expect(keys(routeChips(offRoad, null))).not.toContain(BARRIERS_UNKNOWN_CHIP.key);
		expect(keys(routeChips(route(), null, { coverage: true }))).not.toContain(
			BARRIERS_UNKNOWN_CHIP.key
		);
		expect(
			keys(routeChips(route({ offRoadMeters: 120, routed: false }), null, { coverage: true }))
		).not.toContain(BARRIERS_UNKNOWN_CHIP.key);
	});

	it('"map data incomplete" when the basemap coverage is partial', () => {
		const partial = route({ coverage: { basemap: 'partial', dem: 'z14', barriers: 'unknown' } });
		expect(keys(routeChips(partial, null))).toEqual(['route.incomplete']);
		expect(translator(de)('route.incomplete')).toBe('Kartendaten unvollständig');
		expect(keys(routeChips(route(), null))).toEqual([]);
	});

	it('thin building data: the road fallback and the incomplete chip, both visible', () => {
		const thin = route({
			fallback: 'thinBuildings',
			coverage: { basemap: 'partial', dem: 'z14', barriers: 'unknown' }
		});
		expect(keys(routeChips(thin, null))).toEqual([
			'route.fallback.thinBuildings',
			'route.incomplete'
		]);
	});

	it('a cut-off window says so once, not also "incomplete"', () => {
		const cut = route({
			fallback: 'tileCap',
			coverage: { basemap: 'partial', dem: 'z14', barriers: 'unknown' }
		});
		expect(keys(routeChips(cut, null))).toEqual(['route.fallback.tileCap']);
	});

	it('warnings come first, coloured by severity', () => {
		const chips = routeChips(
			route({ notRecommended: true, pressureLevel: 'caution', offRoadMeters: 50 }),
			null,
			{ coverage: true }
		);
		expect(chips.map((c) => c.color)).toEqual(['danger', 'warning', 'medium']);
	});

	it('an unrouted target shows its fallback reason', () => {
		expect(keys(routeChips(null, 'noRoadNearby'))).toEqual(['route.fallback.noRoadNearby']);
	});

	it('every chip key exists in en and de', () => {
		const all = [
			'route.notRecommended',
			'route.checkPressure',
			'route.incomplete',
			BARRIERS_UNKNOWN_CHIP.key,
			'route.crossCountryNote',
			...['cellCap', 'tileCap', 'tooFar', 'noRoadNearby', 'gridUnreached', 'thinBuildings'].map(
				(f) => `route.fallback.${f}`
			)
		];
		for (const key of all) {
			expect(() => translator(en)(key)).not.toThrow();
			expect(() => translator(de)(key)).not.toThrow();
		}
	});
});

describe('crossCountryNoteDue (one-time note)', () => {
	it('is due for the first line with an off-road stretch, never once seen', () => {
		expect(crossCountryNoteDue(120, false)).toBe(true);
		expect(crossCountryNoteDue(120, true)).toBe(false);
		expect(crossCountryNoteDue(5, false)).toBe(false);
		expect(crossCountryNoteDue(0, false)).toBe(false);
	});
});
