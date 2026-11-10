import type { HoseRoute, RouteFallback } from '@/mapHandler/nearbyRouting';

/**
 * Texts for a hose route (plan §6.8): the label line and the warning chips
 * shown on the nearby list, the map label and the pump panel. Pure: the
 * caller passes its i18n `t` and locale.
 */

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface RouteChip {
	/** i18n key of the chip text. */
	key: string;
	color: 'danger' | 'warning' | 'medium';
}

/** Warning and fallback chips for a route (or for a target that was not routed). */
export function routeChips(route: HoseRoute | null, fallback: RouteFallback | null): RouteChip[] {
	const chips: RouteChip[] = [];
	if (route?.notRecommended) chips.push({ key: 'route.notRecommended', color: 'danger' });
	if (route?.pressureLevel === 'caution')
		chips.push({ key: 'route.checkPressure', color: 'warning' });
	const reason = route?.fallback ?? fallback;
	if (reason) chips.push({ key: `route.fallback.${reason}`, color: 'medium' });
	if (route?.coverage.basemap === 'partial' && reason !== 'tileCap') {
		chips.push({ key: 'route.incomplete', color: 'medium' });
	}
	return chips;
}

/** Metres with the locale's thousands separator, e.g. "1,367 m" / "1.367 m". */
export function formatMeters(meters: number, locale: string): string {
	return `${new Intl.NumberFormat(locale).format(Math.round(meters))} m`;
}

/** Road-only length is shown when it differs from the route by more than this share. */
export const ROAD_COMPARE_SHARE = 0.15;

/**
 * The label line, e.g. "ca. 1,367 m · ~69 B-hoses · ↑197 m · 340 m off-road
 * · road 1,504 m". Parts without data are left out.
 */
export function routeLabel(
	route: HoseRoute,
	options: { t: Translate; locale: string; tubeLength: number; hoseName: string }
): string {
	const { t, locale } = options;
	const parts = [
		t('route.estimate', { distance: formatMeters(route.meters, locale) }),
		`~${Math.ceil(route.meters / options.tubeLength)} ${options.hoseName}-${t('pumpCalculation.pump.tubes')}`
	];
	if (route.climbM !== null && Math.abs(route.climbM) >= 1) {
		parts.push(`${route.climbM > 0 ? '↑' : '↓'}${formatMeters(Math.abs(route.climbM), locale)}`);
	}
	if (route.routed && route.offRoadMeters >= 10) {
		parts.push(t('route.offRoad', { distance: formatMeters(route.offRoadMeters, locale) }));
	}
	if (
		route.roadOnlyMeters !== null &&
		Math.abs(route.roadOnlyMeters - route.meters) > ROAD_COMPARE_SHARE * route.meters
	) {
		parts.push(t('route.roadOnly', { distance: formatMeters(route.roadOnlyMeters, locale) }));
	}
	return parts.join(' · ');
}
