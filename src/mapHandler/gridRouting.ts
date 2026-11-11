import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';
import { BuildingPolygon, ObstacleData } from '@/types/obstacles';
import { RouteResult } from '@/mapHandler/roadRouting';
import { segmentIntersectsPolygon } from '@/helper/polygonGeometry';
import { nearestPointOnOutline, outlineLines } from '@/helper/areaShore';
import { CellHeap } from '@/mapHandler/cellHeap';
import {
	M_PER_DEG_LAT,
	gridFrameFor,
	gridX,
	gridY,
	rasterizeCostClasses,
	traverseSegment
} from '@/mapHandler/costGrid';
import {
	BUILDING_CORE_ESCAPE_FACTOR,
	CELL_CLASS,
	CLASS_FACTOR as COST_CLASS_FACTOR,
	ESCAPE_RADIUS_M,
	isOnRoadClass,
	slopeFactor,
	type CellClass
} from '@/mapHandler/hoseCostModel';
import {
	FINE_ROUTING_DEM_ZOOM,
	baselineCells,
	heightAtGrid,
	stepGrade,
	type HeightRaster,
	type RasterFrame
} from '@/helper/demRaster';

/**
 * Cost-grid routing for hose laying (plan §6.3-§6.6), the one cost model of
 * `hoseCostModel.ts`:
 *
 * - the classes and factors of `hoseCostModel.ts` rasterised by `costGrid.ts`; blocked cells (water, heavy rail, motorway,
 *   cliffs, military ground, building cores) are impassable except building
 *   cores within the escape radius of an endpoint; a step costs the mean of the
 *   two cells' factors, so A to B costs exactly what B to A does; single paths
 *   use A* with the octile heuristic, the nearby list a one-to-many Dijkstra
 *   with early exit; smoothing is cost-aware. With a height raster
 *   ({@link setGridHeights}) every step is also priced by its slope
 *   (`slopeFactor`, plan §6.4): capped at ×1.3 between road, path and steps
 *   cells, 1.0 between bridge cells, never a hard block. A bridge connects only
 *   to roads, paths, steps and other bridge cells.
 */

/**
 * Default (and coarsest) grid resolution: 8 m ≈ alley width. The nearby list
 * and road-mode leg pricing use it; single paths choose 4 or 6 m by window
 * size (plan §6.10, `chooseCellSize` in `hoseRoutingCore.ts`).
 */
export const GRID_CELL_M = 8;
/** Hard cap on grid size (plan §6.10); larger windows fall back to graph routing. */
export const MAX_GRID_CELLS = 400_000;
/**
 * Cost-aware smoothing (plan §6.6): a shortcut may cost at most this share
 * more than the cell path it replaces, plus {@link SMOOTH_SLACK_M}.
 */
export const SMOOTH_COST_TOLERANCE = 1.02;
export const SMOOTH_SLACK_M = 2;
/** Douglas–Peucker tolerance after string pulling (m). */
export const SIMPLIFY_TOLERANCE_M = 1.5;

const M_PER_DEG_LNG_EQUATOR = 111320;

/** The routing cost grid (cell classes of `hoseCostModel.ts`). */
export interface TerrainGrid {
	west: number;
	south: number;
	mPerDegLng: number;
	cols: number;
	rows: number;
	/** Cell edge in metres (plan §6.10: 4, 6 or 8). */
	cellM: number;
	/** Cell class per cell (row-major): a {@link CellClass} of `hoseCostModel.ts`. */
	cells: Uint8Array;
	/** Source footprints, kept for exact checks during path smoothing. */
	buildings: BuildingPolygon[];
	/** Lazily built bucket index over `buildings` for the exact segment test. */
	buildingIndex?: {
		bcols: number;
		brows: number;
		buckets: Map<number, number[]>;
		stamp: Uint32Array;
		mark: number;
	};
	/** Per cell and direction: 0 unknown, 1 clear, 2 the step touches a footprint. */
	stepClips?: Uint8Array;
	/** Memoised Dijkstra state of the last origin cell (see {@link solveTerrain}). */
	solve?: SolveState;
	/** Heights at the cell centres (plan §6.4); `null`/absent = no DEM, routing without slope. */
	heights?: HeightRaster | null;
	/**
	 * Specs only: off-road steps steeper than this grade are impassable (the
	 * plan's "blocking at 60 % / 80 %" comparison). The app never sets it.
	 */
	slopeBlockGrade?: number;
}

function toRadians(deg: number): number {
	return (deg * Math.PI) / 180;
}

/**
 * Builds the routing cost grid over `bounds` (classes of
 * `hoseCostModel.ts`, rasterised by `costGrid.ts`) with `cellM` cells, or
 * `null` above `maxCells`. The caller passes only the roads that take part in
 * routing.
 */
export function buildOptimizedGrid(
	obstacles: ObstacleData,
	bounds: GeoBounds,
	cellM = GRID_CELL_M,
	maxCells = MAX_GRID_CELLS
): TerrainGrid | null {
	const frame = gridFrameFor(bounds, cellM, maxCells);
	if (!frame) return null;
	const raster = rasterizeCostClasses(obstacles, frame);
	return {
		west: raster.west,
		south: raster.south,
		mPerDegLng: raster.mPerDegLng,
		cols: raster.cols,
		rows: raster.rows,
		cellM: raster.cellM,
		cells: raster.cells,
		buildings: obstacles.buildings
	};
}

/** The placement of a grid, for the height raster ({@link setGridHeights}). */
export function gridFrameOf(grid: TerrainGrid): RasterFrame {
	return {
		west: grid.west,
		south: grid.south,
		mPerDegLng: grid.mPerDegLng,
		cols: grid.cols,
		rows: grid.rows,
		cellM: grid.cellM
	};
}

/**
 * Attaches the height raster of {@link gridFrameOf} to the grid
 * (`null` = no DEM). Drops a memoised field, which was priced without it.
 */
export function setGridHeights(grid: TerrainGrid, heights: HeightRaster | null): void {
	if (heights && (heights.cols !== grid.cols || heights.rows !== grid.rows)) {
		throw new Error('Height raster does not match the grid');
	}
	grid.heights = heights;
	grid.solve = undefined;
}

/**
 * The class that governs a step's slope factor (plan §6.4): `BRIDGE` between
 * two bridge cells (factor 1.0), `ROAD` between any two road, path, steps or
 * bridge cells (capped at ×1.3), else none (the full curve). Symmetric in u, v.
 */
function slopeClass(cu: number, cv: number): CellClass | undefined {
	if (cu === CELL_CLASS.BRIDGE && cv === CELL_CLASS.BRIDGE) return CELL_CLASS.BRIDGE;
	if (isOnRoadClass(cu as CellClass) && isOnRoadClass(cv as CellClass)) return CELL_CLASS.ROAD;
	return undefined;
}

/**
 * True when a step between classes `cu` and `cv` leaves a bridge sideways: a
 * bridge cell next to anything but a road, path, steps or bridge cell (the
 * ground below a bridge is not on it). Symmetric.
 */
function leavesBridge(cu: number, cv: number): boolean {
	const bu = cu === CELL_CLASS.BRIDGE;
	const bv = cv === CELL_CLASS.BRIDGE;
	if (bu === bv) return false;
	return !isOnRoadClass((bu ? cv : cu) as CellClass);
}

/**
 * Slope factor of the step from cell u = (ux, uy) by (dx, dy), `Infinity` when
 * a spec's blocking grade forbids it; 1 without heights or where they are
 * unknown.
 */
function stepSlopeFactor(
	grid: TerrainGrid,
	ux: number,
	uy: number,
	dx: number,
	dy: number,
	cu: number,
	cv: number
): number {
	const heights = grid.heights;
	if (!heights) return 1;
	const grade = stepGrade(heights, ux, uy, dx, dy);
	if (Number.isNaN(grade)) return 1;
	const cls = slopeClass(cu, cv);
	if (grid.slopeBlockGrade !== undefined && cls === undefined && grade > grid.slopeBlockGrade) {
		return Infinity;
	}
	return slopeFactor(grade, cls);
}

/** A grid route target: one point, or a pond shore (every cell next to its outline). */
export type GridGoal =
	| { kind: 'point'; point: GeoPoint }
	| { kind: 'shore'; outline: GeoJSON.Geometry };

/** A smoothed terrain route. `meters` is the length of `points` (the one number shown). */
export interface GridRoute {
	points: GeoPoint[];
	meters: number;
	/** Priced cost of the cell chain (ranking only). */
	cost: number;
	/** Where the route ends: the target point, or the chosen shore point. */
	endpoint: GeoPoint;
	/** The cell the cell chain ends in (for a shore: the goal cell that won). */
	cell: number;
}

/** Solved single-source terrain field; answers distance/path queries per target. */
export interface TerrainSolve {
	/** Cell-chain cost and length to `target` (no smoothing). */
	distanceTo(target: GeoPoint): RouteResult | null;
	/** Smoothed display polyline to `target`, from the true origin to the true target. */
	pathTo(target: GeoPoint): GeoPoint[] | null;
	/** Smoothed route to a point or shore goal; `null` when unreached or off-grid. */
	routeTo(goal: GridGoal): GridRoute | null;
	/** Settles the whole field (no early exit); for the debug view and specs. */
	solveAll(): void;
}

/** Counts field set-ups, Dijkstra and A* (specs check the memoisation with it). */
export const terrainSolveStats = { solves: 0, astar: 0 };

function cellOf(grid: TerrainGrid, p: GeoPoint): number | null {
	const c = Math.floor(((p.lng - grid.west) * grid.mPerDegLng) / grid.cellM);
	const r = Math.floor(((p.lat - grid.south) * M_PER_DEG_LAT) / grid.cellM);
	if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) return null;
	return r * grid.cols + c;
}

function cellCenter(grid: TerrainGrid, cellIdx: number): GeoPoint {
	const c = cellIdx % grid.cols;
	const r = Math.floor(cellIdx / grid.cols);
	return {
		lng: grid.west + ((c + 0.5) * grid.cellM) / grid.mPerDegLng,
		lat: grid.south + ((r + 0.5) * grid.cellM) / M_PER_DEG_LAT
	};
}

/** Class of the cell under `p` (`null` off-grid); for the off-road display and specs. */
export function cellClassAt(grid: TerrainGrid, p: GeoPoint): number | null {
	const cell = cellOf(grid, p);
	return cell === null ? null : grid.cells[cell];
}

// ---------------------------------------------------------------------------
// Escape zone: building cores near an endpoint stay reachable
// ---------------------------------------------------------------------------

/**
 * Cells within {@link ESCAPE_RADIUS_M} (centre distance) of an endpoint, and
 * the endpoint cells themselves. A building core in the zone costs
 * {@link BUILDING_CORE_ESCAPE_FACTOR} instead of being blocked (a hydrant in a
 * courtyard or at a wall); an endpoint cell of any impassable class does too,
 * so a point on a blocked cell can still start or end a route. Other blocked
 * cells (water, rail) stay blocked in the zone.
 */
export interface EscapeZone {
	cells: Set<number>;
	endpoints: Set<number>;
}

export function escapeZone(grid: TerrainGrid, points: GeoPoint[]): EscapeZone {
	const zone: EscapeZone = { cells: new Set(), endpoints: new Set() };
	addToEscapeZone(grid, zone, points);
	return zone;
}

function addToEscapeZone(grid: TerrainGrid, zone: EscapeZone, points: GeoPoint[]): void {
	const reach = Math.ceil(ESCAPE_RADIUS_M / grid.cellM) + 1;
	for (const p of points) {
		const cell = cellOf(grid, p);
		if (cell === null) continue;
		zone.endpoints.add(cell);
		const cx = cell % grid.cols;
		const cy = Math.floor(cell / grid.cols);
		for (let y = Math.max(0, cy - reach); y <= Math.min(grid.rows - 1, cy + reach); y++) {
			for (let x = Math.max(0, cx - reach); x <= Math.min(grid.cols - 1, cx + reach); x++) {
				const c = y * grid.cols + x;
				if (distanceTo(p, cellCenter(grid, c)) <= ESCAPE_RADIUS_M) zone.cells.add(c);
			}
		}
	}
}

/** Cost factor of entering `cell`; `Infinity` = impassable. */
export function optimizedCellFactor(grid: TerrainGrid, zone: EscapeZone, cell: number): number {
	const cls = grid.cells[cell] as CellClass;
	const factor = COST_CLASS_FACTOR[cls];
	if (factor !== Infinity) return factor;
	if (cls === CELL_CLASS.BUILDING_CORE && zone.cells.has(cell)) return BUILDING_CORE_ESCAPE_FACTOR;
	if (zone.endpoints.has(cell)) return BUILDING_CORE_ESCAPE_FACTOR;
	return Infinity;
}

const isBuildingClass = (grid: TerrainGrid, cell: number) =>
	grid.cells[cell] === CELL_CLASS.BUILDING_CORE || grid.cells[cell] === CELL_CLASS.BUILDING_FRINGE;

// ---------------------------------------------------------------------------
// Line tests
// ---------------------------------------------------------------------------

/**
 * Priced cost of the straight segment a→b over the cells it
 * passes through (supercover; length in each cell × its factor), or `Infinity`
 * when it touches an impassable cell or leaves a bridge sideways. Cells outside
 * the grid count as `UNKNOWN_OPEN`. Impassable cells within `lenientEndM` of
 * `b` are priced as `UNKNOWN_OPEN` (a leg ending ON a pond's shore touches the
 * pond's own cells). With `withSlope` and a height raster, each piece is also
 * priced by the grade of the line over one cell (z14) or the 24 m baseline
 * (z12) around its midpoint, with the step rules' road cap and bridge factor,
 * so a shortcut is never cheaper for ignoring the slope its cell path paid.
 */
export function lineCost(
	grid: TerrainGrid,
	a: GeoPoint,
	b: GeoPoint,
	zone: EscapeZone = NO_ESCAPE,
	lenientEndM = 0,
	withSlope = true
): number {
	const length = distanceTo(a, b);
	if (length === 0) return 0;
	const frame = grid;
	const outside = COST_CLASS_FACTOR[CELL_CLASS.UNKNOWN_OPEN];
	const ax = gridX(frame, a.lng);
	const ay = gridY(frame, a.lat);
	const bx = gridX(frame, b.lng);
	const by = gridY(frame, b.lat);
	const heights = withSlope ? grid.heights : null;
	// Grade window (in units of t along the segment) around a piece's midpoint.
	const windowCells = heights
		? heights.zoom >= FINE_ROUTING_DEM_ZOOM
			? 1
			: baselineCells(grid.cellM)
		: 0;
	const halfT = (windowCells * grid.cellM) / length / 2;
	let cost = 0;
	let prevClass = -1;
	let prevCell = -1;
	traverseSegment(frame, ax, ay, bx, by, (cell, t0, t1) => {
		let factor = cell < 0 ? outside : optimizedCellFactor(grid, zone, cell);
		if (factor === Infinity && (1 - t0) * length <= lenientEndM) factor = outside;
		const cls = cell < 0 ? CELL_CLASS.UNKNOWN_OPEN : grid.cells[cell];
		if (
			prevClass !== -1 &&
			leavesBridge(prevClass, cls) &&
			!zone.endpoints.has(cell) &&
			!zone.endpoints.has(prevCell)
		) {
			factor = Infinity;
		}
		if (factor === Infinity) {
			cost = Infinity;
			return false;
		}
		prevClass = cls;
		prevCell = cell;
		if (t1 <= t0) return;
		let slope = 1;
		if (heights) {
			const tm = (t0 + t1) / 2;
			const h0 = heightAtGrid(
				heights,
				ax + (bx - ax) * (tm - halfT),
				ay + (by - ay) * (tm - halfT)
			);
			const h1 = heightAtGrid(
				heights,
				ax + (bx - ax) * (tm + halfT),
				ay + (by - ay) * (tm + halfT)
			);
			const grade = Math.abs(h1 - h0) / (windowCells * grid.cellM);
			if (!Number.isNaN(grade)) {
				const governing =
					cls === CELL_CLASS.BRIDGE
						? CELL_CLASS.BRIDGE
						: isOnRoadClass(cls as CellClass)
							? CELL_CLASS.ROAD
							: undefined;
				if (
					grid.slopeBlockGrade !== undefined &&
					governing === undefined &&
					grade > grid.slopeBlockGrade
				) {
					cost = Infinity;
					return false;
				}
				slope = slopeFactor(grade, governing);
			}
		}
		cost += (t1 - t0) * length * factor * slope;
	});
	return cost;
}

const NO_ESCAPE: EscapeZone = { cells: new Set(), endpoints: new Set() };

/** Bucket edge of the building index used by the exact segment test. */
const BUCKET_M = 32;

/** Buckets building indexes by the {@link BUCKET_M} squares their bbox touches. */
function buildBuildingIndex(grid: TerrainGrid): void {
	const bcols = Math.max(1, Math.ceil((grid.cols * grid.cellM) / BUCKET_M));
	const brows = Math.max(1, Math.ceil((grid.rows * grid.cellM) / BUCKET_M));
	const buckets = new Map<number, number[]>();
	grid.buildings.forEach((building, index) => {
		const [west, south, east, north] = building.bbox;
		const [c0, r0] = bucketOf(grid, west, south, bcols, brows);
		const [c1, r1] = bucketOf(grid, east, north, bcols, brows);
		for (let r = r0; r <= r1; r++) {
			for (let c = c0; c <= c1; c++) {
				const key = r * bcols + c;
				const list = buckets.get(key);
				if (list) list.push(index);
				else buckets.set(key, [index]);
			}
		}
	});
	grid.buildingIndex = {
		bcols,
		brows,
		buckets,
		stamp: new Uint32Array(grid.buildings.length),
		mark: 0
	};
}

function bucketOf(
	grid: TerrainGrid,
	lng: number,
	lat: number,
	bcols: number,
	brows: number
): [number, number] {
	const c = Math.floor(((lng - grid.west) * grid.mPerDegLng) / BUCKET_M);
	const r = Math.floor(((lat - grid.south) * M_PER_DEG_LAT) / BUCKET_M);
	return [Math.min(Math.max(c, 0), bcols - 1), Math.min(Math.max(r, 0), brows - 1)];
}

/**
 * True when the straight segment a→b touches no real footprint: an exact
 * segment/edge intersection test plus containment (plan §6.6), over the
 * buildings bucketed near the segment.
 */
function exactLineOfSight(grid: TerrainGrid, a: GeoPoint, b: GeoPoint): boolean {
	if (!grid.buildingIndex) buildBuildingIndex(grid);
	const index = grid.buildingIndex!;
	const [c0, r0] = bucketOf(
		grid,
		Math.min(a.lng, b.lng),
		Math.min(a.lat, b.lat),
		index.bcols,
		index.brows
	);
	const [c1, r1] = bucketOf(
		grid,
		Math.max(a.lng, b.lng),
		Math.max(a.lat, b.lat),
		index.bcols,
		index.brows
	);
	index.mark = (index.mark + 1) >>> 0;
	if (index.mark === 0) {
		index.stamp.fill(0);
		index.mark = 1;
	}
	const pa: [number, number] = [a.lng, a.lat];
	const pb: [number, number] = [b.lng, b.lat];
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			const list = index.buckets.get(r * index.bcols + c);
			if (!list) continue;
			for (const i of list) {
				if (index.stamp[i] === index.mark) continue;
				index.stamp[i] = index.mark;
				if (segmentIntersectsPolygon(pa, pb, grid.buildings[i])) return false;
			}
		}
	}
	return true;
}

/** Length of a polyline in metres. */
function polylineMeters(points: GeoPoint[]): number {
	let total = 0;
	for (let i = 0; i < points.length - 1; i++) total += distanceTo(points[i], points[i + 1]);
	return total;
}

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

/**
 * Greedy string pulling over the cell chain, starting from the TRUE origin and
 * ending at the TRUE target (the chain's first and last cell centres are
 * replaced before smoothing, so the end segments are checked too). From each
 * kept vertex it jumps to the farthest later vertex for which `visible`
 * holds. When not even the next vertex is visible (an endpoint inside a
 * footprint), the step is taken anyway so the path always exists. Returns the
 * kept chain indexes.
 */
function pullString(count: number, visible: (i: number, j: number) => boolean): number[] {
	const kept = [0];
	let i = 0;
	while (i < count - 1) {
		let next = i + 1;
		for (let j = count - 1; j > i + 1; j--) {
			if (visible(i, j)) {
				next = j;
				break;
			}
		}
		kept.push(next);
		i = next;
	}
	return kept;
}

/**
 * Douglas–Peucker over `indexes` (positions into `points`) with a gate: the
 * vertices between two kept ones are dropped only when they all lie within
 * `toleranceM` of the chord AND `valid(from, to)` accepts the chord, so a
 * removal can never break the tests the string pulling applied. Returns the
 * kept indexes (always the first and the last).
 */
export function simplifyGated(
	points: GeoPoint[],
	indexes: number[],
	toleranceM: number,
	valid: (from: number, to: number) => boolean
): number[] {
	if (indexes.length <= 2) return [...indexes];
	const keep = new Uint8Array(indexes.length);
	keep[0] = 1;
	keep[indexes.length - 1] = 1;
	const stack: [number, number][] = [[0, indexes.length - 1]];
	while (stack.length > 0) {
		const [s, e] = stack.pop()!;
		if (e - s < 2) continue;
		const a = points[indexes[s]];
		const b = points[indexes[e]];
		let worst = -1;
		let worstD = -1;
		for (let k = s + 1; k < e; k++) {
			const d = pointSegmentDistanceM(points[indexes[k]], a, b);
			if (d > worstD) {
				worstD = d;
				worst = k;
			}
		}
		if (worstD <= toleranceM && valid(indexes[s], indexes[e])) continue;
		keep[worst] = 1;
		stack.push([s, worst], [worst, e]);
	}
	return indexes.filter((_, k) => keep[k] === 1);
}

/** Distance in metres from `p` to segment a–b (local equirectangular frame). */
function pointSegmentDistanceM(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
	const kx = Math.cos(toRadians(p.lat)) * M_PER_DEG_LNG_EQUATOR;
	const ax = (a.lng - p.lng) * kx;
	const ay = (a.lat - p.lat) * M_PER_DEG_LAT;
	const bx = (b.lng - p.lng) * kx;
	const by = (b.lat - p.lat) * M_PER_DEG_LAT;
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	const t = lenSq > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;
	return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Cost-aware string pulling (plan §6.6). A shortcut i→j is
 * accepted only when its priced line cost is at most the cell path's cost
 * between i and j × {@link SMOOTH_COST_TOLERANCE} + {@link SMOOTH_SLACK_M}, it
 * touches no impassable cell (blocked, non-escape core), and it touches no
 * building edge (exact test). `pathCost[k]` is the priced cost from the true
 * origin to chain vertex k. A gated Douglas–Peucker pass follows.
 */
function smoothChainOptimized(
	grid: TerrainGrid,
	zone: EscapeZone,
	chain: number[],
	pathCost: number[],
	start: GeoPoint,
	end: GeoPoint
): GeoPoint[] {
	if (chain.length <= 1) return [start, end];
	const points = chain.map((cell) => cellCenter(grid, cell));
	points[0] = start;
	points[points.length - 1] = end;
	const visible = (i: number, j: number) =>
		shortcutAllowed(grid, zone, points[i], points[j], pathCost[j] - pathCost[i]);
	const kept = pullString(points.length, visible);
	return simplifyGated(points, kept, SIMPLIFY_TOLERANCE_M, visible).map((k) => points[k]);
}

/** The three tests of a cost-aware shortcut (plan §6.6). */
export function shortcutAllowed(
	grid: TerrainGrid,
	zone: EscapeZone,
	a: GeoPoint,
	b: GeoPoint,
	pathCostAB: number
): boolean {
	const cost = lineCost(grid, a, b, zone);
	if (cost > pathCostAB * SMOOTH_COST_TOLERANCE + SMOOTH_SLACK_M) return false;
	return exactLineOfSight(grid, a, b);
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** Cells next to (and on) an outline's lines that a route may end in. */
export function shoreGoalCells(
	grid: TerrainGrid,
	outline: GeoJSON.Geometry,
	zone: EscapeZone
): Set<number> {
	const onLine = new Set<number>();
	for (const line of outlineLines(outline)) {
		for (let i = 0; i < line.length; i++) {
			const a = line[i];
			const b = line[Math.min(i + 1, line.length - 1)];
			const lengthM = Math.hypot((b[0] - a[0]) * grid.mPerDegLng, (b[1] - a[1]) * M_PER_DEG_LAT);
			const steps = Math.max(1, Math.ceil(lengthM / (grid.cellM / 4)));
			for (let s = 0; s <= steps; s++) {
				const f = s / steps;
				const cell = cellOf(grid, { lng: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f });
				if (cell !== null) onLine.add(cell);
			}
		}
	}
	// Every passable cell (the pond's own water cells stay blocked, so the goal
	// ring lies on the dry side).
	const usable = (idx: number) => optimizedCellFactor(grid, zone, idx) !== Infinity;
	const goals = new Set<number>();
	for (const cell of onLine) {
		const cx = cell % grid.cols;
		const cy = Math.floor(cell / grid.cols);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (x < 0 || x >= grid.cols || y < 0 || y >= grid.rows) continue;
				const idx = y * grid.cols + x;
				if (usable(idx)) goals.add(idx);
			}
		}
	}
	return goals;
}

/**
 * True when the straight step between the centres of neighbouring cells `u`
 * and `v` (direction `k` = (dy+1)*3 + (dx+1)) touches a footprint. Cached per
 * cell and direction on the grid; both directions of a step share the answer.
 */
function stepClipsBuilding(grid: TerrainGrid, u: number, v: number, k: number): boolean {
	if (!grid.stepClips) grid.stepClips = new Uint8Array(grid.cols * grid.rows * 9);
	const cache = grid.stepClips;
	const known = cache[u * 9 + k];
	if (known !== 0) return known === 2;
	const clips = !exactLineOfSight(grid, cellCenter(grid, u), cellCenter(grid, v));
	cache[u * 9 + k] = clips ? 2 : 1;
	cache[v * 9 + (8 - k)] = clips ? 2 : 1;
	return clips;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Resumable single-source search state (early exit + memoisation, plan §6.5). */
interface SolveState {
	originCell: number;
	cost: Float64Array;
	meters: Float64Array;
	prev: Int32Array;
	done: Uint8Array;
	heap: CellHeap;
	/** Escape zone of the endpoints this state was set up for. */
	zone: EscapeZone;
	/** A* lower bound to the goal (`null` = Dijkstra). */
	heuristic: ((cell: number) => number) | null;
}

function createSolveState(
	grid: TerrainGrid,
	origin: GeoPoint,
	originCell: number,
	zone: EscapeZone,
	heuristic: ((cell: number) => number) | null = null
): SolveState {
	terrainSolveStats.solves++;
	if (heuristic) terrainSolveStats.astar++;
	const n = grid.cols * grid.rows;
	const state: SolveState = {
		originCell,
		cost: new Float64Array(n).fill(Infinity),
		meters: new Float64Array(n).fill(Infinity),
		prev: new Int32Array(n).fill(-1),
		done: new Uint8Array(n),
		heap: new CellHeap(),
		zone,
		heuristic
	};
	const originOffset = distanceTo(origin, cellCenter(grid, originCell));
	state.cost[originCell] = originOffset * optimizedCellFactor(grid, zone, originCell);
	state.meters[originCell] = originOffset;
	state.heap.push(state.cost[originCell] + (heuristic ? heuristic(originCell) : 0), originCell);
	return state;
}

/**
 * Pops cells until `stop(cell)` returns true for a settled cell (returned) or
 * the field is exhausted (`-1`). Settled cells stay valid for later queries.
 *
 * Relaxation: the step costs step × (F(u) + F(v)) / 2, so it is
 * the same in both directions; impassable cells are never entered; a diagonal
 * step may not cut the corner of an impassable cell (a supercover wall is
 * 4-connected, so this keeps rail and water lines watertight); a step whose
 * centre line touches a footprint is priced like a core cell (escape factor
 * inside the escape zone, else impassable); the step's slope factor multiplies
 * the cost (symmetric too, ≥ 1, so the octile heuristic stays admissible); a
 * step on or off a bridge must come from or go to a road, path, steps or
 * bridge cell (endpoint cells excepted).
 */
function settleUntil(
	grid: TerrainGrid,
	state: SolveState,
	stop: (cell: number) => boolean
): number {
	const { cost, meters, prev, done, heap, zone, heuristic } = state;
	const { cols, rows, cells } = grid;
	const straightStep = grid.cellM;
	const diagonalStep = grid.cellM * Math.SQRT2;
	const factor = (cell: number) => optimizedCellFactor(grid, zone, cell);
	for (;;) {
		const u = heap.pop();
		if (u === -1) return -1;
		if (done[u]) continue;
		done[u] = 1;
		const ux = u % cols;
		const uy = Math.floor(u / cols);
		const fu = factor(u);
		const uBuilding = isBuildingClass(grid, u);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const vx = ux + dx;
				const vy = uy + dy;
				if (vx < 0 || vx >= cols || vy < 0 || vy >= rows) continue;
				const v = vy * cols + vx;
				if (done[v]) continue;
				const fv = factor(v);
				if (fv === Infinity) continue;
				const diagonal = dx !== 0 && dy !== 0;
				if (
					diagonal &&
					(factor(uy * cols + vx) === Infinity || factor(vy * cols + ux) === Infinity)
				) {
					continue;
				}
				const cu = cells[u];
				const cv = cells[v];
				if (leavesBridge(cu, cv) && !zone.endpoints.has(u) && !zone.endpoints.has(v)) continue;
				let f = (fu + fv) / 2;
				if (
					(uBuilding || isBuildingClass(grid, v)) &&
					stepClipsBuilding(grid, u, v, (dy + 1) * 3 + (dx + 1))
				) {
					if (!zone.cells.has(u) && !zone.cells.has(v)) continue;
					f = BUILDING_CORE_ESCAPE_FACTOR;
				}
				const slope = stepSlopeFactor(grid, ux, uy, dx, dy, cu, cv);
				if (slope === Infinity) continue;
				const candidate = cost[u] + (diagonal ? diagonalStep : straightStep) * f * slope;
				if (candidate < cost[v]) {
					cost[v] = candidate;
					meters[v] = meters[u] + (diagonal ? diagonalStep : straightStep);
					prev[v] = u;
					heap.push(heuristic ? candidate + heuristic(v) : candidate, v);
				}
			}
		}
		if (stop(u)) return u;
	}
}

/** Octile distance in metres between cell (x0, y0) and the box [x1..x2] × [y1..y2]. */
function octileToBox(
	x0: number,
	y0: number,
	x1: number,
	x2: number,
	y1: number,
	y2: number,
	cellM: number
) {
	const dx = Math.max(x1 - x0, 0, x0 - x2);
	const dy = Math.max(y1 - y0, 0, y0 - y2);
	return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * cellM;
}

/**
 * Admissible A* heuristic towards a set of goal cells: the octile distance to
 * their bounding box × 1.0 (the cheapest factor, `ROAD`/`BRIDGE`, is 1.0 and
 * every step costs at least its length). For one cell it is the plain octile
 * distance.
 */
function octileHeuristic(grid: TerrainGrid, goals: Iterable<number>): (cell: number) => number {
	let x1 = Infinity;
	let x2 = -Infinity;
	let y1 = Infinity;
	let y2 = -Infinity;
	for (const g of goals) {
		const x = g % grid.cols;
		const y = Math.floor(g / grid.cols);
		if (x < x1) x1 = x;
		if (x > x2) x2 = x;
		if (y < y1) y1 = y;
		if (y > y2) y2 = y;
	}
	return (cell) =>
		octileToBox(cell % grid.cols, Math.floor(cell / grid.cols), x1, x2, y1, y2, grid.cellM);
}

/** Cell chain from the state's origin to `cell`. */
function chainTo(state: SolveState, cell: number): number[] {
	const chain: number[] = [];
	for (let cur = cell; cur !== -1; cur = state.prev[cur]) chain.push(cur);
	return chain.reverse();
}

/** Smoothed route along the solved chain to `cell`, ending at `endpoint`. */
function smoothedRoute(
	grid: TerrainGrid,
	state: SolveState,
	origin: GeoPoint,
	cell: number,
	endpoint: GeoPoint
): GridRoute {
	const chain = chainTo(state, cell);
	const endOffset = distanceTo(endpoint, cellCenter(grid, cell));
	const total = state.cost[cell] + endOffset * optimizedCellFactor(grid, state.zone, cell);
	const pathCost = chain.map((c) => state.cost[c]);
	pathCost[0] = 0;
	pathCost[pathCost.length - 1] = total;
	const points = smoothChainOptimized(grid, state.zone, chain, pathCost, origin, endpoint);
	return {
		points,
		meters: polylineMeters(points),
		cost: total,
		endpoint,
		cell
	};
}

/** The cheapest already settled goal cell (settled costs are final), or -1. */
function bestSettledGoal(state: SolveState, goals: Set<number>): number {
	let best = -1;
	for (const cell of goals) {
		if (
			state.done[cell] &&
			Number.isFinite(state.cost[cell]) &&
			(best === -1 || state.cost[cell] < state.cost[best])
		) {
			best = cell;
		}
	}
	return best;
}

/**
 * Single-source Dijkstra over the terrain grid (8-connected). `cost` ranks
 * (cell factors applied), `meters` tracks the plain geometric step length along
 * the same predecessor chain. The field is solved lazily: each query settles
 * cells only until its target (or the first cell of a goal set) is final, and
 * the state is memoised on the grid per origin cell, so the selected marker's
 * path after the list search needs no new solve. Returns `null` when the
 * origin is off-grid.
 *
 * `endpoints` are the targets the caller will ask for: the
 * escape zone around them and the origin is part of the field, so they are
 * fixed when the field is set up. A memoised field is reused only when it
 * already covers every endpoint asked for.
 */
export function solveTerrain(
	grid: TerrainGrid,
	origin: GeoPoint,
	endpoints: GeoPoint[] = []
): TerrainSolve | null {
	const originCell = cellOf(grid, origin);
	if (originCell === null) return null;
	let state = grid.solve;
	const covers = (s: SolveState) =>
		endpoints.every((p) => {
			const cell = cellOf(grid, p);
			return cell === null || s.zone.endpoints.has(cell);
		});
	if (!state || state.originCell !== originCell || !covers(state)) {
		const zone = escapeZone(grid, [origin, ...endpoints]);
		state = createSolveState(grid, origin, originCell, zone);
		grid.solve = state;
	}
	const s = state;

	const settle = (cell: number): boolean => {
		if (!s.done[cell]) settleUntil(grid, s, (u) => u === cell);
		return s.done[cell] === 1 && Number.isFinite(s.cost[cell]);
	};

	const routeToPoint = (target: GeoPoint): GridRoute | null => {
		const cell = cellOf(grid, target);
		if (cell === null || !settle(cell)) return null;
		return smoothedRoute(grid, s, origin, cell, target);
	};

	const routeToShore = (outline: GeoJSON.Geometry): GridRoute | null => {
		const goals = shoreGoalCells(grid, outline, s.zone);
		if (goals.size === 0) return null;
		// Settled costs are final and never exceed an unsettled one, so the
		// cheapest settled goal cell is the first one the search would pop.
		let best = bestSettledGoal(s, goals);
		if (best === -1) best = settleUntil(grid, s, (u) => goals.has(u));
		if (best === -1 || !Number.isFinite(s.cost[best])) return null;
		const endpoint = nearestPointOnOutline(outline, cellCenter(grid, best));
		if (!endpoint) return null;
		return smoothedRoute(grid, s, origin, best, endpoint);
	};

	return {
		distanceTo(target: GeoPoint): RouteResult | null {
			const cell = cellOf(grid, target);
			if (cell === null || !settle(cell)) return null;
			const targetOffset = distanceTo(target, cellCenter(grid, cell));
			return {
				cost: s.cost[cell] + targetOffset * optimizedCellFactor(grid, s.zone, cell),
				meters: s.meters[cell] + targetOffset
			};
		},
		pathTo(target: GeoPoint): GeoPoint[] | null {
			return routeToPoint(target)?.points ?? null;
		},
		routeTo(goal: GridGoal): GridRoute | null {
			return goal.kind === 'point' ? routeToPoint(goal.point) : routeToShore(goal.outline);
		},
		solveAll(): void {
			settleUntil(grid, s, () => false);
		}
	};
}

/**
 * Single path (plan §6.5): A* with the octile heuristic × 1.0 (for
 * a goal set, the octile distance to the set's bbox). Not memoised: the state
 * is specific to the goal. `null` when an end is off-grid or unreached.
 */
export function astarRoute(grid: TerrainGrid, origin: GeoPoint, goal: GridGoal): GridRoute | null {
	const originCell = cellOf(grid, origin);
	if (originCell === null) return null;
	if (goal.kind === 'point') {
		const cell = cellOf(grid, goal.point);
		if (cell === null) return null;
		const zone = escapeZone(grid, [origin, goal.point]);
		const state = createSolveState(grid, origin, originCell, zone, octileHeuristic(grid, [cell]));
		const reached = settleUntil(grid, state, (u) => u === cell);
		if (reached === -1 || !Number.isFinite(state.cost[cell])) return null;
		return smoothedRoute(grid, state, origin, cell, goal.point);
	}
	const zone = escapeZone(grid, [origin]);
	const goals = shoreGoalCells(grid, goal.outline, zone);
	if (goals.size === 0) return null;
	const state = createSolveState(grid, origin, originCell, zone, octileHeuristic(grid, goals));
	const best = settleUntil(grid, state, (u) => goals.has(u));
	if (best === -1 || !Number.isFinite(state.cost[best])) return null;
	const endpoint = nearestPointOnOutline(goal.outline, cellCenter(grid, best));
	if (!endpoint) return null;
	return smoothedRoute(grid, state, origin, best, endpoint);
}

/**
 * True when the grid's memoised field (the nearby list's solve) answers
 * `origin` → `goal`: same origin cell, and a point goal whose escape zone the
 * field was set up with (any shore goal).
 */
export function memoCovers(grid: TerrainGrid, origin: GeoPoint, goal: GridGoal): boolean {
	const memo = grid.solve;
	if (memo === undefined || memo.originCell !== cellOf(grid, origin)) return false;
	if (goal.kind === 'shore') return true;
	const targetCell = cellOf(grid, goal.point);
	return targetCell !== null && memo.zone.endpoints.has(targetCell);
}

/**
 * One route `origin` → `goal`: answered from the memoised field of the same
 * origin when it covers the goal (the selected marker after the list search,
 * so list and line agree), else by A*.
 */
export function gridRouteSingle(
	grid: TerrainGrid,
	origin: GeoPoint,
	goal: GridGoal
): GridRoute | null {
	if (!memoCovers(grid, origin, goal)) return astarRoute(grid, origin, goal);
	const solve = solveTerrain(grid, origin, goal.kind === 'point' ? [goal.point] : []);
	return solve ? solve.routeTo(goal) : null;
}

/**
 * Smoothed terrain routes from `origin` to each goal. ONE (lazily settled,
 * memoised) grid solve serves all goals. `null` per goal when it is off-grid
 * or unreached.
 */
export function gridRouteFromOrigin(
	grid: TerrainGrid,
	origin: GeoPoint,
	goals: GridGoal[]
): (GridRoute | null)[] {
	const endpoints = goals.flatMap((g) => (g.kind === 'point' ? [g.point] : []));
	const solve = solveTerrain(grid, origin, endpoints);
	if (!solve) return goals.map(() => null);
	return goals.map((goal) => solve.routeTo(goal));
}

/** Terrain-routed display polyline `origin` → `target`, or `null`. */
export function gridRoutePath(
	grid: TerrainGrid,
	origin: GeoPoint,
	target: GeoPoint
): GeoPoint[] | null {
	return gridRouteSingle(grid, origin, { kind: 'point', point: target })?.points ?? null;
}
