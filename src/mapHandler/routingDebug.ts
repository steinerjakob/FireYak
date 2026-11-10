import { GeoPoint, distanceTo } from '@/types/geo';
import type { LinearFeature, ObstacleData, RoadLine } from '@/types/obstacles';
import {
	CELL_CLASS,
	CELL_CLASS_NAME,
	CLIFF_CLASS,
	classifyLanduse,
	classifyRail,
	classifyRoad,
	classifyWaterArea,
	classifyWaterLine,
	isKnownLanduseKind,
	type FeatureEffect
} from '@/mapHandler/hoseCostModel';
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

/** RGBA per `direct` grid cell class: 0 open, 1 road, 2 building core, 3 building fringe. */
const CLASS_COLOR: [number, number, number, number][] = [
	[0, 0, 0, 0],
	[30, 120, 255, 150],
	[220, 40, 40, 170],
	[255, 150, 0, 150]
];

/** RGBA per `optimized` cell class (`CELL_CLASS` of `hoseCostModel.ts`). */
export const OPTIMIZED_CLASS_COLOR: Record<number, [number, number, number, number]> = {
	[CELL_CLASS.UNKNOWN_OPEN]: [0, 0, 0, 0],
	[CELL_CLASS.OPEN]: [140, 200, 90, 90],
	[CELL_CLASS.FOREST]: [20, 110, 40, 130],
	[CELL_CLASS.YARD]: [200, 160, 120, 120],
	[CELL_CLASS.RAIL_LANDUSE]: [150, 110, 160, 130],
	[CELL_CLASS.STREAM]: [60, 200, 230, 170],
	[CELL_CLASS.BUILDING_FRINGE]: [255, 150, 0, 150],
	[CELL_CLASS.BUILDING_CORE]: [220, 40, 40, 170],
	[CELL_CLASS.ROAD]: [30, 120, 255, 160],
	[CELL_CLASS.PATH]: [120, 170, 255, 150],
	[CELL_CLASS.STEPS]: [180, 90, 255, 160],
	[CELL_CLASS.BRIDGE]: [0, 230, 230, 180],
	[CELL_CLASS.BLOCKED]: [10, 10, 10, 190]
};

/**
 * The terrain grid as an RGBA raster, north row first (image order), ready for
 * a canvas `ImageData` and a MapLibre `image` source. A `direct` grid shows its
 * four classes, an `optimized` grid its cost-model classes.
 */
export function costRaster(grid: TerrainGrid): {
	width: number;
	height: number;
	data: Uint8ClampedArray<ArrayBuffer>;
} {
	const data = new Uint8ClampedArray(grid.cols * grid.rows * 4);
	const palette =
		grid.model === 'optimized' ? OPTIMIZED_CLASS_COLOR : (CLASS_COLOR as Record<number, number[]>);
	for (let row = 0; row < grid.rows; row++) {
		const imageRow = grid.rows - 1 - row;
		for (let col = 0; col < grid.cols; col++) {
			const color = palette[grid.cells[row * grid.cols + col]] ?? palette[0];
			data.set(color, (imageRow * grid.cols + col) * 4);
		}
	}
	return { width: grid.cols, height: grid.rows, data };
}

/** Length in meters of a `[lng, lat]` polyline (local equirectangular frame). */
export function lineLengthM(points: [number, number][]): number {
	if (points.length < 2) return 0;
	const mPerDegLng = Math.cos((points[0][1] * Math.PI) / 180) * M_PER_DEG_LNG_EQUATOR;
	let total = 0;
	for (let i = 0; i + 1 < points.length; i++) {
		total += Math.hypot(
			(points[i + 1][0] - points[i][0]) * mPerDegLng,
			(points[i + 1][1] - points[i][1]) * M_PER_DEG_LAT
		);
	}
	return total;
}

/** A landuse kind that the cost model prices as `UNKNOWN_OPEN`. */
export interface UnknownLanduse {
	kind: string;
	areaM2: number;
	/** On the untuned list (seen before, waiting for a factor) rather than new. */
	listed: boolean;
}

/** What the decoded features of a window add up to per cost-model class. */
export interface ClassSummary {
	/** Landuse and water polygons: area in m² per class name (pieces are tile-clipped, so edges add up). */
	areaM2: Record<string, number>;
	/** Roads, rail, water lines and cliffs: length in m per class name, plus `excluded` and `none`. */
	lengthM: Record<string, number>;
	/** Landuse kinds priced as `UNKNOWN_OPEN`, largest first. */
	unknownLanduse: UnknownLanduse[];
}

const effectName = (effect: FeatureEffect): string =>
	typeof effect === 'number' ? CELL_CLASS_NAME[effect] : effect;

/**
 * Sums the decoded obstacles by cost-model class: landuse and water by area,
 * linear features by length. Used by the debug view to list classes and the
 * landuse kinds that still have no factor, and by the fixture specs.
 */
export function classSummary(data: ObstacleData): ClassSummary {
	const areaM2: Record<string, number> = {};
	const lengthM: Record<string, number> = {};
	const unknown = new Map<string, number>();
	const addArea = (name: string, value: number) => {
		areaM2[name] = (areaM2[name] ?? 0) + value;
	};
	const addLength = (name: string, value: number) => {
		lengthM[name] = (lengthM[name] ?? 0) + value;
	};

	for (const area of data.landuse) {
		const cell = classifyLanduse(area.kind);
		addArea(CELL_CLASS_NAME[cell], area.areaM2);
		if (cell === CELL_CLASS.UNKNOWN_OPEN) {
			unknown.set(area.kind, (unknown.get(area.kind) ?? 0) + area.areaM2);
		}
	}
	for (const area of data.waterAreas)
		addArea(CELL_CLASS_NAME[classifyWaterArea(area.kind)], area.areaM2);
	for (const road of data.roads)
		addLength(effectName(classifyRoad(road)), lineLengthM(road.points));
	for (const rail of data.rails)
		addLength(effectName(classifyRail(rail)), lineLengthM(rail.points));
	for (const line of data.waterLines as LinearFeature[]) {
		addLength(
			CELL_CLASS_NAME[classifyWaterLine(line.kind, line.kindDetail)],
			lineLengthM(line.points)
		);
	}
	for (const cliff of data.cliffs)
		addLength(CELL_CLASS_NAME[CLIFF_CLASS], lineLengthM(cliff.points));

	return {
		areaM2,
		lengthM,
		unknownLanduse: [...unknown.entries()]
			.map(([kind, area]) => ({ kind, areaM2: area, listed: isKnownLanduseKind(kind) }))
			.sort((a, b) => b.areaM2 - a.areaM2)
	};
}
