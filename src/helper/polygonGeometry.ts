import type { FeatureBBox } from '@/types/obstacles';

/**
 * Exact segment/polygon tests for hose routing (plan §6.6). Coordinates are
 * `[lng, lat]` degrees. The predicates only use orientation signs, which an
 * affine map (degrees → local metres) preserves, so no projection is needed.
 *
 * Pure module: no store, map or network dependencies.
 */

export type LngLat = [number, number];

/** A polygon with its bbox: outer ring first, holes after (closed rings). */
export interface PolygonRings {
	bbox: FeatureBBox;
	rings: LngLat[][];
}

/** Sign of the turn a → b → c: > 0 left, < 0 right, 0 collinear. */
function orient(a: LngLat, b: LngLat, c: LngLat): number {
	return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** True when `p` (known collinear with a–b) lies within the segment's bbox. */
function onSegment(a: LngLat, b: LngLat, p: LngLat): boolean {
	return (
		Math.min(a[0], b[0]) <= p[0] &&
		p[0] <= Math.max(a[0], b[0]) &&
		Math.min(a[1], b[1]) <= p[1] &&
		p[1] <= Math.max(a[1], b[1])
	);
}

/**
 * True when segments a–b and c–d share at least one point: a proper crossing,
 * a touch at an end or vertex, or a collinear overlap.
 */
export function segmentsIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
	const o1 = orient(a, b, c);
	const o2 = orient(a, b, d);
	const o3 = orient(c, d, a);
	const o4 = orient(c, d, b);
	if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
		return true;
	}
	if (o1 === 0 && onSegment(a, b, c)) return true;
	if (o2 === 0 && onSegment(a, b, d)) return true;
	if (o3 === 0 && onSegment(c, d, a)) return true;
	if (o4 === 0 && onSegment(c, d, b)) return true;
	return false;
}

/** Even-odd test of a point against every ring (outer and holes alike). */
export function pointInRings(lng: number, lat: number, rings: LngLat[][]): boolean {
	let inside = false;
	for (const ring of rings) {
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [xi, yi] = ring[i];
			const [xj, yj] = ring[j];
			if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
				inside = !inside;
			}
		}
	}
	return inside;
}

/** True when the point lies inside the outer ring and outside every hole. */
export function pointInPolygon(lng: number, lat: number, polygon: PolygonRings): boolean {
	const [west, south, east, north] = polygon.bbox;
	if (lng < west || lng > east || lat < south || lat > north) return false;
	return pointInRings(lng, lat, polygon.rings);
}

/**
 * True when segment a–b touches the polygon: it crosses or touches any ring
 * edge (holes included), or lies fully inside the area. A segment that lies
 * entirely inside a hole does not hit. A bbox test rejects far polygons first.
 */
export function segmentIntersectsPolygon(a: LngLat, b: LngLat, polygon: PolygonRings): boolean {
	const [west, south, east, north] = polygon.bbox;
	if (
		Math.max(a[0], b[0]) < west ||
		Math.min(a[0], b[0]) > east ||
		Math.max(a[1], b[1]) < south ||
		Math.min(a[1], b[1]) > north
	) {
		return false;
	}
	for (const ring of polygon.rings) {
		for (let i = 0; i + 1 < ring.length; i++) {
			if (segmentsIntersect(a, b, ring[i], ring[i + 1])) return true;
		}
		// Rings are closed in the data, but be safe with open ones.
		const first = ring[0];
		const last = ring[ring.length - 1];
		if (
			ring.length > 2 &&
			(first[0] !== last[0] || first[1] !== last[1]) &&
			segmentsIntersect(a, b, last, first)
		) {
			return true;
		}
	}
	// No edge contact: the segment is either fully inside or fully outside.
	return pointInRings(a[0], a[1], polygon.rings);
}

/** True when segment a–b touches any of `polygons`. */
export function segmentIntersectsAny(a: LngLat, b: LngLat, polygons: PolygonRings[]): boolean {
	for (const polygon of polygons) {
		if (segmentIntersectsPolygon(a, b, polygon)) return true;
	}
	return false;
}
