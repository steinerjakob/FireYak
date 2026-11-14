import type maplibregl from 'maplibre-gl';
import type { GeoPoint } from '@/types/geo';
import { splitByRuns, type RouteSegment } from '@/helper/routeProfile';

/**
 * MapLibre layers for a hose route (plan §6.8): two visual channels, dash =
 * off-road and colour = steepness, plus small tick marks across very steep
 * runs. One GeoJSON source per line holds one `LineString` per run with
 * `{ offRoad, steep, from, to }`; two line layers split it by `offRoad`
 * (data-driven dash arrays are not reliable), both coloured by `steep`. A wide
 * translucent layer under them highlights the stretch the details card is
 * focused on, and an invisible wide layer on top takes the taps. The badge
 * layer shows the short "ca. 156 m · 8 B" on a pill.
 */

export const ROUTE_COLOR = '#3388ff';
export const ROUTE_STEEP_COLOR = '#f59e0b';
export const ROUTE_VERY_STEEP_COLOR = '#d32f2f';
const TICK_IMAGE = 'route-steep-tick';
/** Width of a route line, and its brief width while pulsing (plan §6.9). */
export const ROUTE_LINE_WIDTH = 3;
const PULSE_LINE_WIDTH = 7;
/** Duration of the pulse after a silent recompute. */
export const ROUTE_PULSE_MS = 600;

const lineColor: maplibregl.ExpressionSpecification = [
	'match',
	['get', 'steep'],
	2,
	ROUTE_VERY_STEEP_COLOR,
	1,
	ROUTE_STEEP_COLOR,
	ROUTE_COLOR
];

/** Registers the tick image (a short bar across the line) once per style. */
function ensureTickImage(map: maplibregl.Map): void {
	if (map.hasImage(TICK_IMAGE)) return;
	const width = 3;
	const height = 15;
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = 0xd3;
		data[i * 4 + 1] = 0x2f;
		data[i * 4 + 2] = 0x2f;
		data[i * 4 + 3] = 255;
	}
	map.addImage(TICK_IMAGE, { width, height, data });
}

/** Ids of the layers {@link addRouteLayers} creates for one source. */
export function routeLayerIds(prefix: string): string[] {
	return [
		`${prefix}-layer`,
		`${prefix}-offroad-layer`,
		`${prefix}-ticks-layer`,
		routeHighlightLayerId(prefix),
		routeHitLayerId(prefix)
	];
}

/** The layer that highlights the focused stretch. */
export function routeHighlightLayerId(prefix: string): string {
	return `${prefix}-highlight-layer`;
}

/** The invisible wide layer that takes taps on the line. */
export function routeHitLayerId(prefix: string): string {
	return `${prefix}-hit-layer`;
}

/** Matches no run: the highlight layer's filter while nothing is focused. */
const NO_HIGHLIGHT: maplibregl.FilterSpecification = ['==', ['get', 'from'], -1];

/** Width of the tap target along the line (CSS px). */
const HIT_LINE_WIDTH = 24;

/**
 * Adds the on-road, off-road and tick layers for `source` (which must exist).
 * `visible` sets the initial visibility.
 */
export function addRouteLayers(
	map: maplibregl.Map,
	source: string,
	prefix: string,
	visible = true
): void {
	ensureTickImage(map);
	const visibility = visible ? 'visible' : 'none';
	const [onRoad, offRoad, ticks, highlight, hit] = routeLayerIds(prefix);
	const isLine: maplibregl.ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
	map.addLayer({
		id: highlight,
		type: 'line',
		source,
		filter: NO_HIGHLIGHT,
		layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
		paint: { 'line-color': lineColor, 'line-width': 14, 'line-opacity': 0.4 }
	});
	map.addLayer({
		id: onRoad,
		type: 'line',
		source,
		filter: ['all', isLine, ['!=', ['get', 'offRoad'], true]],
		layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
		paint: { 'line-color': lineColor, 'line-width': ROUTE_LINE_WIDTH }
	});
	map.addLayer({
		id: offRoad,
		type: 'line',
		source,
		filter: ['all', isLine, ['==', ['get', 'offRoad'], true]],
		layout: { visibility, 'line-join': 'round' },
		paint: { 'line-color': lineColor, 'line-width': ROUTE_LINE_WIDTH, 'line-dasharray': [2, 1.5] }
	});
	map.addLayer({
		id: ticks,
		type: 'symbol',
		source,
		filter: ['all', isLine, ['==', ['get', 'steep'], 2]],
		layout: {
			visibility,
			'symbol-placement': 'line',
			'symbol-spacing': 12,
			'icon-image': TICK_IMAGE,
			'icon-rotation-alignment': 'map',
			'icon-allow-overlap': true,
			'icon-ignore-placement': true
		}
	});
	map.addLayer({
		id: hit,
		type: 'line',
		source,
		filter: isLine,
		layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
		// Nearly transparent rather than 0, so it is certainly hit-tested.
		paint: { 'line-color': ROUTE_COLOR, 'line-width': HIT_LINE_WIDTH, 'line-opacity': 0.01 }
	});
}

/**
 * Highlights the runs of the stretch `range` (in metres along the line, the
 * runs' `from`/`to` properties), or nothing with `null`.
 */
export function setRouteHighlight(
	map: maplibregl.Map,
	prefix: string,
	range: { from: number; to: number } | null
): void {
	const layer = routeHighlightLayerId(prefix);
	if (!map.getLayer(layer)) return;
	map.setFilter(
		layer,
		range
			? [
					'all',
					['==', ['geometry-type'], 'LineString'],
					['>=', ['get', 'from'], range.from - 0.01],
					['<=', ['get', 'to'], range.to + 0.01]
				]
			: NO_HIGHLIGHT
	);
}

/** One `LineString` feature per run of the route. */
export function routeRunFeatures(
	points: GeoPoint[],
	segments: RouteSegment[]
): GeoJSON.Feature<GeoJSON.LineString>[] {
	const runs =
		segments.length > 0
			? splitByRuns(points, segments)
			: [
					{
						coordinates: points.map((p) => [p.lng, p.lat] as [number, number]),
						offRoad: false,
						steep: 0
					}
				];
	return runs.map((run) => ({
		type: 'Feature',
		geometry: { type: 'LineString', coordinates: run.coordinates },
		properties: {
			offRoad: run.offRoad,
			steep: run.steep,
			...('from' in run ? { from: run.from, to: run.to } : {})
		}
	}));
}

/**
 * A short width pulse of the route's line layers: the line was recomputed
 * silently after late map data (no camera move, plan §6.9).
 */
export function pulseRouteLayers(map: maplibregl.Map, prefix: string): void {
	const [onRoad, offRoad] = routeLayerIds(prefix);
	const set = (width: number) => {
		for (const layer of [onRoad, offRoad]) {
			if (map.getLayer(layer)) map.setPaintProperty(layer, 'line-width', width);
		}
	};
	set(PULSE_LINE_WIDTH);
	setTimeout(() => set(ROUTE_LINE_WIDTH), ROUTE_PULSE_MS / 2);
}

/** Badge colours per theme: pill fill and text; the border shows the tone. */
const BADGE_THEMES = {
	light: { fill: [255, 255, 255], text: '#1a4fb4' },
	dark: { fill: [32, 36, 42], text: '#d6e4ff' }
} as const;
const BADGE_TONES = {
	normal: [0x33, 0x88, 0xff],
	warning: [0xf5, 0x9e, 0x0b],
	danger: [0xd3, 0x2f, 0x2f]
} as const;
export type BadgeTheme = keyof typeof BADGE_THEMES;

/** Image name of the badge pill for a theme and tone. */
export function badgeImageName(theme: BadgeTheme, tone: keyof typeof BADGE_TONES): string {
	return `route-badge-${theme}-${tone}`;
}

/**
 * Registers the stretchable pill images (rounded rectangle with a 1.5 px
 * border, drawn at pixel ratio 2) for one theme, once per style.
 */
function ensureBadgeImages(map: maplibregl.Map, theme: BadgeTheme): void {
	const size = 40;
	const radius = 16;
	const border = 3;
	const { fill } = BADGE_THEMES[theme];
	for (const [tone, stroke] of Object.entries(BADGE_TONES) as [
		keyof typeof BADGE_TONES,
		readonly number[]
	][]) {
		const name = badgeImageName(theme, tone);
		if (map.hasImage(name)) continue;
		const data = new Uint8Array(size * size * 4);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				// Signed distance to the rounded rectangle (negative inside).
				const qx = Math.abs(x + 0.5 - size / 2) - (size / 2 - radius);
				const qy = Math.abs(y + 0.5 - size / 2) - (size / 2 - radius);
				const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
				const d = outside + Math.min(Math.max(qx, qy), 0) - radius;
				const alpha = Math.max(0, Math.min(1, 0.5 - d));
				const strokeMix = Math.max(0, Math.min(1, d + border + 0.5));
				const i = (y * size + x) * 4;
				for (let c = 0; c < 3; c++) {
					data[i + c] = Math.round(fill[c] * (1 - strokeMix) + stroke[c] * strokeMix);
				}
				data[i + 3] = Math.round(alpha * 255);
			}
		}
		map.addImage(
			name,
			{ width: size, height: size, data },
			{
				pixelRatio: 2,
				stretchX: [[radius, size - radius]],
				stretchY: [[radius, size - radius]],
				content: [radius - 4, 8, size - radius + 4, size - 8]
			}
		);
	}
}

/**
 * Adds the badge layer: a pill with the text of the `badge` property on the
 * source's Point feature, bordered by its `tone` (`normal` | `warning` |
 * `danger`). Screen-sized, so it reads at every zoom.
 */
export function addRouteBadgeLayer(
	map: maplibregl.Map,
	source: string,
	id: string,
	theme: BadgeTheme,
	visible = true
): void {
	ensureBadgeImages(map, theme);
	map.addLayer({
		id,
		type: 'symbol',
		source,
		filter: ['==', ['geometry-type'], 'Point'],
		layout: {
			visibility: visible ? 'visible' : 'none',
			'text-field': ['get', 'badge'],
			'text-font': ['Noto Sans Medium'],
			'text-size': 13,
			'text-offset': [0, -1.6],
			'icon-image': ['concat', `route-badge-${theme}-`, ['coalesce', ['get', 'tone'], 'normal']],
			'icon-text-fit': 'both',
			'icon-text-fit-padding': [2, 6, 2, 6],
			// The single badge must always render, even over other symbols.
			'text-allow-overlap': true,
			'text-ignore-placement': true,
			'icon-allow-overlap': true,
			'icon-ignore-placement': true
		},
		paint: { 'text-color': BADGE_THEMES[theme].text }
	});
}
