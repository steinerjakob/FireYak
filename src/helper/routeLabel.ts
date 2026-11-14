import type { HoseRoute, RouteFallback } from '@/mapHandler/nearbyRouting';

/**
 * Texts for a hose route (plan §6.8): the label line and the warning and
 * coverage chips shown on the nearby list, the map label and the pump panel,
 * and when the one-time cross-country note is due. Pure: the caller passes its
 * i18n `t` and locale.
 */

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface RouteChip {
	/** i18n key of the chip text. */
	key: string;
	color: 'danger' | 'warning' | 'medium';
}

/** Off-road metres below this are not shown (label part, fences chip, one-time note). */
export const OFF_ROAD_SHOWN_M = 10;

/** Road-only length is shown when it differs from the route by more than this share. */
export const ROAD_COMPARE_SHARE = 0.15;

/** The coverage chip for fences and walls, which the map data does not have (until phase 8). */
export const BARRIERS_UNKNOWN_CHIP: RouteChip = { key: 'route.barriersUnknown', color: 'medium' };

/**
 * Warning, fallback and coverage chips for a route (or for a target that was
 * not routed). The fences chip appears only with `coverage` (the map label
 * and the pump panel; repeating it on every list row adds nothing) and only
 * for a route with an off-road stretch: on roads and paths fences do not
 * matter.
 */
export function routeChips(
	route: HoseRoute | null,
	fallback: RouteFallback | null,
	options: { coverage?: boolean } = {}
): RouteChip[] {
	const chips: RouteChip[] = [];
	if (route?.notRecommended) chips.push({ key: 'route.notRecommended', color: 'danger' });
	if (route?.pressureLevel === 'caution')
		chips.push({ key: 'route.checkPressure', color: 'warning' });
	const reason = route?.fallback ?? fallback;
	if (reason) chips.push({ key: `route.fallback.${reason}`, color: 'medium' });
	// Per-layer coverage (plan §6.9): the route was solved without part of the
	// map data or without heights; a silent recompute removes the chip once
	// the data arrives.
	const basemap = route?.coverage.basemap;
	if ((basemap === 'partial' || basemap === 'none') && reason !== 'tileCap') {
		chips.push({ key: 'route.incomplete', color: 'medium' });
	}
	if (route?.routed && route.coverage.dem === 'none') {
		chips.push({ key: 'route.noElevation', color: 'medium' });
	}
	if (
		options.coverage &&
		route?.routed &&
		route.coverage.barriers === 'unknown' &&
		route.offRoadMeters >= OFF_ROAD_SHOWN_M
	) {
		chips.push(BARRIERS_UNKNOWN_CHIP);
	}
	return chips;
}

/** Metres with the locale's thousands separator, e.g. "1,367 m" / "1.367 m". */
export function formatMeters(meters: number, locale: string): string {
	return `${new Intl.NumberFormat(locale).format(Math.round(meters))} m`;
}

/** True when the road-only length differs from the route by more than {@link ROAD_COMPARE_SHARE}. */
export function showsRoadComparison(meters: number, roadOnlyMeters: number | null): boolean {
	return roadOnlyMeters !== null && Math.abs(roadOnlyMeters - meters) > ROAD_COMPARE_SHARE * meters;
}

/**
 * The label line, always marked as an estimate, e.g. "ca. 1.367 m · ~69
 * B-Schläuche · ↑197 m · 340 m querfeldein · Straße 1.504 m". Parts without
 * data are left out.
 */
export function routeLabel(
	route: HoseRoute,
	options: {
		t: Translate;
		locale: string;
		tubeLength: number;
		hoseName: string;
		/**
		 * `plusMinus` writes the climb as "+197 m" / "-42 m": the map's label font
		 * (Protomaps Noto Sans glyphs) has no arrow glyphs. Default: ↑ / ↓.
		 */
		climbSigns?: 'arrows' | 'plusMinus';
	}
): string {
	const { t, locale } = options;
	const parts = [
		t('route.estimate', { distance: formatMeters(route.meters, locale) }),
		`~${Math.ceil(route.meters / options.tubeLength)} ${options.hoseName}-${t('pumpCalculation.pump.tubes')}`
	];
	if (route.climbM !== null && Math.abs(route.climbM) >= 1) {
		const [up, down] = options.climbSigns === 'plusMinus' ? ['+', '-'] : ['↑', '↓'];
		parts.push(`${route.climbM > 0 ? up : down}${formatMeters(Math.abs(route.climbM), locale)}`);
	}
	if (route.routed && route.offRoadMeters >= OFF_ROAD_SHOWN_M) {
		parts.push(t('route.offRoad', { distance: formatMeters(route.offRoadMeters, locale) }));
	}
	if (showsRoadComparison(route.meters, route.roadOnlyMeters)) {
		parts.push(t('route.roadOnly', { distance: formatMeters(route.roadOnlyMeters!, locale) }));
	}
	return parts.join(' · ');
}

/**
 * Whether the one-time "check cross-country stretches on site" note is due:
 * not yet seen, and the shown line has an off-road stretch.
 */
export function crossCountryNoteDue(offRoadMeters: number, seen: boolean): boolean {
	return !seen && offRoadMeters >= OFF_ROAD_SHOWN_M;
}
