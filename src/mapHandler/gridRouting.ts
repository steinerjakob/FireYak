import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';
import { BuildingPolygon, ObstacleData } from '@/types/obstacles';
import { RouteResult } from '@/mapHandler/roadRouting';

/**
 * Terrain routing for hose laying: a cost-grid Dijkstra over the decoded
 * obstacles. Unlike the road-graph router this is NOT clamped to roads —
 * hoses may cut through gardens and open ground and around houses. Roads are
 * still preferred (cheaper), buildings are strongly avoided but never fully
 * block (a courtyard hydrant must stay reachable).
 */

/** Grid resolution; 8 m ≈ alley width, keeps a 3 km window under the cell cap. */
export const GRID_CELL_M = 8;
/** Cost multiplier for cells on a road. */
export const GRID_ROAD_FACTOR = 0.75;
/** Cost multiplier for open ground (gardens, fields, squares). */
export const GRID_OPEN_FACTOR = 1.0;
/** Cost multiplier inside buildings: effectively avoided, never disconnecting. */
export const GRID_BUILDING_FACTOR = 30;
/** Hard cap on grid size; larger windows fall back to graph routing. */
const MAX_GRID_CELLS = 250_000;

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQUATOR = 111320;

// Cell classes: 0 = open (index into CLASS_FACTOR), 1 = road, 2 = building.
const CLASS_ROAD = 1;
const CLASS_BUILDING = 2;
const CLASS_FACTOR = [GRID_OPEN_FACTOR, GRID_ROAD_FACTOR, GRID_BUILDING_FACTOR];

export interface TerrainGrid {
	west: number;
	south: number;
	mPerDegLng: number;
	cols: number;
	rows: number;
	/** Cell class per cell (row-major): 0 open, 1 road, 2 building. */
	cells: Uint8Array;
	/** Source footprints, kept for exact checks during path smoothing. */
	buildings: BuildingPolygon[];
}

function toRadians(deg: number): number {
	return (deg * Math.PI) / 180;
}

/** Ray-casting test of a lng/lat point against one building's rings. */
function pointInBuilding(lng: number, lat: number, building: BuildingPolygon): boolean {
	const inRing = (ring: [number, number][]): boolean => {
		let inside = false;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const xi = ring[i][0];
			const yi = ring[i][1];
			const xj = ring[j][0];
			const yj = ring[j][1];
			if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
				inside = !inside;
			}
		}
		return inside;
	};
	const [outer, ...holes] = building.rings;
	if (!outer || !inRing(outer)) return false;
	return !holes.some(inRing);
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

	// Buildings: a cell counts as building when its center OR any corner lies
	// inside the footprint — center-only testing under-marks cells that a
	// polygon partially covers, letting paths clip real building corners.
	const halfLng = GRID_CELL_M / 2 / mPerDegLng;
	const halfLat = GRID_CELL_M / 2 / M_PER_DEG_LAT;
	for (const building of obstacles.buildings) {
		const [west, south, east, north] = building.bbox;
		const c0 = Math.max(0, colOf(west));
		const c1 = Math.min(cols - 1, colOf(east));
		const r0 = Math.max(0, rowOf(south));
		const r1 = Math.min(rows - 1, rowOf(north));
		for (let r = r0; r <= r1; r++) {
			for (let c = c0; c <= c1; c++) {
				const lng = centerLng(c);
				const lat = centerLat(r);
				if (
					pointInBuilding(lng, lat, building) ||
					pointInBuilding(lng - halfLng, lat - halfLat, building) ||
					pointInBuilding(lng + halfLng, lat - halfLat, building) ||
					pointInBuilding(lng - halfLng, lat + halfLat, building) ||
					pointInBuilding(lng + halfLng, lat + halfLat, building)
				) {
					grid.cells[r * cols + c] = CLASS_BUILDING;
				}
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

/** Solved single-source terrain field; answers distance/path queries per target. */
export interface TerrainSolve {
	distanceTo(target: GeoPoint): RouteResult | null;
	pathTo(target: GeoPoint): GeoPoint[] | null;
}

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

/** True when the straight line between two cell centers misses every real footprint. */
function exactLineOfSight(grid: TerrainGrid, a: number, b: number): boolean {
	const pa = cellCenter(grid, a);
	const pb = cellCenter(grid, b);
	const steps = Math.max(1, Math.ceil(distanceTo(pa, pb) / (GRID_CELL_M / 2)));
	for (let s = 0; s <= steps; s++) {
		const f = s / steps;
		const lng = pa.lng + (pb.lng - pa.lng) * f;
		const lat = pa.lat + (pb.lat - pa.lat) * f;
		for (const building of grid.buildings) {
			const [west, south, east, north] = building.bbox;
			if (lng < west || lng > east || lat < south || lat > north) continue;
			if (pointInBuilding(lng, lat, building)) return false;
		}
	}
	return true;
}

/**
 * Single-source Dijkstra over the terrain grid (8-connected). `cost` ranks
 * (cell factors applied), `meters` tracks the plain geometric step length along
 * the same predecessor chain. Returns `null` when the origin is off-grid.
 */
export function solveTerrain(grid: TerrainGrid, origin: GeoPoint): TerrainSolve | null {
	const originCell = cellOf(grid, origin);
	if (originCell === null) return null;

	const n = grid.cols * grid.rows;
	const cost = new Float64Array(n).fill(Infinity);
	const meters = new Float64Array(n).fill(Infinity);
	const prev = new Int32Array(n).fill(-1);
	const done = new Uint8Array(n);
	const heap = new CellHeap();

	const originOffset = distanceTo(origin, cellCenter(grid, originCell));
	cost[originCell] = originOffset * CLASS_FACTOR[grid.cells[originCell]];
	meters[originCell] = originOffset;
	heap.push(cost[originCell], originCell);

	const straightStep = GRID_CELL_M;
	const diagonalStep = GRID_CELL_M * Math.SQRT2;

	for (;;) {
		const top = heap.pop();
		if (!top) break;
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
				const candidate = cost[u] + step * CLASS_FACTOR[grid.cells[v]];
				if (candidate < cost[v]) {
					cost[v] = candidate;
					meters[v] = meters[u] + step;
					prev[v] = u;
					heap.push(candidate, v);
				}
			}
		}
	}

	return {
		distanceTo(target: GeoPoint): RouteResult | null {
			const cell = cellOf(grid, target);
			if (cell === null || !Number.isFinite(cost[cell])) return null;
			const targetOffset = distanceTo(target, cellCenter(grid, cell));
			return {
				cost: cost[cell] + targetOffset * CLASS_FACTOR[grid.cells[cell]],
				meters: meters[cell] + targetOffset
			};
		},
		pathTo(target: GeoPoint): GeoPoint[] | null {
			const cell = cellOf(grid, target);
			if (cell === null || !Number.isFinite(cost[cell])) return null;
			const chain: number[] = [];
			for (let cur = cell; cur !== -1; cur = prev[cur]) chain.push(cur);
			chain.reverse();
			// Greedy line-of-sight smoothing: from each kept vertex jump to the
			// farthest later cell still visible without crossing a building —
			// checked against the raster first (cheap) and then against the true
			// footprints (the raster under-represents corners at 8 m cells).
			const kept: number[] = [];
			let i = 0;
			while (i < chain.length) {
				kept.push(chain[i]);
				let next = i + 1;
				for (let j = chain.length - 1; j > i + 1; j--) {
					if (lineOfSight(grid, chain[i], chain[j]) && exactLineOfSight(grid, chain[i], chain[j])) {
						next = j;
						break;
					}
				}
				i = next;
			}
			const path: GeoPoint[] = [origin];
			for (const cellIdx of kept) path.push(cellCenter(grid, cellIdx));
			path.push(target);
			return path;
		}
	};
}

/**
 * Terrain-routed results from `origin` to each target. ONE grid solve serves
 * all targets. `null` per target when it's off-grid/unreached.
 */
export function gridRouteFromOrigin(
	grid: TerrainGrid,
	origin: GeoPoint,
	targets: GeoPoint[]
): (RouteResult | null)[] {
	const solve = solveTerrain(grid, origin);
	if (!solve) return targets.map(() => null);
	return targets.map((t) => solve.distanceTo(t));
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
