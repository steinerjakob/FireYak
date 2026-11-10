import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';
import { BasemapCoverage, ObstacleData, RoadLine } from '@/types/obstacles';
import { getObstaclesForBounds } from '@/mapHandler/obstacleGeometry';
import {
	POND_SHORE_SNAP_M,
	RoadGraph,
	RoadTarget,
	buildRoadGraph,
	routeFromOrigin
} from '@/mapHandler/roadRouting';
import {
	GridGoal,
	GridRoute,
	TerrainGrid,
	buildOptimizedGrid,
	buildTerrainGrid,
	cellClassAt,
	gridRouteSingle,
	lineCost,
	solveTerrain
} from '@/mapHandler/gridRouting';
import { routableRoads } from '@/mapHandler/costGrid';
import { isOnRoadClass, type CellClass } from '@/mapHandler/hoseCostModel';
import type { HoseRoutingMode } from '@/helper/hoseRoutingSetting';
import { effectiveDistanceMeters, isNearAnyRoad } from '@/helper/weightedDistance';
import { sampleShore } from '@/helper/areaShore';
import {
	OFF_ROAD_NEAR_M,
	OffRoadTest,
	RouteSegment,
	classifyRoute,
	resampleForProfile,
	slopeNotRecommended
} from '@/helper/routeProfile';
import { PressureLevel, evaluateDownhillPressure } from '@/helper/hosePressure';
import { sampleRouteElevations } from '@/helper/demElevation';
import type { AccessTarget } from '@/mapHandler/waterSourceAccess';

/**
 * Hose routing for the nearby water sources list, the marker path and the
 * pump line. The `mode` option picks the router: `roads` (road graph),
 * `direct` (terrain grid that may cross gardens/open ground while avoiding
 * buildings) or `optimized` (the weighted cost grid of `hoseCostModel.ts`,
 * a preview until phase 5). Every route comes back as a
 * {@link HoseRoute}: one polyline whose length is the one number shown
 * everywhere, its steep/off-road runs, the slope and pressure warnings, and
 * the reason when it fell back to something simpler. Fails open: any error
 * yields the straight line (marked as such), the list must never break
 * because of this feature.
 */

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
/** A grid route within this distance of the window edge "touches" it. */
const EDGE_TOUCH_M = 16;
/** Rebuild the road graph after this long even if the window still covers the query. */
const CONTEXT_TTL_MS = 60_000;

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQUATOR = 111320;

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
	/** DEM zoom the profile used: z14, the coarse z12, or none. */
	dem: 'z14' | 'z12' | 'none';
	/** Fences and walls are not in the map data (until the barrier extract). */
	barriers: 'unknown';
}

/** A routed (or straight fallback) hose line with everything the UI shows (plan §6.12). */
export interface HoseRoute {
	points: GeoPoint[];
	/** Length of `points` in metres (2D): the ONE number shown everywhere. */
	meters: number;
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
	/** Road-only length, for the label comparison in terrain mode. */
	roadOnlyMeters: number | null;
	demZoom: number | null;
	fallback: RouteFallback | null;
	coverage: RoutingCoverage;
	/** False when the line is the straight fallback, not a route. */
	routed: boolean;
	/** Station distances and heights of the profile (pump-line pressure rule). */
	profile: { s: number[]; heights: number[] } | null;
}

/** A target as a plain point or as a water-source access target. */
export type RouteTargetInput = GeoPoint | AccessTarget;

export type { HoseRoutingMode };

/** Router selection and inputs for the profile and pressure rule. */
export interface RoutingOptions {
	/** `roads`: road network only; `direct`: terrain grid; `optimized`: weighted cost grid. */
	mode: HoseRoutingMode;
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

interface RoutingContext {
	bounds: GeoBounds;
	obstacles: ObstacleData;
	coverage: BasemapCoverage;
	graph: RoadGraph;
	/** Lazily built `direct` terrain grid; `null` = build failed (window too large). */
	terrain?: TerrainGrid | null;
	/** Lazily built `optimized` cost grid; `null` = build failed (window too large). */
	costGrid?: TerrainGrid | null;
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

/** Lazily builds (once) and returns the context's terrain grid, if feasible. */
function terrainFor(ctx: RoutingContext): TerrainGrid | null {
	if (ctx.terrain === undefined) {
		ctx.terrain = buildTerrainGrid(ctx.obstacles, ctx.bounds);
	}
	return ctx.terrain;
}

/** Lazily builds (once) and returns the context's `optimized` cost grid, if feasible. */
function costGridFor(ctx: RoutingContext): TerrainGrid | null {
	if (ctx.costGrid === undefined) {
		ctx.costGrid = buildOptimizedGrid(ctx.obstacles, ctx.bounds);
	}
	return ctx.costGrid;
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
	/** Ranking key: routed distance, else weighted heuristic, else straight-line. */
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
 * Routes in a window around `origin` and the targets. `direct` and `roads` keep
 * today's window (bbox + 150 m). `optimized` uses bbox + max(150 m, 0.25 × the
 * longest straight distance) and, when a grid route touches the window edge or
 * a target is not reached on the grid, re-solves once in a window
 * {@link WINDOW_GROWTH} times larger (plan §6.5): the detour may lie outside.
 */
async function routeInWindow(
	origin: GeoPoint,
	targets: RouteTargetInput[],
	mode: HoseRoutingMode,
	single: boolean
): Promise<{ ctx: RoutingContext; routed: RoutedTargets }> {
	const points = [origin, ...targets.map(targetPoint)];
	let margin = BOUNDS_MARGIN_M;
	if (mode === 'optimized') {
		const farthest = Math.max(...points.map((p) => distanceTo(origin, p)));
		margin = Math.max(BOUNDS_MARGIN_M, OPTIMIZED_MARGIN_SHARE * farthest);
	}
	let bounds = boundsAround(points, margin);
	let ctx = await getContext(bounds);
	let routed = routeAll(ctx, origin, targets, mode, single);
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
		ctx = await getContext(bounds);
		routed = routeAll(ctx, origin, targets, mode, single);
	}
	return { ctx, routed };
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
async function getContext(bounds: GeoBounds): Promise<RoutingContext> {
	const now = Date.now();
	if (
		context &&
		now - context.builtAt < CONTEXT_TTL_MS &&
		boundsCover(context.bounds, bounds) &&
		context.coverage.missingTiles === 0
	) {
		return context;
	}
	const { coverage, ...decoded } = await getObstaclesForBounds(bounds);
	// Ferries, indoor corridors, tunnelled paths and military access take part in
	// neither the graph nor the grids (plan §6.3).
	const obstacles = { ...decoded, roads: routableRoads(decoded.roads) };
	context = {
		bounds,
		obstacles,
		coverage,
		graph: buildRoadGraph(obstacles.roads),
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
	roadOnlyMeters: number | null
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
			dem = await sampleRouteElevations(stations.points);
		} catch (e) {
			console.warn('Route profile elevation failed:', e);
		}
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
	return {
		points,
		meters: polylineMeters(points),
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
			dem: dem ? (dem.zoom >= 14 ? 'z14' : 'z12') : 'none',
			barriers: 'unknown'
		},
		routed: raw.routed,
		profile: profile.heights ? { s: profile.s, heights: profile.heights } : null
	};
}

/**
 * Road-graph routes for the given targets (one Dijkstra), as raw routes. The
 * snap legs are priced by the weighted heuristic; a pond's final shore leg (up
 * to 250 m) by the cost model along the straight line (plan §6.1, §6.5), so it
 * cannot run through water, rail or a building.
 */
function roadRoutes(
	ctx: RoutingContext,
	origin: GeoPoint,
	targets: RouteTargetInput[]
): (RawRoute | null)[] {
	const legCost = (a: GeoPoint, b: GeoPoint) => effectiveDistanceMeters(a, b, ctx.obstacles);
	const roadTargets = targets.map((target) => {
		const road = roadTarget(target);
		if (!('points' in road)) return road;
		const grid = costGridFor(ctx);
		if (!grid) return road;
		// From the road position to the shore point, lenient at the shore end.
		const shoreLeg = (shorePoint: GeoPoint, roadPoint: GeoPoint) =>
			lineCost(grid, roadPoint, shorePoint, undefined, SHORE_LEG_LENIENT_M);
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
 * does not reach → road graph (`gridUnreached`); `optimized` over a tile with
 * thin building data → road graph (`thinBuildings`); no road → `null`
 * (`noRoadNearby`). `single` marks a one-target path request: `optimized` then
 * runs A* unless the list search already solved this origin.
 */
function routeAll(
	ctx: RoutingContext,
	origin: GeoPoint,
	targets: RouteTargetInput[],
	mode: HoseRoutingMode,
	single = false
): { route: RawRoute | null; fallback: RouteFallback | null }[] {
	const out: { route: RawRoute | null; fallback: RouteFallback | null }[] = targets.map(() => ({
		route: null,
		fallback: null
	}));
	let pending = targets.map((_, i) => i);
	let downgrade: RouteFallback | null = null;

	if (mode === 'direct') {
		const terrain = terrainFor(ctx);
		const solve = terrain ? solveTerrain(terrain, origin) : null;
		if (!solve) {
			downgrade = terrain ? 'gridUnreached' : 'cellCap';
		} else {
			const left: number[] = [];
			for (const i of pending) {
				const route = solve.routeTo(gridGoal(targets[i]));
				if (route)
					out[i].route = { points: route.points, roadLegs: false, routed: true, fallback: null };
				else left.push(i);
			}
			pending = left;
			downgrade = 'gridUnreached';
		}
	} else if (mode === 'optimized') {
		const thin = ctx.coverage.thinBuildingTiles > 0;
		const grid = thin ? null : costGridFor(ctx);
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
 * @return One result per target; on any failure every marker falls back to its
 *         straight-line distance (haversine order).
 */
export async function computeNearbyDistances(
	origin: GeoPoint,
	targets: RouteTargetInput[],
	straightDistances: number[],
	options: NearbyRoutingOptions = { mode: 'direct' }
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

	try {
		const candidateTargets = candidates.map((i) => targets[i]);
		const { ctx, routed } = await routeInWindow(origin, candidateTargets, options.mode, false);

		for (let k = 0; k < candidates.length; k++) {
			const targetIndex = candidates[k];
			const { route: raw, fallback } = routed[k];
			if (raw) {
				const route = await finishRoute(
					raw,
					ctx,
					options,
					options.sourcePressureBars?.[targetIndex],
					null
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
				// Off-network marker: weighted straight-line heuristic instead.
				results[targetIndex] = {
					routedDistance: null,
					sortDistance: effectiveDistanceMeters(
						origin,
						targetPoint(targets[targetIndex]),
						ctx.obstacles
					),
					route: null,
					fallback
				};
			}
		}
	} catch (e) {
		console.warn('Road-aware ranking failed, falling back to straight-line order:', e);
	}

	return results;
}

/**
 * Routed display line `origin` → `target`. Never `null`: when the target
 * cannot be routed the straight line comes back with `routed: false` and the
 * reason in `fallback`.
 */
export async function getRoutedPath(
	origin: GeoPoint,
	target: RouteTargetInput,
	options: RoutingOptions = { mode: 'direct' }
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
	try {
		const window = await routeInWindow(origin, [target], options.mode, true);
		ctx = window.ctx;
		const [{ route, fallback }] = window.routed;
		let roadOnlyMeters: number | null = null;
		if (route && options.mode !== 'roads' && options.compareRoads !== false) {
			const [road] = roadRoutes(ctx, origin, [target]);
			roadOnlyMeters = road ? polylineMeters(road.points) : null;
		}
		const raw = route ?? straightRoute(origin, target, fallback ?? 'noRoadNearby');
		return await finishRoute(raw, ctx, options, options.sourcePressureBar, roadOnlyMeters);
	} catch (e) {
		console.warn('Routed path failed, falling back to straight line:', e);
		return finishRoute(
			straightRoute(origin, target, 'noRoadNearby'),
			ctx,
			{ ...options, profile: false },
			undefined,
			null
		);
	}
}
