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
import { heightAt, stepGrade, type HeightRaster } from '@/helper/demRaster';

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

/** RGBA per cell class (`CELL_CLASS` of `hoseCostModel.ts`). */
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
 * The cost grid as an RGBA raster, north row first (image order), ready for a
 * canvas `ImageData` and a MapLibre `image` source, one colour per cost-model
 * class.
 */
export function costRaster(grid: TerrainGrid): {
	width: number;
	height: number;
	data: Uint8ClampedArray<ArrayBuffer>;
} {
	const data = new Uint8ClampedArray(grid.cols * grid.rows * 4);
	const palette = OPTIMIZED_CLASS_COLOR;
	for (let row = 0; row < grid.rows; row++) {
		const imageRow = grid.rows - 1 - row;
		for (let col = 0; col < grid.cols; col++) {
			const color = palette[grid.cells[row * grid.cols + col]] ?? palette[0];
			data.set(color, (imageRow * grid.cols + col) * 4);
		}
	}
	return { width: grid.cols, height: grid.rows, data };
}

/** Slope colours: up to 8 %, 25 %, 50 %, 80 %, steeper (the `slopeFactor` knots). */
export const SLOPE_COLOR: [number, number, number, number][] = [
	[0, 0, 0, 0],
	[250, 220, 60, 110],
	[255, 140, 0, 150],
	[220, 40, 40, 170],
	[120, 0, 120, 190]
];

/** Bucket of a grade for {@link SLOPE_COLOR}. */
export function slopeBucket(grade: number): number {
	if (!(grade > 0.08)) return 0;
	if (grade <= 0.25) return 1;
	if (grade <= 0.5) return 2;
	if (grade <= 0.8) return 3;
	return 4;
}

/**
 * The grid's height raster as an RGBA image (north row first). `slope`: per
 * cell the steepest of its four straight steps as the router sees them
 * (per step on z14, over the 24 m baseline on z12), coloured by
 * {@link SLOPE_COLOR}. `height`: grey from the lowest (black) to the highest
 * cell (white). Unknown cells stay clear.
 */
export function heightRasterImage(
	heights: HeightRaster,
	kind: 'slope' | 'height'
): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
	const { cols, rows } = heights;
	const data = new Uint8ClampedArray(cols * rows * 4);
	let lo = Infinity;
	let hi = -Infinity;
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const h = heightAt(heights, c, r);
			if (Number.isNaN(h)) continue;
			lo = Math.min(lo, h);
			hi = Math.max(hi, h);
		}
	}
	for (let r = 0; r < rows; r++) {
		const offset = (rows - 1 - r) * cols;
		for (let c = 0; c < cols; c++) {
			const h = heightAt(heights, c, r);
			if (Number.isNaN(h)) continue;
			let color: [number, number, number, number];
			if (kind === 'height') {
				const v = hi > lo ? Math.round(((h - lo) / (hi - lo)) * 255) : 128;
				color = [v, v, v, 160];
			} else {
				let grade = 0;
				for (const [dx, dy] of [
					[1, 0],
					[-1, 0],
					[0, 1],
					[0, -1]
				]) {
					const g = stepGrade(heights, c, r, dx, dy);
					if (g > grade) grade = g;
				}
				color = SLOPE_COLOR[slopeBucket(grade)];
			}
			data.set(color, (offset + c) * 4);
		}
	}
	return { width: cols, height: rows, data };
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
