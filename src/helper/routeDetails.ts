import type { HoseRoute } from '@/mapHandler/nearbyRouting';
import { STEEP_GRADE, VERY_STEEP_GRADE, type RouteSegment } from '@/helper/routeProfile';
import {
	OFF_ROAD_SHOWN_M,
	formatMeters,
	routeChips,
	showsRoadComparison,
	type RouteChip
} from '@/helper/routeLabel';
import { ROUTE_COLOR, ROUTE_STEEP_COLOR, ROUTE_VERY_STEEP_COLOR } from '@/mapHandler/routeLayers';

/**
 * The route details card (plan §6.8): the short badge on the line, the rows,
 * chips and coloured stretches of the card, and its legend. Pure: the caller
 * passes its i18n `t` and locale; the card and the map layers only render
 * what this module builds.
 */

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface TextOptions {
	t: Translate;
	locale: string;
}

export interface HoseOptions extends TextOptions {
	tubeLength: number;
	hoseName: string;
}

/** Number of hoses of the given length for a line, rounded up. */
export function hoseCount(meters: number, tubeLength: number): number {
	return Math.ceil(meters / tubeLength);
}

/**
 * The badge on the line, e.g. "ca. 156 m · 8 B": the estimate and the number
 * of hoses, nothing else (the rest is in the card). Only glyphs the map's
 * label font has (no arrows, no warning sign).
 */
export function routeBadge(meters: number, options: HoseOptions): string {
	const distance = options.t('route.estimate', { distance: formatMeters(meters, options.locale) });
	return `${distance} · ${hoseCount(meters, options.tubeLength)} ${options.hoseName}`;
}

/** Border tone of the badge: red when not recommended, amber when the pressure needs a check. */
export type BadgeTone = 'normal' | 'warning' | 'danger';

export function badgeTone(route: Pick<HoseRoute, 'notRecommended' | 'pressureLevel'>): BadgeTone {
	if (route.notRecommended) return 'danger';
	if (route.pressureLevel === 'caution') return 'warning';
	return 'normal';
}

export type StretchKind = 'steep' | 'verySteep' | 'offRoad';

/** One coloured or dashed stretch of a line, in metres along the drawn (2D) polyline. */
export interface RouteStretch {
	/** Stable within one route: kind and start, e.g. `steep-120`. */
	id: string;
	kind: StretchKind;
	from: number;
	to: number;
	/** Steepest grade in percent, signed along the line; `null` off-road or without DEM. */
	gradePct: number | null;
}

/**
 * The stretches the card lists: every steep (amber) and very steep (red) run,
 * and every off-road (dashed) run of at least {@link OFF_ROAD_SHOWN_M}, in
 * order along the line. Consecutive runs of one steep class are one stretch
 * even where off-road changes, and consecutive off-road runs are one stretch
 * whatever their steepness, so a stretch matches what the eye sees as one
 * colour or one dash.
 */
export function routeStretches(segments: RouteSegment[]): RouteStretch[] {
	const out: RouteStretch[] = [];
	const merge = (
		kind: StretchKind,
		pick: (s: RouteSegment) => boolean,
		minMeters: number,
		withGrade: boolean
	) => {
		let i = 0;
		while (i < segments.length) {
			if (!pick(segments[i])) {
				i++;
				continue;
			}
			let j = i;
			let grade: number | null = null;
			while (j < segments.length && pick(segments[j])) {
				const g = segments[j].gradePct;
				if (withGrade && g !== undefined && (grade === null || Math.abs(g) > Math.abs(grade))) {
					grade = g;
				}
				j++;
			}
			const from = segments[i].from;
			const to = segments[j - 1].to;
			if (to - from >= minMeters - 1e-6) {
				out.push({ id: `${kind}-${Math.round(from)}`, kind, from, to, gradePct: grade });
			}
			i = j;
		}
	};
	merge('verySteep', (s) => s.steep === 2, 0, true);
	merge('steep', (s) => s.steep === 1, 0, true);
	merge('offRoad', (s) => s.offRoad, OFF_ROAD_SHOWN_M, false);
	const order: Record<StretchKind, number> = { verySteep: 0, steep: 1, offRoad: 2 };
	return out.sort((a, b) => a.from - b.from || order[a.kind] - order[b.kind]);
}

/** One line of the stretch list, e.g. "Steep: 32 % uphill over 15 m". */
export function stretchText(stretch: RouteStretch, options: TextOptions): string {
	const { t, locale } = options;
	const distance = formatMeters(stretch.to - stretch.from, locale);
	if (stretch.kind === 'offRoad') return t('route.details.stretch.offRoad', { distance });
	const key = stretch.kind === 'verySteep' ? 'verySteep' : 'steep';
	if (stretch.gradePct === null) return t(`route.details.stretch.${key}Plain`, { distance });
	return t(`route.details.stretch.${key}`, {
		// Never round down onto the threshold: a run over 25 % never reads "25 %".
		grade: Math.max(
			Math.round(Math.abs(stretch.gradePct)),
			stretch.kind === 'verySteep' ? VERY_STEEP_GRADE * 100 + 1 : STEEP_GRADE * 100 + 1
		),
		direction: t(stretch.gradePct >= 0 ? 'route.details.uphill' : 'route.details.downhill'),
		distance
	});
}

/**
 * The stretch a tapped map run belongs to (the run's `from`/`to`/`steep`/
 * `offRoad` feature properties): a coloured run focuses its steep stretch,
 * a dashed blue run its off-road stretch; `null` for a plain run.
 */
export function stretchForRun(
	stretches: RouteStretch[],
	run: Pick<RouteSegment, 'from' | 'to' | 'steep' | 'offRoad'>
): RouteStretch | null {
	const kind: StretchKind | null =
		run.steep === 2 ? 'verySteep' : run.steep === 1 ? 'steep' : run.offRoad ? 'offRoad' : null;
	if (!kind) return null;
	const mid = (run.from + run.to) / 2;
	return stretches.find((s) => s.kind === kind && s.from <= mid && mid <= s.to) ?? null;
}

/** How a legend entry's line sample is drawn. */
export interface LegendEntry {
	kind: 'road' | StretchKind;
	color: string;
	dashed: boolean;
	ticks: boolean;
	/** i18n key of the explanation. */
	key: string;
}

/** The four looks of a route line (plan §6.8), in the order the card explains them. */
export const ROUTE_LEGEND: readonly LegendEntry[] = [
	{ kind: 'road', color: ROUTE_COLOR, dashed: false, ticks: false, key: 'route.legend.road' },
	{ kind: 'offRoad', color: ROUTE_COLOR, dashed: true, ticks: false, key: 'route.legend.offRoad' },
	{
		kind: 'steep',
		color: ROUTE_STEEP_COLOR,
		dashed: false,
		ticks: false,
		key: 'route.legend.steep'
	},
	{
		kind: 'verySteep',
		color: ROUTE_VERY_STEEP_COLOR,
		dashed: false,
		ticks: true,
		key: 'route.legend.verySteep'
	}
];

/** The legend entry (colour, dash, ticks) a stretch row is marked with. */
export function legendEntryOf(kind: StretchKind): LegendEntry {
	return ROUTE_LEGEND.find((entry) => entry.kind === kind)!;
}

export interface RouteDetailRow {
	key: 'length' | 'hoses' | 'climb' | 'offRoad' | 'roadOnly';
	label: string;
	value: string;
}

export interface RouteDetailsView {
	title: string;
	rows: RouteDetailRow[];
	chips: (RouteChip & { text: string })[];
	stretches: (RouteStretch & { text: string })[];
	/** Says which way "uphill" is; empty when no steep stretch is listed. */
	directionNote: string;
	legend: (LegendEntry & { text: string })[];
}

/** "↑ 12 m" / "↓ 42 m" / "±0 m" (the card's font has the arrows). */
export function formatClimb(climbM: number, locale: string): string {
	if (Math.abs(climbM) < 1) return '±0 m';
	return `${climbM > 0 ? '↑' : '↓'} ${formatMeters(Math.abs(climbM), locale)}`;
}

function stretchesAndLegend(
	segments: RouteSegment[],
	options: TextOptions,
	directionKey: string
): Pick<RouteDetailsView, 'stretches' | 'directionNote' | 'legend'> {
	const stretches = routeStretches(segments).map((s) => ({ ...s, text: stretchText(s, options) }));
	const graded = stretches.some((s) => s.kind !== 'offRoad' && s.gradePct !== null);
	return {
		stretches,
		directionNote: graded ? options.t(directionKey) : '',
		legend: ROUTE_LEGEND.map((entry) => ({ ...entry, text: options.t(entry.key) }))
	};
}

/**
 * The card for the selected route (nearby list, marker line): length and
 * hoses, height difference towards the water source, off-road metres, the
 * road-only length when it differs by more than 15 %, the warning and
 * coverage chips, the stretches and the legend. The numbers are the label's:
 * `route.meters` everywhere.
 */
export function routeDetailsView(route: HoseRoute, options: HoseOptions): RouteDetailsView {
	const { t, locale } = options;
	const rows: RouteDetailRow[] = [
		{
			key: 'length',
			label: t('route.details.length'),
			value: t('route.estimate', { distance: formatMeters(route.meters, locale) })
		},
		{
			key: 'hoses',
			label: t('route.details.hoses'),
			value: `${hoseCount(route.meters, options.tubeLength)} ${options.hoseName}-${t('pumpCalculation.pump.tubes')}`
		}
	];
	if (route.climbM !== null) {
		rows.push({
			key: 'climb',
			label: t('route.details.climb'),
			value: t('route.details.climbTowardsSource', { climb: formatClimb(route.climbM, locale) })
		});
	}
	if (route.routed && route.offRoadMeters >= OFF_ROAD_SHOWN_M) {
		rows.push({
			key: 'offRoad',
			label: t('route.details.offRoad'),
			value: formatMeters(route.offRoadMeters, locale)
		});
	}
	if (showsRoadComparison(route.meters, route.roadOnlyMeters)) {
		rows.push({
			key: 'roadOnly',
			label: t('route.details.roadOnly'),
			value: formatMeters(route.roadOnlyMeters!, locale)
		});
	}
	const chips = routeChips(route, null, { coverage: true }).map((chip) => ({
		...chip,
		text: t(chip.key)
	}));
	return {
		title: t('route.details.title'),
		rows,
		chips,
		...stretchesAndLegend(
			route.routed ? route.segments : [],
			options,
			'route.details.directionSource'
		)
	};
}

/**
 * The card for the pump line: only its stretches and the legend. Length,
 * hoses, height difference and chips are in the pump panel already.
 */
export function pumpLineDetailsView(
	segments: RouteSegment[],
	options: TextOptions
): RouteDetailsView {
	return {
		title: options.t('route.details.titlePump'),
		rows: [],
		chips: [],
		...stretchesAndLegend(segments, options, 'route.details.directionPump')
	};
}
