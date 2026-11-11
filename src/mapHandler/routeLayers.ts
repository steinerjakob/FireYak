import type maplibregl from 'maplibre-gl';
import type { GeoPoint } from '@/types/geo';
import { splitByRuns, type RouteSegment } from '@/helper/routeProfile';

/**
 * MapLibre layers for a hose route (plan §6.8): two visual channels, dash =
 * off-road and colour = steepness, plus small tick marks across very steep
 * runs. One GeoJSON source per line holds one `LineString` per run with
 * `{ offRoad, steep }`; two line layers split it by `offRoad` (data-driven dash
 * arrays are not reliable), both coloured by `steep`.
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
	return [`${prefix}-layer`, `${prefix}-offroad-layer`, `${prefix}-ticks-layer`];
}

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
	const [onRoad, offRoad, ticks] = routeLayerIds(prefix);
	const isLine: maplibregl.ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
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
		properties: { offRoad: run.offRoad, steep: run.steep }
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
