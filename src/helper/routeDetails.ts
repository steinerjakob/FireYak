import type { HoseRoute } from '@/mapHandler/nearbyRouting';
import { STEEP_GRADE, VERY_STEEP_GRADE, type RouteSegment } from '@/helper/routeProfile';
import {
	BARRIERS_UNKNOWN_CHIP,
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
 * The card for the pump line: its off-road metres (≥ {@link OFF_ROAD_SHOWN_M};
 * the panel has no separate line for them), the stretches and the legend.
 * Length, hoses, height difference and chips are in the pump panel already.
 */
export function pumpLineDetailsView(
	segments: RouteSegment[],
	options: TextOptions,
	offRoadMeters = 0
): RouteDetailsView {
	const rows: RouteDetailRow[] =
		offRoadMeters >= OFF_ROAD_SHOWN_M
			? [
					{
						key: 'offRoad',
						label: options.t('route.details.offRoad'),
						value: formatMeters(offRoadMeters, options.locale)
					}
				]
			: [];
	return {
		title: options.t('route.details.titlePump'),
		rows,
		chips: [],
		...stretchesAndLegend(segments, options, 'route.details.directionPump')
	};
}

/*
 * The route section of a bottom sheet (phone layout, plan §6.8): a compact
 * header row that expands to the details content of the card.
 */

/** Which line a sheet section shows: the selected route or the pump line. */
export type RouteSectionHost = 'selected' | 'pump';

/**
 * Header line of the selected route's sheet section, e.g. "ca. 828 m · 42
 * B-Schläuche · ↑13 m": estimate, hoses and the signed height difference
 * towards the water source (left out below 1 m or without heights). DOM text,
 * so the arrows are fine (unlike the badge on the map).
 */
export function routeSummary(
	route: Pick<HoseRoute, 'meters' | 'climbM'>,
	options: HoseOptions
): string {
	const { t, locale } = options;
	const parts = [
		t('route.estimate', { distance: formatMeters(route.meters, locale) }),
		`${hoseCount(route.meters, options.tubeLength)} ${options.hoseName}-${t('pumpCalculation.pump.tubes')}`
	];
	if (route.climbM !== null && Math.abs(route.climbM) >= 1) {
		parts.push(`${route.climbM > 0 ? '↑' : '↓'}${formatMeters(Math.abs(route.climbM), locale)}`);
	}
	return parts.join(' · ');
}

/**
 * The one chip the collapsed header shows: "not recommended", else "check
 * pressure", else a fallback (straight line, roads only, …); coverage notes
 * (fences unknown, incomplete data, no heights) wait for the expanded view.
 * `more` counts the chips the header leaves out.
 */
export function headerChip<C extends RouteChip>(chips: C[]): { chip: C | null; more: number } {
	const chip =
		chips.find((c) => c.color === 'danger') ??
		chips.find((c) => c.color === 'warning') ??
		chips.find((c) => c.key.startsWith('route.fallback.')) ??
		null;
	return { chip, more: chips.length - (chip ? 1 : 0) };
}

/**
 * Header line of the pump line's sheet section: the stretches by kind,
 * steepest first, and the off-road metres, e.g. "1× sehr steil · 2× steil ·
 * 427 m querfeldein" (length, hoses, height and chips are in the pump panel
 * already), or "no coloured stretches". Without off-road metres (below
 * {@link OFF_ROAD_SHOWN_M}) the off-road stretches are counted instead.
 */
export function stretchSummary(
	stretches: Pick<RouteStretch, 'kind'>[],
	options: TextOptions,
	offRoadMeters = 0
): string {
	const kinds: StretchKind[] = ['verySteep', 'steep', 'offRoad'];
	const parts = kinds
		.map((kind) => ({ kind, count: stretches.filter((s) => s.kind === kind).length }))
		.filter((part) => part.count > 0)
		.map((part) =>
			part.kind === 'offRoad' && offRoadMeters >= OFF_ROAD_SHOWN_M
				? options.t('route.offRoad', { distance: formatMeters(offRoadMeters, options.locale) })
				: options.t(`route.section.count.${part.kind}`, { count: part.count })
		);
	return parts.length > 0 ? parts.join(' · ') : options.t('route.section.noStretches');
}

/** The warnings of the pump line the chips are built from (`PumpLineWarnings`). */
export interface PumpChipWarnings {
	notRecommended: boolean;
	pressureLevel: string | null;
	fallbacks: readonly string[];
	incomplete: boolean;
	offRoadMeters: number;
}

/**
 * The chips of the pump line: not recommended, check pressure, the legs'
 * fallbacks, then the coverage notes (incomplete map data, fences unknown
 * when the line runs off-road).
 */
export function pumpLineChips(warnings: PumpChipWarnings): RouteChip[] {
	const chips: RouteChip[] = [];
	if (warnings.notRecommended) chips.push({ key: 'route.notRecommended', color: 'danger' });
	if (warnings.pressureLevel === 'caution') {
		chips.push({ key: 'route.checkPressure', color: 'warning' });
	}
	for (const fallback of warnings.fallbacks) {
		chips.push({ key: `route.fallback.${fallback}`, color: 'medium' });
	}
	if (warnings.incomplete) chips.push({ key: 'route.incomplete', color: 'medium' });
	if (warnings.offRoadMeters >= OFF_ROAD_SHOWN_M) chips.push(BARRIERS_UNKNOWN_CHIP);
	return chips;
}

/** The low-priority coverage notes: what the map data may lack, not a warning about the line. */
const COVERAGE_CHIP_KEYS: readonly string[] = [
	BARRIERS_UNKNOWN_CHIP.key,
	'route.incomplete',
	'route.noElevation'
];

export function isCoverageChip(chip: Pick<RouteChip, 'key'>): boolean {
	return COVERAGE_CHIP_KEYS.includes(chip.key);
}

/**
 * Splits chips for the pump panel (owner feedback): the warnings (not
 * recommended, check pressure, fallbacks such as a straight line) stay
 * visible right below the numbers; the coverage notes move into the line's
 * route section on phones.
 */
export function splitCoverageChips<C extends Pick<RouteChip, 'key'>>(
	chips: C[]
): { warnings: C[]; coverage: C[] } {
	return {
		warnings: chips.filter((chip) => !isCoverageChip(chip)),
		coverage: chips.filter(isCoverageChip)
	};
}

/** Expanded (true) or collapsed per sheet section; collapsed at the start of a session. */
export type RouteSectionState = Record<RouteSectionHost, boolean>;

export const INITIAL_SECTION_STATE: RouteSectionState = { selected: false, pump: false };

/**
 * `toggle`: the header was tapped; `focus`: a coloured or dashed run of the
 * line was tapped on the map (opens the section on its stretch). Nothing
 * collapses a section on its own: a new route keeps what the user chose.
 */
export type RouteSectionAction = 'toggle' | 'focus';

export function sectionStateAfter(
	state: RouteSectionState,
	host: RouteSectionHost,
	action: RouteSectionAction
): RouteSectionState {
	const expanded = action === 'focus' ? true : !state[host];
	return expanded === state[host] ? state : { ...state, [host]: expanded };
}

/** A sheet below this breakpoint grows when its route section expands. */
export const SECTION_SHEET_BREAKPOINT = 0.5;

/**
 * The breakpoint a sheet grows to when its route section expands: the first
 * of its breakpoints at or above {@link SECTION_SHEET_BREAKPOINT}, or `null`
 * when it is that high already (or has no such breakpoint). Never shrinks.
 */
export function sheetGrowTarget(breakpoints: readonly number[], current: number): number | null {
	if (current >= SECTION_SHEET_BREAKPOINT - 1e-6) return null;
	const target = [...breakpoints]
		.sort((a, b) => a - b)
		.find((b) => b >= SECTION_SHEET_BREAKPOINT - 1e-6 && b > current);
	return target ?? null;
}

/*
 * The nearby list (owner feedback): the selected entry's row expands in place
 * to the route details (opened with its arrow button, a tap on the row only
 * selects it), instead of a section on top of the list that scrolls away.
 */

/** What happened to a nearby row; see `rowExpansionAfter`. */
export type RowAction =
	| { type: 'select'; ref: string }
	| { type: 'toggle'; ref: string }
	| { type: 'stretch'; ref: string };

/**
 * The row that is expanded after `action` (only one row at a time, and only
 * ever the selected one):
 * - `select` (a tap on a row, a marker, a link) never expands: a new
 *   selection starts collapsed and the previous row collapses; selecting the
 *   row that already is selected keeps its state;
 * - `toggle` (the arrow button of the selected row) expands or collapses it;
 * - `stretch` (a tap on a coloured run of the map line) expands the row.
 * A toggle or stretch for a row that is not the selected one changes nothing.
 */
export function rowExpansionAfter(
	expanded: string | null,
	selected: string | null,
	action: RowAction
): string | null {
	switch (action.type) {
		case 'select':
			return action.ref === selected ? expanded : null;
		case 'toggle':
			if (action.ref !== selected) return expanded;
			return expanded === action.ref ? null : action.ref;
		case 'stretch':
			return action.ref === selected ? action.ref : expanded;
	}
}

/**
 * What an expanded row shows: `loading` while its route is computed (or not
 * started yet), `updating` while a drawn route of this row is recomputed
 * (the details stay, with a small indicator), `ready`, or `none` when the
 * attempt for this row ended without a line.
 */
export type RowRouteState = 'loading' | 'updating' | 'ready' | 'none';

export interface SelectedRouteStatus {
	/** The marker the last finished request was for (with or without a line). */
	routeRef: string | null;
	/** Whether a line is drawn for `routeRef`. */
	hasRoute: boolean;
	/** The marker a running request is for. */
	pendingRef: string | null;
}

export function rowRouteState(row: string, status: SelectedRouteStatus): RowRouteState {
	const drawn = status.routeRef === row && status.hasRoute;
	if (status.pendingRef === row) return drawn ? 'updating' : 'loading';
	if (status.routeRef === row) return drawn ? 'ready' : 'none';
	return 'loading';
}
