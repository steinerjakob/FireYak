import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';
import { ObstacleData } from '@/types/obstacles';
import { getObstaclesForBounds } from '@/mapHandler/obstacleGeometry';
import { buildRoadGraph, routeFromOrigin, routePath, RoadGraph } from '@/mapHandler/roadRouting';
import {
	buildTerrainGrid,
	gridRoutePath,
	solveTerrain,
	TerrainGrid
} from '@/mapHandler/gridRouting';
import { effectiveDistanceMeters } from '@/helper/weightedDistance';

/**
 * Road-aware ranking for the nearby water sources list. Ranks by (in order of
 * preference per marker): routed distance → weighted straight-line heuristic
 * (buildings penalized, roads rewarded) → plain haversine. Two routers back
 * the routed distance, chosen by the `clampToRoads` option: strict
 * road-network routing (graph) or terrain routing that may cross gardens/open
 * ground while avoiding buildings (grid). Fails open: any error anywhere
 * yields the haversine order, the list must never break because of this
 * feature.
 */

/** Only markers within this straight-line distance get the routed treatment. */
export const ROUTING_MAX_STRAIGHT_M = 1500;
/** Cap on markers routed/weighted per search (they're processed nearest-first). */
export const MAX_ROUTED_TARGETS = 30;
/** Margin around the candidate bbox so snapping (≤100 m) never leaves the tile window. */
const BOUNDS_MARGIN_M = 150;
/** Rebuild the road graph after this long even if the window still covers the query. */
const CONTEXT_TTL_MS = 60_000;

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_EQUATOR = 111320;

interface RoutingContext {
	bounds: GeoBounds;
	obstacles: ObstacleData;
	graph: RoadGraph;
	/** Lazily built terrain grid; `null` = build failed (window too large). */
	terrain?: TerrainGrid | null;
	builtAt: number;
}

let context: RoutingContext | null = null;

/** Router selection for the routed distance/path. */
export interface RoutingOptions {
	/** True = stick to the road network; false = terrain routing (gardens allowed). */
	clampToRoads: boolean;
}

/** Lazily builds (once) and returns the context's terrain grid, if feasible. */
function terrainFor(ctx: RoutingContext): TerrainGrid | null {
	if (ctx.terrain === undefined) {
		ctx.terrain = buildTerrainGrid(ctx.obstacles, ctx.bounds);
	}
	return ctx.terrain;
}

export interface NearbyDistanceResult {
	/** Distance along the road network in meters, when routable. */
	routedDistance: number | null;
	/** Ranking key: routed distance, else weighted heuristic, else straight-line. */
	sortDistance: number;
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
 * `bounds`, reusing the cached one while it still covers the query and is
 * fresh. Tile decodes are additionally cached per tile downstream, so a
 * rebuild after a small move is cheap.
 */
async function getContext(bounds: GeoBounds): Promise<RoutingContext> {
	const now = Date.now();
	if (context && now - context.builtAt < CONTEXT_TTL_MS && boundsCover(context.bounds, bounds)) {
		return context;
	}
	const obstacles = await getObstaclesForBounds(bounds);
	context = {
		bounds,
		obstacles,
		graph: buildRoadGraph(obstacles.roads),
		builtAt: now
	};
	return context;
}

/** Drops the cached routing context (e.g. for tuning/testing). */
export function invalidateRoutingContext(): void {
	context = null;
}

/**
 * Computes the road-aware ranking distances for the nearby list.
 *
 * @param origin - The searcher's location.
 * @param targets - Marker positions, parallel to `straightDistances`.
 * @param straightDistances - Precomputed haversine distances in meters.
 * @return One result per target; on any failure every marker falls back to its
 *         straight-line distance (haversine order).
 */
export async function computeNearbyDistances(
	origin: GeoPoint,
	targets: GeoPoint[],
	straightDistances: number[],
	options: RoutingOptions = { clampToRoads: false }
): Promise<NearbyDistanceResult[]> {
	const results: NearbyDistanceResult[] = straightDistances.map((d) => ({
		routedDistance: null,
		sortDistance: d
	}));

	// Nearest-first candidates within the routing horizon, capped.
	const candidates = straightDistances
		.map((distance, index) => ({ distance, index }))
		.filter((c) => c.distance <= ROUTING_MAX_STRAIGHT_M)
		.sort((a, b) => a.distance - b.distance)
		.slice(0, MAX_ROUTED_TARGETS)
		.map((c) => c.index);
	if (candidates.length === 0) return results;

	try {
		const candidatePoints = candidates.map((i) => targets[i]);
		const bounds = boundsAround([origin, ...candidatePoints], BOUNDS_MARGIN_M);
		const ctx = await getContext(bounds);
		const { graph, obstacles } = ctx;

		// Terrain routing (gardens allowed) unless clamped to roads; falls back
		// to the graph when the grid can't be built for this window.
		const terrainSolve = options.clampToRoads
			? null
			: (() => {
					const terrain = terrainFor(ctx);
					return terrain ? solveTerrain(terrain, origin) : null;
				})();

		// Price the point↔road legs with the building-aware heuristic so a snap
		// candidate across a building block never beats one along open ground.
		const legCost = (a: GeoPoint, b: GeoPoint) => effectiveDistanceMeters(a, b, obstacles);
		const routed = terrainSolve
			? candidatePoints.map((p) => terrainSolve.distanceTo(p))
			: routeFromOrigin(graph, origin, candidatePoints, legCost);
		candidates.forEach((targetIndex, i) => {
			const route = routed[i];
			if (route !== null) {
				results[targetIndex] = {
					routedDistance: route.meters,
					// Rank by the geometric length too — the list must never look
					// unsorted against the displayed meters. The priced cost only
					// picks the best route per marker inside the routers. (Guard:
					// a route can never beat the straight line.)
					sortDistance: Math.max(route.meters, straightDistances[targetIndex])
				};
			} else {
				// Off-network marker: weighted straight-line heuristic instead.
				results[targetIndex] = {
					routedDistance: null,
					sortDistance: effectiveDistanceMeters(origin, targets[targetIndex], obstacles)
				};
			}
		});
	} catch (e) {
		console.warn('Road-aware ranking failed, falling back to straight-line order:', e);
	}

	return results;
}

/**
 * Routed display polyline `origin` → `target`, or `null` when unroutable (the
 * caller draws the straight line instead).
 */
export async function getRoutedPath(
	origin: GeoPoint,
	target: GeoPoint,
	options: RoutingOptions = { clampToRoads: false }
): Promise<GeoPoint[] | null> {
	if (distanceTo(origin, target) > ROUTING_MAX_STRAIGHT_M * 2) return null;
	try {
		const bounds = boundsAround([origin, target], BOUNDS_MARGIN_M);
		const ctx = await getContext(bounds);
		const { graph, obstacles } = ctx;
		if (!options.clampToRoads) {
			const terrain = terrainFor(ctx);
			const terrainPath = terrain ? gridRoutePath(terrain, origin, target) : null;
			if (terrainPath) return terrainPath;
			// Grid unavailable/unreached → try the road graph before giving up.
		}
		const legCost = (a: GeoPoint, b: GeoPoint) => effectiveDistanceMeters(a, b, obstacles);
		return routePath(graph, origin, target, legCost);
	} catch (e) {
		console.warn('Routed path failed, falling back to straight line:', e);
		return null;
	}
}
