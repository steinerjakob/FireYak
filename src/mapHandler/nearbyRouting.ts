import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';
import { ObstacleData } from '@/types/obstacles';
import { getObstaclesForBounds } from '@/mapHandler/obstacleGeometry';
import { buildRoadGraph, routeFromOrigin, routePath, RoadGraph } from '@/mapHandler/roadRouting';
import { effectiveDistanceMeters } from '@/helper/weightedDistance';

/**
 * Road-aware ranking for the nearby water sources list. Ranks by (in order of
 * preference per marker): routed distance along the road network → weighted
 * straight-line heuristic (buildings penalized, roads rewarded) → plain
 * haversine. Fails open: any error anywhere yields the haversine order, the
 * list must never break because of this feature.
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
	builtAt: number;
}

let context: RoutingContext | null = null;

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
	straightDistances: number[]
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
		const { graph, obstacles } = await getContext(bounds);

		const routed = routeFromOrigin(graph, origin, candidatePoints);
		candidates.forEach((targetIndex, i) => {
			const routedDistance = routed[i];
			if (routedDistance !== null) {
				results[targetIndex] = {
					routedDistance,
					// A route can never beat the straight line; guard against snap artifacts.
					sortDistance: Math.max(routedDistance, straightDistances[targetIndex])
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
	target: GeoPoint
): Promise<GeoPoint[] | null> {
	if (distanceTo(origin, target) > ROUTING_MAX_STRAIGHT_M * 2) return null;
	try {
		const bounds = boundsAround([origin, target], BOUNDS_MARGIN_M);
		const { graph } = await getContext(bounds);
		return routePath(graph, origin, target);
	} catch (e) {
		console.warn('Routed path failed, falling back to straight line:', e);
		return null;
	}
}
