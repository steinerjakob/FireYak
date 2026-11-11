import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';
import { BasemapCoverage, ObstacleData, RoadLine } from '@/types/obstacles';
import { getObstaclesForBounds, type TileFetcher } from '@/mapHandler/obstacleTiles';
import {
	POND_SHORE_SNAP_M,
	RoadGraph,
	RoadTarget,
	buildRoadGraph,
	routeFromOrigin
} from '@/mapHandler/roadRouting';
import {
	GRID_CELL_M,
	GridGoal,
	GridRoute,
	MAX_GRID_CELLS,
	TerrainGrid,
	buildOptimizedGrid,
	cellClassAt,
	escapeZone,
	gridFrameOf,
	gridRouteSingle,
	lineCost,
	memoCovers,
	setGridHeights,
	solveTerrain
} from '@/mapHandler/gridRouting';
import { M_PER_DEG_LAT, routableRoads } from '@/mapHandler/costGrid';
import {
	BUILDING_CORE_ESCAPE_FACTOR,
	isOnRoadClass,
	type CellClass
} from '@/mapHandler/hoseCostModel';
import type { HoseRoutingMode } from '@/helper/hoseRoutingSetting';
import { sampleShore } from '@/helper/areaShore';
import {
	OFF_ROAD_NEAR_M,
	OffRoadTest,
	RouteSegment,
	classifyRoute,
	isNearAnyRoad,
	length3d,
	resampleForProfile,
	slopeNotRecommended
} from '@/helper/routeProfile';
import { PressureLevel, evaluateDownhillPressure } from '@/helper/hosePressure';
import {
	type DemTileDecoder,
	isCompleteRoutingRaster,
	loadRoutingHeights,
	sampleRouteElevations,
	setDemTileDecoder,
	setDemTileFetcher,
	slopeCoverageOf,
	type SlopeCoverage
} from '@/helper/demTiles';
import { ROUTING_DATA_BUDGET_MS, createBudget } from '@/helper/routingBudget';
import type { AccessTarget } from '@/mapHandler/waterSourceAccess';

/**
 * The hose routing solve (plan §6.10, phase 6): the one code path behind the
 * nearby water sources list, the marker path and the pump line, run in the
 * hose routing worker (`src/workers/hoseRouting.worker.ts`) or, where workers
 * are unavailable, on the main thread (`nearbyRouting.ts` is the facade for
 * both). The `mode` option picks the router: `optimized` (the default: the
 * weighted cost grid of `hoseCostModel.ts`, with slope) or `roads` (road
 * graph, short connections at both ends). Every route comes back as a
 * {@link HoseRoute}: one polyline whose length is the one number shown
 * everywhere, its steep/off-road runs, the slope and pressure warnings, and
 * the reason when it fell back to something simpler. Fails open: any error
 * yields the straight line (marked as such), the list must never break
 * because of this feature; only a cancellation ({@link RoutingCancelledError})
 * is passed on.
 *
 * No app I/O is imported: tile bytes come from the {@link RoutingIO} given to
 * {@link configureRoutingIO}, so the module runs in a worker and under Node.
 * Each realm (main thread, worker) has its own routing context and LRUs.
 */

export { ROUTING_DATA_BUDGET_MS };

/** Only markers within this straight-line distance get the routed treatment. */
export const ROUTING_MAX_STRAIGHT_M = 1500;
/** Single paths longer than this (straight) are drawn straight (`tooFar`). */
export const PATH_MAX_STRAIGHT_M = ROUTING_MAX_STRAIGHT_M * 2;
/** Cap on markers routed/weighted per search (they're processed nearest-first). */
export const MAX_ROUTED_TARGETS = 30;
/** Shore sample spacing for road-mode pond targets (plan §6.5). */
export const POND_SHORE_SAMPLE_M = 20;
/**
 * A road-mode shore leg ends ON the outline, so the pond's own cells next to
 * the shore point are priced as open ground for this far (one cell diagonal).
 */
const SHORE_LEG_LENIENT_M = 12;
/** Margin around the candidate bbox so snapping (≤100 m) never leaves the tile window. */
const BOUNDS_MARGIN_M = 150;
/** `optimized`: the margin grows with the distance (plan §6.5: max(150 m, 0.25 × straight)). */
const OPTIMIZED_MARGIN_SHARE = 0.25;
/** `optimized`: a route touching the window edge (or missing a target) re-solves once in a window this much larger. */
const WINDOW_GROWTH = 1.5;
/** `optimized`: margin around the road-mode routes the window must hold. */
const ROAD_ROUTE_MARGIN_M = 50;
/** A grid route within this distance of the window edge "touches" it. */
const EDGE_TOUCH_M = 16;
/** Rebuild the road graph after this long even if the window still covers the query. */
const CONTEXT_TTL_MS = 60_000;

const M_PER_DEG_LNG_EQUATOR = 111320;

// ---------------------------------------------------------------------------
// Adaptive cell size (plan §6.10)
// ---------------------------------------------------------------------------

/** Cell edge for single paths in windows up to {@link FINE_WINDOW_MAX_M}. */
export const FINE_CELL_M = 4;
/** Cell edge for single paths in windows up to {@link MEDIUM_WINDOW_MAX_M}. */
export const MEDIUM_CELL_M = 6;
/** Largest window side (m) a single path is solved on {@link FINE_CELL_M} cells. */
export const FINE_WINDOW_MAX_M = 1200;
/** Largest window side (m) a single path is solved on {@link MEDIUM_CELL_M} cells. */
export const MEDIUM_WINDOW_MAX_M = 2500;

/** What a solve is for: the nearby list (one field, many targets) or one path. */
export type SolvePurpose = 'list' | 'path';

/** Window extent in metres. */
export interface WindowSize {
	widthM: number;
	heightM: number;
}

/**
 * Cell edge for a solve (plan §6.10): 4 m for a single path whose window's
 * longer side is at most 1.2 km, 6 m up to 2.5 km, 8 m beyond and for the
 * nearby list; `'cellCap'` when the window would exceed {@link MAX_GRID_CELLS}
 * cells at that size (the caller then routes on the road graph). With these
 * breakpoints 4 and 6 m stay far below the cap (≤ 174k cells), so the cap
 * only bites on 8 m windows over ~5 km.
 */
export function chooseCellSize(window: WindowSize, purpose: SolvePurpose): number | 'cellCap' {
	const side = Math.max(window.widthM, window.heightM);
	let cellM = GRID_CELL_M;
	if (purpose === 'path') {
		if (side <= FINE_WINDOW_MAX_M) cellM = FINE_CELL_M;
		else if (side <= MEDIUM_WINDOW_MAX_M) cellM = MEDIUM_CELL_M;
	}
	const cells = Math.ceil(window.widthM / cellM) * Math.ceil(window.heightM / cellM);
	return cells > MAX_GRID_CELLS ? 'cellCap' : cellM;
}

/** Extent of `bounds` in metres (longitude scaled at the mid latitude, as the grid does). */
export function windowSizeOf(bounds: GeoBounds): WindowSize {
	const midLat = (bounds.south + bounds.north) / 2;
	const mPerDegLng = Math.cos((midLat * Math.PI) / 180) * M_PER_DEG_LNG_EQUATOR;
	return {
		widthM: (bounds.east - bounds.west) * mPerDegLng,
		heightM: (bounds.north - bounds.south) * M_PER_DEG_LAT
	};
}

// ---------------------------------------------------------------------------
// I/O and cancellation
// ---------------------------------------------------------------------------

/** Where this realm's tile bytes come from, and (optionally) how DEM images are decoded. */
export interface RoutingIO {
	/** Basemap (`protomaps`) and DEM (`terrain`) tile bytes; `null` = unavailable. */
	fetchTile: TileFetcher;
	/** DEM image decoder; omitted = keep the realm's (browser `createImageBitmap`). */
	decodeDem?: DemTileDecoder;
}

const noTiles: TileFetcher = async () => null;
let fetchTile: TileFetcher = noTiles;

/**
 * Sets this realm's tile source (and DEM decoder) for the basemap obstacles,
 * the routing height raster and the route profile. Drops the routing context.
 */
export function configureRoutingIO(io: RoutingIO): void {
	fetchTile = io.fetchTile;
	setDemTileFetcher(io.fetchTile);
	if (io.decodeDem) setDemTileDecoder(io.decodeDem);
	context = null;
}

/**
 * A routing request was cancelled: superseded by a newer one on the same
 * channel (a location update), or the worker went away. Callers drop it
 * silently; it is never turned into a straight-line fallback.
 */
export class RoutingCancelledError extends Error {
	constructor(message = 'Routing request cancelled') {
		super(message);
		this.name = 'RoutingCancelledError';
	}
}

export function isRoutingCancelled(e: unknown): e is RoutingCancelledError {
	return e instanceof RoutingCancelledError;
}

/** Throws {@link RoutingCancelledError} when `signal` was aborted (checked after every await). */
function checkCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new RoutingCancelledError();
}

/** Why a route is simpler than asked for (plan §6.11); each maps to a chip. */
export type RouteFallback =
	| 'cellCap'
	| 'tileCap'
	| 'tooFar'
	| 'noRoadNearby'
	| 'gridUnreached'
	| 'thinBuildings';

export interface RoutingCoverage {
	basemap: BasemapCoverage['basemap'];
	/** DEM zoom the profile used: z14, the coarse z12, none (unavailable), or off (not asked for). */
	dem: 'z14' | 'z12' | 'none' | 'off';
	/**
	 * The `optimized` grid's slope raster: z14 or z12 for every cell, partial,
	 * none; `null` when the route was not solved on the grid (plan §6.9).
	 */
	slope: SlopeCoverage | null;
	/** Fences and walls are not in the map data (until the barrier extract). */
	barriers: 'unknown';
}

/** A routed (or straight fallback) hose line with everything the UI shows (plan §6.12). */
export interface HoseRoute {
	points: GeoPoint[];
	/**
	 * Length in metres: the 3D length of `points` over the DEM profile (plan
	 * §6.4), the 2D length without one. The ONE number shown everywhere.
	 */
	meters: number;
	/** 2D length of `points`; `segments` and `profile.s` are measured along it. */
	planMeters: number;
	/** Runs along the polyline in metres: off-road and steep class. */
	segments: RouteSegment[];
	/** Signed height(end) − height(start); `null` without DEM. */
	climbM: number | null;
	metersOver25: number;
	metersOver50: number;
	maxGradePct: number | null;
	offRoadMeters: number;
	/** Downhill static pressure at the lowest point (§6.13); `null` = not evaluated. */
	staticPressureMaxBar: number | null;
	pressureLevel: PressureLevel | null;
	/** Any slope trigger or the pressure warning. */
	notRecommended: boolean;
	/** Road-only length (2D), for the label comparison in `optimized` mode. */
	roadOnlyMeters: number | null;
	demZoom: number | null;
	fallback: RouteFallback | null;
	coverage: RoutingCoverage;
	/** False when the line is the straight fallback, not a route. */
	routed: boolean;
	/** Station distances and heights of the profile (pump-line pressure rule). */
	profile: { s: number[]; heights: number[] } | null;
	/** Cell edge (m) of the `optimized` grid the route was solved on; `null` off the grid. */
	cellM: number | null;
}

/** A target as a plain point or as a water-source access target. */
export type RouteTargetInput = GeoPoint | AccessTarget;

export type { HoseRoutingMode };

/** Router selection and inputs for the profile and pressure rule. */
export interface RoutingOptions {
	/** `optimized`: weighted cost grid; `roads`: road network only. */
	mode: HoseRoutingMode;
	/**
	 * Debug view and specs only: solve on this cell edge (m) instead of the
	 * adaptive choice ({@link chooseCellSize}).
	 */
	cellM?: number;
	/** Sample the DEM for steep runs and the pressure rule (default true). */
	profile?: boolean;
	/** Maximum hose working pressure in bar; the pressure rule runs only with it. */
	maxHosePressureBar?: number;
	/** Pressure at the water source (the route's END), in bar. */
	sourcePressureBar?: number;
	/** Single path only: also measure the road-only length (default true). */
	compareRoads?: boolean;
}

/** Options of the list search: one source pressure per target. */
export interface NearbyRoutingOptions extends RoutingOptions {
	sourcePressureBars?: number[];
}

/** One cost grid of a context (per cell size) and its height raster state. */
interface GridSlot {
	/** `null` = build failed (window above the cell cap). */
	grid: TerrainGrid | null;
	/** The DEM load in flight for the grid's height raster. */
	heightsLoad?: Promise<void>;
	/** The grid carries the full z14 raster: no more loads. */
	heightsComplete?: boolean;
}

interface RoutingContext {
	bounds: GeoBounds;
	obstacles: ObstacleData;
	coverage: BasemapCoverage;
	graph: RoadGraph;
	/**
	 * Lazily built cost grids by cell edge. The 8 m grid prices road-mode legs
	 * and carries the nearby list's memoised field; single paths add 4 or 6 m.
	 */
	grids: Map<number, GridSlot>;
	/** Lazily built road proximity test for the off-road classification. */
	nearRoad?: (p: GeoPoint) => boolean;
	builtAt: number;
}

let context: RoutingContext | null = null;

function isAccessTarget(target: RouteTargetInput): target is AccessTarget {
	return 'kind' in target;
}

/** The single point standing for a target (shore: its nearest point to the origin). */
function targetPoint(target: RouteTargetInput): GeoPoint {
	if (!isAccessTarget(target)) return target;
	return target.kind === 'point' ? target.point : target.fallback;
}

function gridGoal(target: RouteTargetInput): GridGoal {
	if (isAccessTarget(target) && target.kind === 'shore') {
		return { kind: 'shore', outline: target.outline };
	}
	return { kind: 'point', point: targetPoint(target) };
}

function roadTarget(target: RouteTargetInput): RoadTarget {
	if (isAccessTarget(target) && target.kind === 'shore') {
		return {
			points: sampleShore(target.outline, POND_SHORE_SAMPLE_M),
			maxSnapM: POND_SHORE_SNAP_M
		};
	}
	return targetPoint(target);
}

function gridSlot(ctx: RoutingContext, cellM: number): GridSlot {
	let slot = ctx.grids.get(cellM);
	if (!slot) {
		slot = { grid: buildOptimizedGrid(ctx.obstacles, ctx.bounds, cellM) };
		ctx.grids.set(cellM, slot);
	}
	return slot;
}

/** Lazily builds (once per cell size) and returns the context's cost grid, if feasible. */
function costGridFor(ctx: RoutingContext, cellM = GRID_CELL_M): TerrainGrid | null {
	return gridSlot(ctx, cellM).grid;
}

/**
 * Builds the context's `optimized` grid of `cellM` and attaches its height
 * raster (plan §6.4): z14 within the routing DEM budget, else z12, else no
 * slope. Concurrent callers share one load. A raster that is not complete (the
 * z14 tiles missed the budget) is loaded again on the next request, when the
 * late tiles are in the decode cache.
 */
async function prepareCostGrid(
	ctx: RoutingContext,
	cellM: number,
	budget: AbortSignal | undefined
): Promise<void> {
	if (ctx.coverage.thinBuildingTiles > 0) return;
	const slot = gridSlot(ctx, cellM);
	const grid = slot.grid;
	if (!grid || slot.heightsComplete) return;
	slot.heightsLoad ??= loadRoutingHeights(gridFrameOf(grid), budget).then((heights) => {
		slot.heightsComplete = isCompleteRoutingRaster(heights);
		// Keep a better raster than a worse retry (z14 partial over nothing, etc.).
		if (heights || grid.heights === undefined) setGridHeights(grid, heights);
		slot.heightsLoad = undefined;
	});
	await slot.heightsLoad;
}

/**
 * Cell edge of the `optimized` solve in `ctx` (plan §6.10). A single path
 * whose origin and target the nearby list's memoised 8 m field already
 * answers stays on that field, so the selected marker's line shows the list's
 * number (list = label = pump); otherwise {@link chooseCellSize} over the
 * context window.
 */
function solveCellSize(
	ctx: RoutingContext,
	origin: GeoPoint,
	targets: RouteTargetInput[],
	single: boolean,
	override: number | undefined
): number | 'cellCap' {
	if (override !== undefined) return override;
	if (single && targets.length === 1) {
		const listGrid = ctx.grids.get(GRID_CELL_M)?.grid;
		if (listGrid && memoCovers(listGrid, origin, gridGoal(targets[0]))) return GRID_CELL_M;
	}
	return chooseCellSize(windowSizeOf(ctx.bounds), single ? 'path' : 'list');
}

/** Bucket edge of the road proximity index. */
const ROAD_BUCKET_M = 50;

/**
 * Road proximity test ({@link OFF_ROAD_NEAR_M}) over a bucket index of the
 * context's roads, so classifying a long route does not scan every road.
 */
function nearRoadFor(ctx: RoutingContext): (p: GeoPoint) => boolean {
	if (ctx.nearRoad) return ctx.nearRoad;
	const midLat = (ctx.bounds.south + ctx.bounds.north) / 2;
	const mPerDegLng = Math.cos((midLat * Math.PI) / 180) * M_PER_DEG_LNG_EQUATOR;
	const key = (bx: number, by: number) => `${bx}_${by}`;
	const bucketX = (lng: number) => Math.floor((lng * mPerDegLng) / ROAD_BUCKET_M);
	const bucketY = (lat: number) => Math.floor((lat * M_PER_DEG_LAT) / ROAD_BUCKET_M);
	const buckets = new Map<string, RoadLine[]>();
	for (const road of ctx.obstacles.roads) {
		const [west, south, east, north] = road.bbox;
		for (let bx = bucketX(west); bx <= bucketX(east); bx++) {
			for (let by = bucketY(south); by <= bucketY(north); by++) {
				const list = buckets.get(key(bx, by));
				if (list) list.push(road);
				else buckets.set(key(bx, by), [road]);
			}
		}
	}
	ctx.nearRoad = (p: GeoPoint) => {
		const bx = bucketX(p.lng);
		const by = bucketY(p.lat);
		const candidates = new Set<RoadLine>();
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (const road of buckets.get(key(bx + dx, by + dy)) ?? []) candidates.add(road);
			}
		}
		return isNearAnyRoad(p, [...candidates], OFF_ROAD_NEAR_M);
	};
	return ctx.nearRoad;
}

export interface NearbyDistanceResult {
	/** Length of the routed polyline in meters, when routable. */
	routedDistance: number | null;
	/** Ranking key: routed distance, else the straight-line distance. */
	sortDistance: number;
	/** The routed line with its profile and warnings; `null` when not routed. */
	route: HoseRoute | null;
	/** Why the target was not routed as asked (also set on `route`). */
	fallback: RouteFallback | null;
}

/** Bounding box over `points` expanded by `marginM` meters. */
function boundsAround(points: GeoPoint[], marginM: number): GeoBounds {
	let south = Infinity;
	let west = Infinity;
	let north = -Infinity;
	let east = -Infinity;
	for (const p of points) {
		if (p.lat < south) south = p.lat;
		if (p.lat > north) north = p.lat;
		if (p.lng < west) west = p.lng;
		if (p.lng > east) east = p.lng;
	}
	const midLat = (south + north) / 2;
	const latMargin = marginM / M_PER_DEG_LAT;
	const lngMargin = marginM / (M_PER_DEG_LNG_EQUATOR * Math.cos((midLat * Math.PI) / 180));
	return {
		south: south - latMargin,
		west: west - lngMargin,
		north: north + latMargin,
		east: east + lngMargin
	};
}

/** `bounds` scaled about its centre by `factor`. */
function growBounds(bounds: GeoBounds, factor: number): GeoBounds {
	const midLat = (bounds.south + bounds.north) / 2;
	const midLng = (bounds.west + bounds.east) / 2;
	const halfLat = ((bounds.north - bounds.south) / 2) * factor;
	const halfLng = ((bounds.east - bounds.west) / 2) * factor;
	return {
		south: midLat - halfLat,
		north: midLat + halfLat,
		west: midLng - halfLng,
		east: midLng + halfLng
	};
}

/** True when a point of `points` lies within {@link EDGE_TOUCH_M} of the window edge. */
function touchesEdge(points: GeoPoint[], bounds: GeoBounds): boolean {
	const midLat = (bounds.south + bounds.north) / 2;
	const latM = EDGE_TOUCH_M / M_PER_DEG_LAT;
	const lngM = EDGE_TOUCH_M / (M_PER_DEG_LNG_EQUATOR * Math.cos((midLat * Math.PI) / 180));
	return points.some(
		(p) =>
			p.lat - bounds.south < latM ||
			bounds.north - p.lat < latM ||
			p.lng - bounds.west < lngM ||
			bounds.east - p.lng < lngM
	);
}

type RoutedTargets = { route: RawRoute | null; fallback: RouteFallback | null }[];

/**
 * Routes in a window around `origin` and the targets. `roads` keeps the window
 * bbox + 150 m. `optimized` uses bbox + max(150 m, 0.25 × the
 * longest straight distance) and, when a grid route touches the window edge or
 * a target is not reached on the grid, re-solves once in a window
 * {@link WINDOW_GROWTH} times larger (plan §6.5): the detour may lie outside.
 * `optimized` also widens the window to cover the road-mode routes to the
 * targets (plus {@link ROAD_ROUTE_MARGIN_M}, at most the farthest straight
 * distance beyond the endpoints): with slope in the cost the road round a
 * scarp is often the best route, and a window that cannot hold it would return
 * the steep shortcut without ever touching its edge.
 */
async function routeInWindow(
	origin: GeoPoint,
	targets: RouteTargetInput[],
	options: RoutingOptions,
	single: boolean,
	signal: AbortSignal | undefined,
	budget: AbortSignal | undefined
): Promise<{ ctx: RoutingContext; routed: RoutedTargets }> {
	const mode = options.mode;
	const points = [origin, ...targets.map(targetPoint)];
	let margin = BOUNDS_MARGIN_M;
	const farthest = Math.max(...points.map((p) => distanceTo(origin, p)));
	if (mode === 'optimized') margin = Math.max(BOUNDS_MARGIN_M, OPTIMIZED_MARGIN_SHARE * farthest);
	let bounds = boundsAround(points, margin);
	let ctx = await getContext(bounds, budget);
	checkCancelled(signal);
	let cellM: number | 'cellCap' = GRID_CELL_M;
	if (mode === 'optimized') {
		const roadPoints = roadRoutes(ctx, origin, targets).flatMap((r) => r?.points ?? []);
		if (roadPoints.length > 0) {
			// At most the farthest straight distance beyond the endpoints' bbox: a road
			// detour wider than that is never the cheaper route.
			const limit = boundsAround(points, Math.max(BOUNDS_MARGIN_M, farthest));
			const withRoads = intersectBounds(
				unionBounds(bounds, boundsAround(roadPoints, ROAD_ROUTE_MARGIN_M)),
				limit
			);
			if (!boundsCover(bounds, withRoads)) {
				bounds = withRoads;
				ctx = await getContext(bounds, budget);
				checkCancelled(signal);
			}
		}
		cellM = solveCellSize(ctx, origin, targets, single, options.cellM);
		if (cellM !== 'cellCap') await prepareCostGrid(ctx, cellM, budget);
		checkCancelled(signal);
	}
	let routed = routeAll(ctx, origin, targets, mode, single, cellM);
	if (
		mode === 'optimized' &&
		routed.some(
			(r) =>
				r.fallback === 'gridUnreached' ||
				r.route?.fallback === 'gridUnreached' ||
				(r.route?.grid !== undefined && touchesEdge(r.route.points, ctx.bounds))
		)
	) {
		bounds = growBounds(ctx.bounds, WINDOW_GROWTH);
		ctx = await getContext(bounds, budget);
		checkCancelled(signal);
		cellM = solveCellSize(ctx, origin, targets, single, options.cellM);
		if (cellM !== 'cellCap') await prepareCostGrid(ctx, cellM, budget);
		checkCancelled(signal);
		routed = routeAll(ctx, origin, targets, mode, single, cellM);
	}
	return { ctx, routed };
}

function unionBounds(a: GeoBounds, b: GeoBounds): GeoBounds {
	return {
		south: Math.min(a.south, b.south),
		west: Math.min(a.west, b.west),
		north: Math.max(a.north, b.north),
		east: Math.max(a.east, b.east)
	};
}

function intersectBounds(a: GeoBounds, b: GeoBounds): GeoBounds {
	return {
		south: Math.max(a.south, b.south),
		west: Math.max(a.west, b.west),
		north: Math.min(a.north, b.north),
		east: Math.min(a.east, b.east)
	};
}

function boundsCover(outer: GeoBounds, inner: GeoBounds): boolean {
	return (
		inner.south >= outer.south &&
		inner.north <= outer.north &&
		inner.west >= outer.west &&
		inner.east <= outer.east
	);
}

/**
 * Returns a routing context (decoded obstacles + built graph) covering
 * `bounds`, reusing the cached one while it still covers the query, is fresh
 * and had every tile. Tile decodes are additionally cached per tile
 * downstream, so a rebuild after a small move is cheap.
 */
async function getContext(
	bounds: GeoBounds,
	budget: AbortSignal | undefined
): Promise<RoutingContext> {
	const now = Date.now();
	if (
		context &&
		now - context.builtAt < CONTEXT_TTL_MS &&
		boundsCover(context.bounds, bounds) &&
		context.coverage.missingTiles === 0
	) {
		return context;
	}
	const { coverage, ...decoded } = await getObstaclesForBounds(bounds, fetchTile, budget);
	// Ferries, indoor corridors, tunnelled paths and military access take part in
	// neither the graph nor the grid (plan §6.3).
	const obstacles = { ...decoded, roads: routableRoads(decoded.roads) };
	context = {
		bounds,
		obstacles,
		coverage,
		graph: buildRoadGraph(obstacles.roads),
		grids: new Map(),
		builtAt: now
	};
	return context;
}

/** Drops the cached routing context (e.g. for tuning/testing). */
export function invalidateRoutingContext(): void {
	context = null;
}

function polylineMeters(points: GeoPoint[]): number {
	let total = 0;
	for (let i = 0; i < points.length - 1; i++) total += distanceTo(points[i], points[i + 1]);
	return total;
}

/** A route geometry before its profile is added. */
interface RawRoute {
	points: GeoPoint[];
	/** Road mode: polyline segments 0 and last are the snap legs (off-road). */
	roadLegs: boolean;
	/** `optimized`: off-road is read from the cost grid's cell classes. */
	grid?: TerrainGrid;
	routed: boolean;
	fallback: RouteFallback | null;
}

/**
 * Adds the DEM profile (steep runs, climb), the off-road runs and the
 * pressure rule to a route geometry. Water flows from the END of the line
 * (the water source) towards its start.
 */
async function finishRoute(
	raw: RawRoute,
	ctx: RoutingContext | null,
	options: RoutingOptions,
	sourcePressureBar: number | undefined,
	roadOnlyMeters: number | null,
	signal?: AbortSignal,
	budget?: AbortSignal
): Promise<HoseRoute> {
	const { points } = raw;
	const stations = resampleForProfile(points);
	const nearRoad = ctx ? nearRoadFor(ctx) : null;
	const lastSegment = points.length - 2;
	const grid = raw.grid;
	const nearRoadTest = (mid: GeoPoint) => (nearRoad ? !nearRoad(mid) : true);
	// `optimized`: on a road/path/steps/bridge cell, or within the same 6 m of a
	// road line as the other modes (an 8 m road band alone misses a centreline
	// near a cell edge, and smoothing cuts corners by a few metres).
	const isOffRoad: OffRoadTest = raw.roadLegs
		? (_mid, seg) => seg === 0 || seg === lastSegment
		: grid
			? (mid) => {
					const cls = cellClassAt(grid, mid);
					if (cls !== null && isOnRoadClass(cls as CellClass)) return false;
					return nearRoadTest(mid);
				}
			: nearRoadTest;
	let dem: { heights: number[]; zoom: number } | null = null;
	if (options.profile !== false) {
		try {
			dem = await sampleRouteElevations(stations.points, budget);
		} catch (e) {
			console.warn('Route profile elevation failed:', e);
		}
		checkCancelled(signal);
	}
	const profile = classifyRoute(stations, dem?.heights ?? null, {
		demZoom: dem?.zoom ?? null,
		isOffRoad
	});
	let pressure: ReturnType<typeof evaluateDownhillPressure> = null;
	if (profile.heights && options.maxHosePressureBar && sourcePressureBar !== undefined) {
		pressure = evaluateDownhillPressure(
			[{ heights: [...profile.heights].reverse(), sourceBar: sourcePressureBar }],
			options.maxHosePressureBar
		);
	}
	const coverageFallback: RouteFallback | null = ctx?.coverage.truncated ? 'tileCap' : null;
	// A thin-buildings fallback means the basemap is not complete enough for the grid.
	const basemap = raw.fallback === 'thinBuildings' ? 'partial' : (ctx?.coverage.basemap ?? 'none');
	const planMeters = polylineMeters(points);
	return {
		points,
		// 3D over the profile stations (every 5 m and every vertex); list, label
		// and pump line all show this one number.
		meters: profile.heights ? length3d(profile.s, profile.heights) : planMeters,
		planMeters,
		segments: profile.segments,
		climbM: profile.climbM,
		metersOver25: profile.metersOver25,
		metersOver50: profile.metersOver50,
		maxGradePct: profile.maxGradePct,
		offRoadMeters: profile.offRoadMeters,
		staticPressureMaxBar: pressure?.staticPressureMaxBar ?? null,
		pressureLevel: pressure?.level ?? null,
		notRecommended: slopeNotRecommended(profile) || pressure?.level === 'warning',
		roadOnlyMeters,
		demZoom: dem?.zoom ?? null,
		fallback: raw.fallback ?? coverageFallback,
		coverage: {
			basemap,
			dem: options.profile === false ? 'off' : dem ? (dem.zoom >= 14 ? 'z14' : 'z12') : 'none',
			slope: grid ? slopeCoverageOf(grid.heights) : null,
			barriers: 'unknown'
		},
		routed: raw.routed,
		profile: profile.heights ? { s: profile.s, heights: profile.heights } : null,
		cellM: raw.grid?.cellM ?? null
	};
}

/**
 * Price of a straight snap leg from an endpoint `a` (vehicle or water source)
 * to its road position `b`: the cost model along the line without slope, with
 * the escape zone around `a` (a hydrant at a wall, a vehicle in a yard). A leg
 * through water, rail or a building is not refused but priced at the escape
 * factor, so a point never loses its road access; without a grid (window over
 * the cell cap) the plain distance.
 */
function snapLegCost(grid: TerrainGrid | null, a: GeoPoint, b: GeoPoint): number {
	const straight = distanceTo(a, b);
	if (!grid) return straight;
	const cost = lineCost(grid, a, b, escapeZone(grid, [a]), 0, false);
	return Number.isFinite(cost) ? cost : straight * BUILDING_CORE_ESCAPE_FACTOR;
}

/**
 * Road-graph routes for the given targets (one Dijkstra), as raw routes. Snap
 * legs are priced by the cost model ({@link snapLegCost}); a pond's final shore
 * leg (up to 250 m) by the cost model along the straight line (plan §6.1,
 * §6.5), where a leg through water, rail or a building is not used.
 */
function roadRoutes(
	ctx: RoutingContext,
	origin: GeoPoint,
	targets: RouteTargetInput[]
): (RawRoute | null)[] {
	const grid = costGridFor(ctx);
	const legCost = (a: GeoPoint, b: GeoPoint) => snapLegCost(grid, a, b);
	const roadTargets = targets.map((target) => {
		const road = roadTarget(target);
		if (!('points' in road)) return road;
		if (!grid) return road;
		// From the road position to the shore point, lenient at the shore end.
		const shoreLeg = (shorePoint: GeoPoint, roadPoint: GeoPoint) =>
			lineCost(grid, roadPoint, shorePoint, undefined, SHORE_LEG_LENIENT_M, false);
		return { ...road, legCost: shoreLeg };
	});
	return routeFromOrigin(ctx.graph, origin, roadTargets, legCost).map((r) =>
		r ? { points: r.points, roadLegs: true, routed: true, fallback: null } : null
	);
}

/** Straight line for a target that could not be routed. */
function straightRoute(
	origin: GeoPoint,
	target: RouteTargetInput,
	fallback: RouteFallback
): RawRoute {
	return { points: [origin, targetPoint(target)], roadLegs: false, routed: false, fallback };
}

/**
 * Routes `origin` to every target in the selected mode, downgrading like the
 * single path does: grid too large → road graph (`cellCap`); a target the grid
 * does not reach → road graph (`gridUnreached`); a tile with thin building
 * data in the window → road graph (`thinBuildings`); no road → `null`
 * (`noRoadNearby`). `single` marks a one-target path request: `optimized` then
 * runs A* unless the list search already solved this origin. `cellM` is the
 * `optimized` grid's cell edge (`'cellCap'`: no grid, road graph).
 */
function routeAll(
	ctx: RoutingContext,
	origin: GeoPoint,
	targets: RouteTargetInput[],
	mode: HoseRoutingMode,
	single: boolean,
	cellM: number | 'cellCap'
): { route: RawRoute | null; fallback: RouteFallback | null }[] {
	const out: { route: RawRoute | null; fallback: RouteFallback | null }[] = targets.map(() => ({
		route: null,
		fallback: null
	}));
	let pending = targets.map((_, i) => i);
	let downgrade: RouteFallback | null = null;

	if (mode === 'optimized') {
		const thin = ctx.coverage.thinBuildingTiles > 0;
		const grid = thin || cellM === 'cellCap' ? null : costGridFor(ctx, cellM);
		if (!grid) {
			downgrade = thin ? 'thinBuildings' : 'cellCap';
		} else {
			const goals = pending.map((i) => gridGoal(targets[i]));
			let routeTo: (goal: GridGoal) => GridRoute | null;
			if (single) {
				routeTo = (goal) => gridRouteSingle(grid, origin, goal);
			} else {
				// One-to-many Dijkstra with early exit; the escape zones of every
				// point target belong to the one field.
				const endpoints = goals.flatMap((g) => (g.kind === 'point' ? [g.point] : []));
				const solve = solveTerrain(grid, origin, endpoints);
				routeTo = (goal) => (solve ? solve.routeTo(goal) : null);
			}
			const left: number[] = [];
			pending.forEach((i, k) => {
				const route = routeTo(goals[k]);
				if (route) {
					out[i].route = {
						points: route.points,
						roadLegs: false,
						grid,
						routed: true,
						fallback: null
					};
				} else {
					left.push(i);
				}
			});
			pending = left;
			downgrade = 'gridUnreached';
		}
	}

	if (pending.length > 0) {
		const roads = roadRoutes(
			ctx,
			origin,
			pending.map((i) => targets[i])
		);
		pending.forEach((i, k) => {
			const route = roads[k];
			if (route) {
				route.fallback = downgrade;
				out[i] = { route, fallback: downgrade };
			} else {
				out[i] = {
					route: null,
					fallback: downgrade === 'thinBuildings' ? downgrade : 'noRoadNearby'
				};
			}
		});
	}
	return out;
}

/**
 * Computes the routed distances (and routes) for the nearby list.
 *
 * @param origin - The searcher's location.
 * @param targets - Marker positions or access targets, parallel to `straightDistances`.
 * @param straightDistances - Precomputed haversine distances in meters.
 * @param signal - Cancels the request at its next await ({@link RoutingCancelledError}).
 * @return One result per target; on any failure every marker falls back to its
 *         straight-line distance (haversine order).
 */
export async function routeNearby(
	origin: GeoPoint,
	targets: RouteTargetInput[],
	straightDistances: number[],
	options: NearbyRoutingOptions = { mode: 'optimized' },
	signal?: AbortSignal
): Promise<NearbyDistanceResult[]> {
	const results: NearbyDistanceResult[] = straightDistances.map((d) => ({
		routedDistance: null,
		sortDistance: d,
		route: null,
		fallback: d > ROUTING_MAX_STRAIGHT_M ? 'tooFar' : null
	}));

	// Nearest-first candidates within the routing horizon, capped.
	const ranked = straightDistances
		.map((distance, index) => ({ distance, index }))
		.filter((c) => c.distance <= ROUTING_MAX_STRAIGHT_M)
		.sort((a, b) => a.distance - b.distance);
	const candidates = ranked.slice(0, MAX_ROUTED_TARGETS).map((c) => c.index);
	for (const c of ranked.slice(MAX_ROUTED_TARGETS)) results[c.index].fallback = 'tooFar';
	if (candidates.length === 0) return results;

	// One budget for every remote wait of this request (plan §6.9).
	const budget = createBudget(ROUTING_DATA_BUDGET_MS);
	try {
		const candidateTargets = candidates.map((i) => targets[i]);
		const { ctx, routed } = await routeInWindow(
			origin,
			candidateTargets,
			options,
			false,
			signal,
			budget.signal
		);

		for (let k = 0; k < candidates.length; k++) {
			const targetIndex = candidates[k];
			const { route: raw, fallback } = routed[k];
			if (raw) {
				const route = await finishRoute(
					raw,
					ctx,
					options,
					options.sourcePressureBars?.[targetIndex],
					null,
					signal,
					budget.signal
				);
				results[targetIndex] = {
					routedDistance: route.meters,
					// Rank by the geometric length too — the list must never look
					// unsorted against the displayed meters. The priced cost only
					// picks the best route per marker inside the routers. (Guard:
					// a route can never beat the straight line.)
					sortDistance: Math.max(route.meters, straightDistances[targetIndex]),
					route,
					fallback: route.fallback
				};
			} else {
				// Off-network marker: ranked by its straight-line distance.
				results[targetIndex] = {
					routedDistance: null,
					sortDistance: straightDistances[targetIndex],
					route: null,
					fallback
				};
			}
		}
	} catch (e) {
		if (isRoutingCancelled(e)) throw e;
		console.warn('Road-aware ranking failed, falling back to straight-line order:', e);
	} finally {
		budget.dispose();
	}

	return results;
}

/**
 * Routed display line `origin` → `target`. Never `null`: when the target
 * cannot be routed the straight line comes back with `routed: false` and the
 * reason in `fallback`. A cancelled request rejects with
 * {@link RoutingCancelledError}.
 */
export async function routePath(
	origin: GeoPoint,
	target: RouteTargetInput,
	options: RoutingOptions = { mode: 'optimized' },
	signal?: AbortSignal
): Promise<HoseRoute> {
	const end = targetPoint(target);
	if (distanceTo(origin, end) > PATH_MAX_STRAIGHT_M) {
		return finishRoute(
			straightRoute(origin, target, 'tooFar'),
			null,
			options,
			options.sourcePressureBar,
			null
		);
	}
	let ctx: RoutingContext | null = null;
	const budget = createBudget(ROUTING_DATA_BUDGET_MS);
	try {
		const window = await routeInWindow(origin, [target], options, true, signal, budget.signal);
		ctx = window.ctx;
		const [{ route, fallback }] = window.routed;
		let roadOnlyMeters: number | null = null;
		if (route && options.mode !== 'roads' && options.compareRoads !== false) {
			const [road] = roadRoutes(ctx, origin, [target]);
			roadOnlyMeters = road ? polylineMeters(road.points) : null;
		}
		const raw = route ?? straightRoute(origin, target, fallback ?? 'noRoadNearby');
		return await finishRoute(
			raw,
			ctx,
			options,
			options.sourcePressureBar,
			roadOnlyMeters,
			signal,
			budget.signal
		);
	} catch (e) {
		if (isRoutingCancelled(e)) throw e;
		console.warn('Routed path failed, falling back to straight line:', e);
		return finishRoute(
			straightRoute(origin, target, 'noRoadNearby'),
			ctx,
			{ ...options, profile: false },
			undefined,
			null
		);
	} finally {
		budget.dispose();
	}
}
