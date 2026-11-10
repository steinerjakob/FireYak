import { GeoPoint, distanceTo } from '@/types/geo';
import type { RoadLine } from '@/types/obstacles';
import type { TerrainGrid } from '@/mapHandler/gridRouting';

/**
 * Pure helpers behind the dev-only routing debug view (`/debug/routing`,
 * `src/views/RoutingDebugView.vue`): route statistics, the ring-simulation
 * ratio table and the cost-raster image. The view is a tuning tool; acceptance
 * is by the spec files.
 */

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQUATOR = 111320;

/** Length of a polyline in meters. */
export function pathLength(path: GeoPoint[]): number {
	let total = 0;
	for (let i = 0; i + 1 < path.length; i++) total += distanceTo(path[i], path[i + 1]);
	return total;
}

/** Distance in meters from `p` to the polyline `line` (local equirectangular frame). */
function distanceToLine(p: GeoPoint, line: [number, number][], mPerDegLng: number): number {
	let best = Infinity;
	const px = p.lng * mPerDegLng;
	const py = p.lat * M_PER_DEG_LAT;
	for (let i = 0; i + 1 < line.length; i++) {
		const ax = line[i][0] * mPerDegLng;
		const ay = line[i][1] * M_PER_DEG_LAT;
		const dx = line[i + 1][0] * mPerDegLng - ax;
		const dy = line[i + 1][1] * M_PER_DEG_LAT - ay;
		const lenSq = dx * dx + dy * dy;
		const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
		best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
	}
	return best;
}

/**
 * Share (0..1) of the route length that lies within `toleranceM` of a road
 * centerline. The route is sampled every `stepM` meters. 0 for an empty route.
 */
export function onRoadShare(
	path: GeoPoint[],
	roads: RoadLine[],
	toleranceM = 6,
	stepM = 5
): number {
	if (path.length < 2 || roads.length === 0) return 0;
	const mPerDegLng = Math.cos((path[0].lat * Math.PI) / 180) * M_PER_DEG_LNG_EQUATOR;
	const slackLng = toleranceM / mPerDegLng;
	const slackLat = toleranceM / M_PER_DEG_LAT;
	let sampled = 0;
	let onRoad = 0;
	for (let i = 0; i + 1 < path.length; i++) {
		const a = path[i];
		const b = path[i + 1];
		const steps = Math.max(1, Math.ceil(distanceTo(a, b) / stepM));
		for (let s = 0; s < steps; s++) {
			const f = (s + 0.5) / steps;
			const p = { lng: a.lng + (b.lng - a.lng) * f, lat: a.lat + (b.lat - a.lat) * f };
			sampled++;
			const near = roads.some(
				(road) =>
					p.lng >= road.bbox[0] - slackLng &&
					p.lng <= road.bbox[2] + slackLng &&
					p.lat >= road.bbox[1] - slackLat &&
					p.lat <= road.bbox[3] + slackLat &&
					distanceToLine(p, road.points, mPerDegLng) <= toleranceM
			);
			if (near) onRoad++;
		}
	}
	return sampled === 0 ? 0 : onRoad / sampled;
}

export interface RingSample {
	radius: number;
	/** Routed length / straight line, or `null` when the mode found no route. */
	ratio: number | null;
}

export interface RatioRow {
	radius: number;
	/** Positions that produced a route. */
	count: number;
	/** Positions without a route. */
	unrouted: number;
	median: number | null;
	worst: number | null;
}

/** Median and worst ratio per ring radius, radii ascending. */
export function ratioTable(samples: RingSample[]): RatioRow[] {
	const radii = [...new Set(samples.map((s) => s.radius))].sort((a, b) => a - b);
	return radii.map((radius) => {
		const own = samples.filter((s) => s.radius === radius);
		const ratios = own
			.map((s) => s.ratio)
			.filter((r): r is number => r !== null)
			.sort((a, b) => a - b);
		return {
			radius,
			count: ratios.length,
			unrouted: own.length - ratios.length,
			median: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null,
			worst: ratios.length ? ratios[ratios.length - 1] : null
		};
	});
}

/** RGBA per grid cell class: 0 open, 1 road, 2 building core, 3 building fringe. */
const CLASS_COLOR: [number, number, number, number][] = [
	[0, 0, 0, 0],
	[30, 120, 255, 150],
	[220, 40, 40, 170],
	[255, 150, 0, 150]
];

/**
 * The terrain grid as an RGBA raster, north row first (image order), ready for
 * a canvas `ImageData` and a MapLibre `image` source. Later phases add their
 * cost classes here.
 */
export function costRaster(grid: TerrainGrid): {
	width: number;
	height: number;
	data: Uint8ClampedArray<ArrayBuffer>;
} {
	const data = new Uint8ClampedArray(grid.cols * grid.rows * 4);
	for (let row = 0; row < grid.rows; row++) {
		const imageRow = grid.rows - 1 - row;
		for (let col = 0; col < grid.cols; col++) {
			const color = CLASS_COLOR[grid.cells[row * grid.cols + col]] ?? CLASS_COLOR[0];
			data.set(color, (imageRow * grid.cols + col) * 4);
		}
	}
	return { width: grid.cols, height: grid.rows, data };
}
