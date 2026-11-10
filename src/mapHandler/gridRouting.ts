import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';
import { BuildingPolygon, ObstacleData } from '@/types/obstacles';
import { RouteResult } from '@/mapHandler/roadRouting';
import { pointInPolygon, segmentIntersectsPolygon } from '@/helper/polygonGeometry';
import { nearestPointOnOutline, outlineLines } from '@/helper/areaShore';

/**
 * Terrain routing for hose laying: a cost-grid Dijkstra over the decoded
 * obstacles. Unlike the road-graph router this is NOT clamped to roads —
 * hoses may cut through gardens and open ground and around houses. Roads are
 * still preferred (cheaper), buildings are strongly avoided but never fully
 * block (a courtyard hydrant must stay reachable).
 */

/** Grid resolution; 8 m ≈ alley width, keeps a 3 km window under the cell cap. */
export const GRID_CELL_M = 8;
/**
 * Cost multiplier for cells on a road. Kept close to 1: every extra meter of
 * detour is an extra meter of hose, so roads only break ties — they must not
 * justify e.g. a 30% longer loop over a garden shortcut.
 */
export const GRID_ROAD_FACTOR = 0.9;
/** Cost multiplier for open ground (gardens, fields, squares). */
export const GRID_OPEN_FACTOR = 1.0;
/** Cost multiplier inside buildings: effectively avoided, never disconnecting. */
export const GRID_BUILDING_FACTOR = 30;
/**
 * Cost multiplier for building-fringe cells (footprint touches the cell but
 * its center is outside). Passable at a squeeze-past-the-wall price: without
 * this class an 8 m raster dilates every house by ~half a cell per side, which
 * seals the garden gaps between neighbouring houses and forces long road loops.
 */
export const GRID_BUILDING_FRINGE_FACTOR = 4;
/** Hard cap on grid size; larger windows fall back to graph routing. */
export const MAX_GRID_CELLS = 250_000;

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQUATOR = 111320;

// Cell classes (index into CLASS_FACTOR):
// 0 = open, 1 = road, 2 = building core, 3 = building fringe.
const CLASS_ROAD = 1;
const CLASS_BUILDING = 2;
const CLASS_FRINGE = 3;
const CLASS_FACTOR = [
	GRID_OPEN_FACTOR,
	GRID_ROAD_FACTOR,
	GRID_BUILDING_FACTOR,
	GRID_BUILDING_FRINGE_FACTOR
];

export interface TerrainGrid {
	west: number;
	south: number;
	mPerDegLng: number;
	cols: number;
	rows: number;
	/** Cell class per cell (row-major): 0 open, 1 road, 2 building core, 3 fringe. */
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
}

function toRadians(deg: number): number {
	return (deg * Math.PI) / 180;
}

/** Point-in-footprint test (outer ring minus holes). */
function pointInBuilding(lng: number, lat: number, building: BuildingPolygon): boolean {
	return pointInPolygon(lng, lat, building);
}

/**
 * Builds the terrain cost grid over `bounds`, or `null` when the window would
 * exceed the cell cap (caller falls back to graph routing). Buildings are
 * rasterized first, roads afterwards — a road cell stays a road even where it
 * touches a building footprint (passages, bridges).
 */
export function buildTerrainGrid(obstacles: ObstacleData, bounds: GeoBounds): TerrainGrid | null {
	const midLat = (bounds.south + bounds.north) / 2;
	const mPerDegLng = Math.cos(toRadians(midLat)) * M_PER_DEG_LNG_EQUATOR;
	const cols = Math.ceil(((bounds.east - bounds.west) * mPerDegLng) / GRID_CELL_M);
	const rows = Math.ceil(((bounds.north - bounds.south) * M_PER_DEG_LAT) / GRID_CELL_M);
	if (cols <= 0 || rows <= 0 || cols * rows > MAX_GRID_CELLS) return null;

	const grid: TerrainGrid = {
		west: bounds.west,
		south: bounds.south,
		mPerDegLng,
		cols,
		rows,
		cells: new Uint8Array(cols * rows),
		buildings: obstacles.buildings
	};

	const colOf = (lng: number) => Math.floor(((lng - grid.west) * mPerDegLng) / GRID_CELL_M);
	const rowOf = (lat: number) => Math.floor(((lat - grid.south) * M_PER_DEG_LAT) / GRID_CELL_M);
	const centerLng = (col: number) => grid.west + ((col + 0.5) * GRID_CELL_M) / mPerDegLng;
	const centerLat = (row: number) => grid.south + ((row + 0.5) * GRID_CELL_M) / M_PER_DEG_LAT;

	// Buildings: center inside the footprint → core (heavily avoided); the
	// footprint only touching the cell → fringe (passable at a squeeze price).
	// Marking everything a footprint touches as core would dilate houses by
	// ~half a cell per side and seal the garden gaps between them. "Touching"
	// is tested exactly (cell sides against the outline), so a wall running
	// along a cell edge or a corner poking into a cell is never missed.
	const halfLng = GRID_CELL_M / 2 / mPerDegLng;
	const halfLat = GRID_CELL_M / 2 / M_PER_DEG_LAT;
	for (const building of obstacles.buildings) {
		const [west, south, east, north] = building.bbox;
		const c0 = Math.max(0, colOf(west));
		const c1 = Math.min(cols - 1, colOf(east));
		const r0 = Math.max(0, rowOf(south));
		const r1 = Math.min(rows - 1, rowOf(north));
		const firstVertex = building.rings[0]?.[0];
		for (let r = r0; r <= r1; r++) {
			for (let c = c0; c <= c1; c++) {
				const idx = r * cols + c;
				if (grid.cells[idx] === CLASS_BUILDING) continue;
				const lng = centerLng(c);
				const lat = centerLat(r);
				if (pointInBuilding(lng, lat, building)) {
					grid.cells[idx] = CLASS_BUILDING;
					continue;
				}
				if (grid.cells[idx] === CLASS_FRINGE) continue;
				const sw: [number, number] = [lng - halfLng, lat - halfLat];
				const se: [number, number] = [lng + halfLng, lat - halfLat];
				const ne: [number, number] = [lng + halfLng, lat + halfLat];
				const nw: [number, number] = [lng - halfLng, lat + halfLat];
				const touches =
					segmentIntersectsPolygon(sw, se, building) ||
					segmentIntersectsPolygon(se, ne, building) ||
					segmentIntersectsPolygon(ne, nw, building) ||
					segmentIntersectsPolygon(nw, sw, building) ||
					// A footprint smaller than a cell, lying fully inside it.
					(firstVertex !== undefined &&
						firstVertex[0] > sw[0] &&
						firstVertex[0] < ne[0] &&
						firstVertex[1] > sw[1] &&
						firstVertex[1] < ne[1]);
				if (touches) grid.cells[idx] = CLASS_FRINGE;
			}
		}
	}

	// Roads: walk each segment at half-cell steps and mark the touched cells.
	// Marked after buildings so a road wins where footprints overlap it.
	for (const road of obstacles.roads) {
		for (let i = 0; i < road.points.length - 1; i++) {
			const [lngA, latA] = road.points[i];
			const [lngB, latB] = road.points[i + 1];
			const lengthM = Math.hypot((lngB - lngA) * mPerDegLng, (latB - latA) * M_PER_DEG_LAT);
			const steps = Math.max(1, Math.ceil(lengthM / (GRID_CELL_M / 2)));
			for (let s = 0; s <= steps; s++) {
				const f = s / steps;
				const c = colOf(lngA + (lngB - lngA) * f);
				const r = rowOf(latA + (latB - latA) * f);
				if (c >= 0 && c < cols && r >= 0 && r < rows) {
					grid.cells[r * cols + c] = CLASS_ROAD;
				}
			}
		}
	}

	return grid;
}

/** Minimal binary min-heap over (cost, cell) pairs with lazy deletion. */
class CellHeap {
	private cost: number[] = [];
	private cell: number[] = [];

	get size(): number {
		return this.cost.length;
	}

	push(cost: number, cellIdx: number): void {
		this.cost.push(cost);
		this.cell.push(cellIdx);
		let i = this.cost.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (this.cost[parent] <= this.cost[i]) break;
			this.swap(i, parent);
			i = parent;
		}
	}

	pop(): { cost: number; cellIdx: number } | null {
		if (this.cost.length === 0) return null;
		const top = { cost: this.cost[0], cellIdx: this.cell[0] };
		const lastCost = this.cost.pop() as number;
		const lastCell = this.cell.pop() as number;
		if (this.cost.length > 0) {
			this.cost[0] = lastCost;
			this.cell[0] = lastCell;
			let i = 0;
			for (;;) {
				const left = 2 * i + 1;
				const right = left + 1;
				let smallest = i;
				if (left < this.cost.length && this.cost[left] < this.cost[smallest]) smallest = left;
				if (right < this.cost.length && this.cost[right] < this.cost[smallest]) smallest = right;
				if (smallest === i) break;
				this.swap(i, smallest);
				i = smallest;
			}
		}
		return top;
	}

	private swap(i: number, j: number): void {
		[this.cost[i], this.cost[j]] = [this.cost[j], this.cost[i]];
		[this.cell[i], this.cell[j]] = [this.cell[j], this.cell[i]];
	}
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

/** Counts Dijkstra field set-ups (specs check the memoisation with it). */
export const terrainSolveStats = { solves: 0 };

function cellOf(grid: TerrainGrid, p: GeoPoint): number | null {
	const c = Math.floor(((p.lng - grid.west) * grid.mPerDegLng) / GRID_CELL_M);
	const r = Math.floor(((p.lat - grid.south) * M_PER_DEG_LAT) / GRID_CELL_M);
	if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) return null;
	return r * grid.cols + c;
}

function cellCenter(grid: TerrainGrid, cellIdx: number): GeoPoint {
	const c = cellIdx % grid.cols;
	const r = Math.floor(cellIdx / grid.cols);
	return {
		lng: grid.west + ((c + 0.5) * GRID_CELL_M) / grid.mPerDegLng,
		lat: grid.south + ((r + 0.5) * GRID_CELL_M) / M_PER_DEG_LAT
	};
}

/**
 * True when the straight cell-line a→b crosses no building cell. Supercover
 * variant of Bresenham: on diagonal steps BOTH adjacent cells are checked, so
 * the shortcut can never slip through a building corner.
 */
function lineOfSight(grid: TerrainGrid, a: number, b: number): boolean {
	let x0 = a % grid.cols;
	let y0 = Math.floor(a / grid.cols);
	const x1 = b % grid.cols;
	const y1 = Math.floor(b / grid.cols);
	const dx = Math.abs(x1 - x0);
	const dy = -Math.abs(y1 - y0);
	const sx = x0 < x1 ? 1 : -1;
	const sy = y0 < y1 ? 1 : -1;
	let err = dx + dy;
	const isBuilding = (x: number, y: number) =>
		x >= 0 && x < grid.cols && y >= 0 && y < grid.rows
			? grid.cells[y * grid.cols + x] === CLASS_BUILDING
			: false;
	for (;;) {
		if (isBuilding(x0, y0)) return false;
		if (x0 === x1 && y0 === y1) return true;
		const e2 = 2 * err;
		const stepX = e2 >= dy;
		const stepY = e2 <= dx;
		if (stepX && stepY) {
			// Diagonal step: the line passes between the two orthogonal
			// neighbours — treat it as blocked if either is a building.
			if (isBuilding(x0 + sx, y0) || isBuilding(x0, y0 + sy)) return false;
		}
		if (stepX) {
			err += dy;
			x0 += sx;
		}
		if (stepY) {
			err += dx;
			y0 += sy;
		}
	}
}

/** Bucket edge of the building index used by the exact segment test. */
const BUCKET_M = 32;

/** Buckets building indexes by the {@link BUCKET_M} squares their bbox touches. */
function buildBuildingIndex(grid: TerrainGrid): void {
	const bcols = Math.max(1, Math.ceil((grid.cols * GRID_CELL_M) / BUCKET_M));
	const brows = Math.max(1, Math.ceil((grid.rows * GRID_CELL_M) / BUCKET_M));
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

/**
 * Greedy string pulling over the cell chain, starting from the TRUE origin and
 * ending at the TRUE target (the chain's first and last cell centres are
 * replaced before smoothing, so the end segments are checked too). From each
 * kept vertex it jumps to the farthest later vertex that is visible both on
 * the raster (no building-core cell) and against the real footprints. When
 * not even the next vertex is visible (an endpoint inside a footprint), the
 * step is taken anyway so the path always exists.
 */
function smoothChain(
	grid: TerrainGrid,
	chain: number[],
	start: GeoPoint,
	end: GeoPoint
): GeoPoint[] {
	if (chain.length <= 1) return [start, end];
	const points = chain.map((cell) => cellCenter(grid, cell));
	points[0] = start;
	points[points.length - 1] = end;
	const visible = (i: number, j: number) =>
		lineOfSight(grid, chain[i], chain[j]) && exactLineOfSight(grid, points[i], points[j]);
	const path: GeoPoint[] = [points[0]];
	let i = 0;
	while (i < points.length - 1) {
		let next = i + 1;
		for (let j = points.length - 1; j > i + 1; j--) {
			if (visible(i, j)) {
				next = j;
				break;
			}
		}
		path.push(points[next]);
		i = next;
	}
	return path;
}

/** Cells next to (and on) an outline's lines, excluding building cores. */
function shoreGoalCells(grid: TerrainGrid, outline: GeoJSON.Geometry): Set<number> {
	const onLine = new Set<number>();
	for (const line of outlineLines(outline)) {
		for (let i = 0; i < line.length; i++) {
			const a = line[i];
			const b = line[Math.min(i + 1, line.length - 1)];
			const lengthM = Math.hypot((b[0] - a[0]) * grid.mPerDegLng, (b[1] - a[1]) * M_PER_DEG_LAT);
			const steps = Math.max(1, Math.ceil(lengthM / (GRID_CELL_M / 4)));
			for (let s = 0; s <= steps; s++) {
				const f = s / steps;
				const cell = cellOf(grid, { lng: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f });
				if (cell !== null) onLine.add(cell);
			}
		}
	}
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
				if (grid.cells[idx] !== CLASS_BUILDING) goals.add(idx);
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

/** Resumable single-source Dijkstra state (early exit + memoisation, plan §6.5). */
interface SolveState {
	originCell: number;
	cost: Float64Array;
	meters: Float64Array;
	prev: Int32Array;
	done: Uint8Array;
	heap: CellHeap;
}

function createSolveState(grid: TerrainGrid, origin: GeoPoint, originCell: number): SolveState {
	terrainSolveStats.solves++;
	const n = grid.cols * grid.rows;
	const state: SolveState = {
		originCell,
		cost: new Float64Array(n).fill(Infinity),
		meters: new Float64Array(n).fill(Infinity),
		prev: new Int32Array(n).fill(-1),
		done: new Uint8Array(n),
		heap: new CellHeap()
	};
	const originOffset = distanceTo(origin, cellCenter(grid, originCell));
	state.cost[originCell] = originOffset * CLASS_FACTOR[grid.cells[originCell]];
	state.meters[originCell] = originOffset;
	state.heap.push(state.cost[originCell], originCell);
	return state;
}

/**
 * Pops cells until `stop(cell)` returns true for a settled cell (returned) or
 * the field is exhausted (`-1`). Settled cells stay valid for later queries.
 */
function settleUntil(
	grid: TerrainGrid,
	state: SolveState,
	stop: (cell: number) => boolean
): number {
	const { cost, meters, prev, done, heap } = state;
	const straightStep = GRID_CELL_M;
	const diagonalStep = GRID_CELL_M * Math.SQRT2;
	for (;;) {
		const top = heap.pop();
		if (!top) return -1;
		const u = top.cellIdx;
		if (done[u]) continue;
		done[u] = 1;
		const ux = u % grid.cols;
		const uy = Math.floor(u / grid.cols);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (dx === 0 && dy === 0) continue;
				const vx = ux + dx;
				const vy = uy + dy;
				if (vx < 0 || vx >= grid.cols || vy < 0 || vy >= grid.rows) continue;
				const v = vy * grid.cols + vx;
				if (done[v]) continue;
				const step = dx !== 0 && dy !== 0 ? diagonalStep : straightStep;
				let factor = CLASS_FACTOR[grid.cells[v]];
				// A step next to a footprint whose centre-to-centre line touches the
				// real outline is priced like walking through the building: the chain
				// then stays outside, so even unsmoothed steps never clip a wall.
				if (
					factor < GRID_BUILDING_FACTOR &&
					(grid.cells[u] >= CLASS_BUILDING || grid.cells[v] >= CLASS_BUILDING) &&
					stepClipsBuilding(grid, u, v, (dy + 1) * 3 + (dx + 1))
				) {
					factor = GRID_BUILDING_FACTOR;
				}
				const candidate = cost[u] + step * factor;
				if (candidate < cost[v]) {
					cost[v] = candidate;
					meters[v] = meters[u] + step;
					prev[v] = u;
					heap.push(candidate, v);
				}
			}
		}
		if (stop(u)) return u;
	}
}

/**
 * Single-source Dijkstra over the terrain grid (8-connected). `cost` ranks
 * (cell factors applied), `meters` tracks the plain geometric step length along
 * the same predecessor chain. The field is solved lazily: each query settles
 * cells only until its target (or the first cell of a goal set) is final, and
 * the state is memoised on the grid per origin cell, so the selected marker's
 * path after the list search needs no new solve. Returns `null` when the
 * origin is off-grid.
 */
export function solveTerrain(grid: TerrainGrid, origin: GeoPoint): TerrainSolve | null {
	const originCell = cellOf(grid, origin);
	if (originCell === null) return null;
	let state = grid.solve;
	if (!state || state.originCell !== originCell) {
		state = createSolveState(grid, origin, originCell);
		grid.solve = state;
	}
	const s = state;

	const settle = (cell: number): boolean => {
		if (!s.done[cell]) settleUntil(grid, s, (u) => u === cell);
		return s.done[cell] === 1 && Number.isFinite(s.cost[cell]);
	};
	const chainTo = (cell: number): number[] => {
		const chain: number[] = [];
		for (let cur = cell; cur !== -1; cur = s.prev[cur]) chain.push(cur);
		return chain.reverse();
	};

	const routeToPoint = (target: GeoPoint): GridRoute | null => {
		const cell = cellOf(grid, target);
		if (cell === null || !settle(cell)) return null;
		const points = smoothChain(grid, chainTo(cell), origin, target);
		return { points, meters: polylineMeters(points), cost: s.cost[cell], endpoint: target };
	};

	const routeToShore = (outline: GeoJSON.Geometry): GridRoute | null => {
		const goals = shoreGoalCells(grid, outline);
		if (goals.size === 0) return null;
		// Settled costs are final and never exceed an unsettled one, so the
		// cheapest settled goal cell is the first one the search would pop.
		let best = -1;
		for (const cell of goals) {
			if (
				s.done[cell] &&
				Number.isFinite(s.cost[cell]) &&
				(best === -1 || s.cost[cell] < s.cost[best])
			) {
				best = cell;
			}
		}
		if (best === -1) best = settleUntil(grid, s, (u) => goals.has(u));
		if (best === -1 || !Number.isFinite(s.cost[best])) return null;
		const endpoint = nearestPointOnOutline(outline, cellCenter(grid, best));
		if (!endpoint) return null;
		const points = smoothChain(grid, chainTo(best), origin, endpoint);
		return { points, meters: polylineMeters(points), cost: s.cost[best], endpoint };
	};

	return {
		distanceTo(target: GeoPoint): RouteResult | null {
			const cell = cellOf(grid, target);
			if (cell === null || !settle(cell)) return null;
			const targetOffset = distanceTo(target, cellCenter(grid, cell));
			return {
				cost: s.cost[cell] + targetOffset * CLASS_FACTOR[grid.cells[cell]],
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
 * Smoothed terrain routes from `origin` to each goal. ONE (lazily settled,
 * memoised) grid solve serves all goals. `null` per goal when it is off-grid
 * or unreached.
 */
export function gridRouteFromOrigin(
	grid: TerrainGrid,
	origin: GeoPoint,
	goals: GridGoal[]
): (GridRoute | null)[] {
	const solve = solveTerrain(grid, origin);
	if (!solve) return goals.map(() => null);
	return goals.map((goal) => solve.routeTo(goal));
}

/** Terrain-routed display polyline `origin` → `target`, or `null`. */
export function gridRoutePath(
	grid: TerrainGrid,
	origin: GeoPoint,
	target: GeoPoint
): GeoPoint[] | null {
	const solve = solveTerrain(grid, origin);
	if (!solve) return null;
	return solve.pathTo(target);
}
