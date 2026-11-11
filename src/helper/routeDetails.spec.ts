import { describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import de from '@/locales/de.json';
import type { HoseRoute } from '@/mapHandler/nearbyRouting';
import type { RouteSegment } from '@/helper/routeProfile';
import { routeLabel } from '@/helper/routeLabel';
import {
	ROUTE_LEGEND,
	badgeTone,
	formatClimb,
	legendEntryOf,
	pumpLineDetailsView,
	routeBadge,
	routeDetailsView,
	routeStretches,
	stretchForRun,
	stretchText,
	type RouteStretch
} from '@/helper/routeDetails';
import { ROUTE_COLOR, ROUTE_STEEP_COLOR, ROUTE_VERY_STEEP_COLOR } from '@/mapHandler/routeLayers';

type Messages = Record<string, unknown>;

/** A minimal `t` over the locale files ("{name}" placeholders); throws on a missing key. */
function translator(messages: Messages) {
	return (key: string, values: Record<string, unknown> = {}) => {
		const text = key
			.split('.')
			.reduce<unknown>((node, part) => (node as Messages)?.[part], messages);
		if (typeof text !== 'string') throw new Error(`missing i18n key ${key}`);
		return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
	};
}

const seg = (
	from: number,
	to: number,
	steep: 0 | 1 | 2,
	offRoad = false,
	gradePct?: number
): RouteSegment => ({ from, to, steep, offRoad, ...(gradePct === undefined ? {} : { gradePct }) });

function route(overrides: Partial<HoseRoute> = {}): HoseRoute {
	return {
		points: [],
		meters: 156,
		planMeters: 155,
		segments: [],
		climbM: 2,
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
		coverage: { basemap: 'full', dem: 'z14', slope: null, barriers: 'unknown' },
		routed: true,
		profile: null,
		cellM: 4,
		...overrides
	};
}

const deText = { t: translator(de), locale: 'de' };
const enText = { t: translator(en), locale: 'en' };
const deOptions = { ...deText, tubeLength: 20, hoseName: 'B' };
const enOptions = { ...enText, tubeLength: 20, hoseName: 'B' };

describe('routeBadge: the short text on the line', () => {
	it('156 m with 20 m hoses: "ca. 156 m · 8 B" / "approx. 156 m · 8 B"', () => {
		expect(routeBadge(156, deOptions)).toBe('ca. 156 m · 8 B');
		expect(routeBadge(156, enOptions)).toBe('approx. 156 m · 8 B');
	});

	it('uses the locale thousands separator and rounds hoses up', () => {
		expect(routeBadge(1367, deOptions)).toBe('ca. 1.367 m · 69 B');
		expect(routeBadge(1367, enOptions)).toBe('approx. 1,367 m · 69 B');
	});

	it('only glyphs the map label font has (Latin-1, no arrows or warning sign)', () => {
		for (const text of [routeBadge(1367, deOptions), routeBadge(5, enOptions)]) {
			for (const ch of text) expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0xff);
		}
	});

	it('shows the same metres as the label line (list = label = card)', () => {
		const r = route({ meters: 1366.6 });
		const metres = (text: string) => text.match(/[\d.]+ m/)![0];
		expect(metres(routeBadge(r.meters, deOptions))).toBe(metres(routeLabel(r, deOptions)));
		const view = routeDetailsView(r, deOptions);
		expect(view.rows.find((row) => row.key === 'length')!.value).toBe('ca. 1.367 m');
	});
});

describe('badgeTone', () => {
	it('danger when not recommended, warning for a pressure check, else normal', () => {
		expect(badgeTone({ notRecommended: true, pressureLevel: 'caution' })).toBe('danger');
		expect(badgeTone({ notRecommended: false, pressureLevel: 'caution' })).toBe('warning');
		expect(badgeTone({ notRecommended: false, pressureLevel: null })).toBe('normal');
	});
});

describe('routeStretches: the coloured and dashed stretches of a line', () => {
	it('one row per steep class run and per off-road run, in order along the line', () => {
		const stretches = routeStretches([
			seg(0, 90, 0, true),
			seg(90, 120, 0),
			seg(120, 135, 1, false, 32),
			seg(135, 300, 0),
			seg(300, 312, 2, false, -55),
			seg(312, 330, 0)
		]);
		expect(stretches.map((s) => [s.kind, s.from, s.to, s.gradePct])).toEqual([
			['offRoad', 0, 90, null],
			['steep', 120, 135, 32],
			['verySteep', 300, 312, -55]
		]);
	});

	it('an amber stretch crossing from road to off-road is one stretch with the steepest grade', () => {
		const stretches = routeStretches([
			seg(0, 50, 0),
			seg(50, 60, 1, false, 28),
			seg(60, 80, 1, true, -41),
			seg(80, 120, 0, true)
		]);
		expect(stretches.map((s) => [s.kind, s.from, s.to, s.gradePct])).toEqual([
			['steep', 50, 80, -41],
			['offRoad', 60, 120, null]
		]);
	});

	it('off-road runs below 10 m (snap legs) are not listed; steep runs always are', () => {
		const stretches = routeStretches([seg(0, 2, 0, true), seg(2, 200, 0), seg(200, 210, 1)]);
		expect(stretches.map((s) => s.kind)).toEqual(['steep']);
		expect(stretches[0].gradePct).toBeNull();
	});

	it('the off-road rows add up to the off-road metres of the label', () => {
		const segments = [seg(0, 40, 0, true), seg(40, 100, 0), seg(100, 130, 1, true, 30)];
		const offRoad = routeStretches(segments).filter((s) => s.kind === 'offRoad');
		const total = segments.filter((s) => s.offRoad).reduce((sum, s) => sum + s.to - s.from, 0);
		expect(offRoad.reduce((sum, s) => sum + s.to - s.from, 0)).toBe(total);
	});

	it('ids are stable per kind and start', () => {
		expect(routeStretches([seg(0, 12.4, 1, false, 30)])[0].id).toBe('steep-0');
	});
});

describe('stretchText', () => {
	const steep: RouteStretch = { id: 's', kind: 'steep', from: 120, to: 135, gradePct: 31.6 };
	it('"Steil: 32 % bergauf auf 15 m" / "Steep: 32 % uphill over 15 m"', () => {
		expect(stretchText(steep, deText)).toBe('Steil: 32 % bergauf auf 15 m');
		expect(stretchText(steep, enText)).toBe('Steep: 32 % uphill over 15 m');
	});

	it('very steep and downhill', () => {
		const red: RouteStretch = { id: 'r', kind: 'verySteep', from: 0, to: 12, gradePct: -55 };
		expect(stretchText(red, enText)).toBe('Very steep: 55 % downhill over 12 m');
		expect(stretchText(red, deText)).toBe('Sehr steil: 55 % bergab auf 12 m');
	});

	it('a grade just over a threshold never reads as the threshold', () => {
		expect(stretchText({ ...steep, gradePct: 25.3 }, enText)).toBe('Steep: 26 % uphill over 15 m');
		const red: RouteStretch = { id: 'r', kind: 'verySteep', from: 0, to: 12, gradePct: -50.2 };
		expect(stretchText(red, enText)).toBe('Very steep: 51 % downhill over 12 m');
	});

	it('off-road and a steep run without a grade', () => {
		const off: RouteStretch = { id: 'o', kind: 'offRoad', from: 10, to: 1225, gradePct: null };
		expect(stretchText(off, deText)).toBe('Querfeldein: 1.215 m');
		expect(stretchText({ ...steep, gradePct: null }, enText)).toBe('Steep over 15 m');
	});
});

describe('stretchForRun: a tapped run focuses its stretch', () => {
	const stretches = routeStretches([
		seg(0, 50, 0),
		seg(50, 60, 1, false, 28),
		seg(60, 80, 1, true, -41),
		seg(80, 120, 0, true),
		seg(120, 200, 0)
	]);
	it('an amber run (solid or dashed) focuses the steep stretch', () => {
		expect(stretchForRun(stretches, seg(60, 80, 1, true))?.id).toBe('steep-50');
		expect(stretchForRun(stretches, seg(50, 60, 1))?.id).toBe('steep-50');
	});
	it('a dashed blue run focuses the off-road stretch; a plain run nothing', () => {
		expect(stretchForRun(stretches, seg(80, 120, 0, true))?.id).toBe('offRoad-60');
		expect(stretchForRun(stretches, seg(120, 200, 0))).toBeNull();
	});
});

describe('legend', () => {
	it('explains solid, dashed, amber and red with ticks in the map colours', () => {
		expect(ROUTE_LEGEND.map((e) => [e.kind, e.color, e.dashed, e.ticks])).toEqual([
			['road', ROUTE_COLOR, false, false],
			['offRoad', ROUTE_COLOR, true, false],
			['steep', ROUTE_STEEP_COLOR, false, false],
			['verySteep', ROUTE_VERY_STEEP_COLOR, false, true]
		]);
		expect(legendEntryOf('verySteep').ticks).toBe(true);
	});
});

describe('routeDetailsView: the card for the selected route', () => {
	it('length, hoses and height difference; no off-road or road-only row without them', () => {
		const view = routeDetailsView(route(), deOptions);
		expect(view.title).toBe('Schlauchweg');
		expect(view.rows.map((r) => [r.key, r.value])).toEqual([
			['length', 'ca. 156 m'],
			['hoses', '8 B-Schläuche'],
			['climb', '↑ 2 m zur Entnahmestelle']
		]);
		expect(view.stretches).toEqual([]);
		expect(view.directionNote).toBe('');
		expect(view.legend).toHaveLength(4);
	});

	it('off-road metres, the road-only length beyond 15 %, and the stretch rows', () => {
		const view = routeDetailsView(
			route({
				meters: 156,
				climbM: -42,
				offRoadMeters: 90,
				roadOnlyMeters: 586,
				segments: [seg(0, 90, 0, true), seg(90, 105, 1, false, 32), seg(105, 155, 0)]
			}),
			enOptions
		);
		expect(view.rows.map((r) => [r.key, r.value])).toEqual([
			['length', 'approx. 156 m'],
			['hoses', '8 B-hoses'],
			['climb', '↓ 42 m to the water source'],
			['offRoad', '90 m'],
			['roadOnly', '586 m']
		]);
		expect(view.stretches.map((s) => s.text)).toEqual([
			'Off-road: 90 m',
			'Steep: 32 % uphill over 15 m'
		]);
		expect(view.directionNote).toMatch(/towards the water source/);
	});

	it('no height row without DEM, and the "elevation data missing" chip', () => {
		const view = routeDetailsView(
			route({
				climbM: null,
				coverage: { basemap: 'full', dem: 'none', slope: null, barriers: 'unknown' }
			}),
			enOptions
		);
		expect(view.rows.map((r) => r.key)).toEqual(['length', 'hoses']);
		expect(view.chips.map((c) => c.text)).toEqual(['Elevation data missing']);
	});

	it('chips: not recommended, check pressure, fences unknown, map data incomplete', () => {
		const view = routeDetailsView(
			route({
				notRecommended: true,
				pressureLevel: 'caution',
				offRoadMeters: 90,
				coverage: { basemap: 'partial', dem: 'z14', slope: 'z14', barriers: 'unknown' }
			}),
			deOptions
		);
		expect(view.chips.map((c) => [c.text, c.color])).toEqual([
			['Nicht empfohlen', 'danger'],
			['Druck prüfen', 'warning'],
			['Kartendaten unvollständig', 'medium'],
			['Hindernisse (Zäune) unbekannt', 'medium']
		]);
	});

	it('a straight fallback line lists no stretches and shows its reason', () => {
		const view = routeDetailsView(
			route({ routed: false, fallback: 'tooFar', segments: [seg(0, 156, 0, true)] }),
			enOptions
		);
		expect(view.stretches).toEqual([]);
		expect(view.chips.map((c) => c.text)).toEqual(['Straight line: too far to route']);
	});
});

describe('pumpLineDetailsView: the card for the pump line', () => {
	it('only stretches and the legend (the panel has length, hoses and chips)', () => {
		const view = pumpLineDetailsView([seg(0, 40, 2, false, 61), seg(40, 400, 0)], deText);
		expect(view.title).toBe('Schlauchleitung');
		expect(view.rows).toEqual([]);
		expect(view.chips).toEqual([]);
		expect(view.stretches.map((s) => s.text)).toEqual(['Sehr steil: 61 % bergauf auf 40 m']);
		expect(view.directionNote).toMatch(/Ansaugstelle/);
	});
});

describe('formatClimb', () => {
	it('arrows with the locale separator, ±0 below 1 m', () => {
		expect(formatClimb(1197.4, 'de')).toBe('↑ 1.197 m');
		expect(formatClimb(-3, 'en')).toBe('↓ 3 m');
		expect(formatClimb(0.4, 'en')).toBe('±0 m');
	});
});

describe('i18n', () => {
	it('every card string exists in en and de', () => {
		const keys = [
			...[
				'title',
				'titlePump',
				'close',
				'length',
				'hoses',
				'climb',
				'climbTowardsSource',
				'offRoad',
				'roadOnly',
				'stretches',
				'noStretches',
				'legend',
				'uphill',
				'downhill',
				'directionSource',
				'directionPump'
			].map((k) => `route.details.${k}`),
			...['steep', 'verySteep', 'steepPlain', 'verySteepPlain', 'offRoad'].map(
				(k) => `route.details.stretch.${k}`
			),
			...ROUTE_LEGEND.map((e) => e.key)
		];
		for (const key of keys) {
			expect(() => translator(en)(key)).not.toThrow();
			expect(() => translator(de)(key)).not.toThrow();
		}
	});
});
