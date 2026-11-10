import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';

/**
 * Pure geometry helpers for measuring to the shore of a water area instead of
 * its center (issue #110).
 *
 * Outlines are GeoJSON in lon/lat degrees. Distances are worked out in a local
 * equirectangular projection around the query point: at the few kilometres a
 * pond is away from a fire point the error is far below a hose length.
 */

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG_EQUATOR = 111_320;

type Ring = GeoJSON.Position[];

/** Every line of an outline: polygon rings and (multi)line strings alike. */
export function outlineLines(geometry: GeoJSON.Geometry | null | undefined): Ring[] {
	if (!geometry) return [];
	switch (geometry.type) {
		case 'Polygon':
			return geometry.coordinates;
		case 'MultiPolygon':
			return geometry.coordinates.flat();
		case 'LineString':
			return [geometry.coordinates];
		case 'MultiLineString':
			return geometry.coordinates;
		case 'GeometryCollection':
			return geometry.geometries.flatMap(outlineLines);
		default:
			return [];
	}
}

/** Lon/lat bounds of an outline, or `null` when it has no vertices. */
export function outlineBounds(geometry: GeoJSON.Geometry | null | undefined): GeoBounds | null {
	let south = Infinity;
	let west = Infinity;
	let north = -Infinity;
	let east = -Infinity;
	for (const line of outlineLines(geometry)) {
		for (const [lng, lat] of line) {
			if (lat < south) south = lat;
			if (lat > north) north = lat;
			if (lng < west) west = lng;
			if (lng > east) east = lng;
		}
	}
	return south === Infinity ? null : { south, west, north, east };
}

/** `bounds` grown by `marginM` meters on every side. */
export function expandBounds(bounds: GeoBounds, marginM: number): GeoBounds {
	const midLat = (bounds.south + bounds.north) / 2;
	const latMargin = marginM / M_PER_DEG_LAT;
	const lngMargin = marginM / (M_PER_DEG_LNG_EQUATOR * Math.cos((midLat * Math.PI) / 180));
	return {
		south: bounds.south - latMargin,
		north: bounds.north + latMargin,
		west: bounds.west - lngMargin,
		east: bounds.east + lngMargin
	};
}

/** Local projection to meters around `origin` (x east, y north) and back. */
function projection(origin: GeoPoint) {
	const kx = M_PER_DEG_LNG_EQUATOR * Math.cos((origin.lat * Math.PI) / 180);
	const ky = M_PER_DEG_LAT;
	return {
		toXY: ([lng, lat]: GeoJSON.Position): [number, number] => [
			(lng - origin.lng) * kx,
			(lat - origin.lat) * ky
		],
		toGeo: (x: number, y: number): GeoPoint => ({
			lat: origin.lat + y / ky,
			lng: origin.lng + x / kx
		})
	};
}

/**
 * The point on an area's outline closest to `from` (over all rings and
 * member lines), or `null` when the outline has no segments.
 */
export function nearestPointOnOutline(
	geometry: GeoJSON.Geometry | null | undefined,
	from: GeoPoint
): GeoPoint | null {
	const { toXY, toGeo } = projection(from);
	let best: [number, number] | null = null;
	let bestSq = Infinity;

	for (const line of outlineLines(geometry)) {
		if (line.length === 1) {
			const p = toXY(line[0]);
			const d = p[0] * p[0] + p[1] * p[1];
			if (d < bestSq) {
				bestSq = d;
				best = p;
			}
			continue;
		}
		for (let i = 0; i + 1 < line.length; i++) {
			const [ax, ay] = toXY(line[i]);
			const [bx, by] = toXY(line[i + 1]);
			const dx = bx - ax;
			const dy = by - ay;
			const lenSq = dx * dx + dy * dy;
			// Projection of the origin (0,0) onto the segment, clamped to it.
			const t = lenSq > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;
			const px = ax + t * dx;
			const py = ay + t * dy;
			const d = px * px + py * py;
			if (d < bestSq) {
				bestSq = d;
				best = [px, py];
			}
		}
	}

	return best ? toGeo(best[0], best[1]) : null;
}

/** Even-odd test of `point` against the closed rings of an outline. */
export function isInsideOutline(
	geometry: GeoJSON.Geometry | null | undefined,
	point: GeoPoint
): boolean {
	let inside = false;
	for (const ring of outlineLines(geometry)) {
		if (ring.length < 4) continue;
		const first = ring[0];
		const last = ring[ring.length - 1];
		// Split multipolygon members are open lines; they enclose nothing alone.
		if (first[0] !== last[0] || first[1] !== last[1]) continue;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [xi, yi] = ring[i];
			const [xj, yj] = ring[j];
			if (
				yi > point.lat !== yj > point.lat &&
				point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
			) {
				inside = !inside;
			}
		}
	}
	return inside;
}

/**
 * Distance in meters from `point` to an area: 0 inside it, else to the
 * nearest point of its outline. `null` when the outline is empty.
 */
export function distanceToOutline(
	geometry: GeoJSON.Geometry | null | undefined,
	point: GeoPoint
): number | null {
	if (isInsideOutline(geometry, point)) return 0;
	const nearest = nearestPointOnOutline(geometry, point);
	return nearest ? distanceTo(point, nearest) : null;
}

/**
 * Points along every line of an outline, at most `stepM` metres apart, used as
 * the targets of a pond's shore (plan §6.5). Each line gets at least three
 * samples, so a tiny pond still offers more than one side; open member lines
 * (split multipolygon members) include their end point.
 */
export function sampleShore(
	geometry: GeoJSON.Geometry | null | undefined,
	stepM: number
): GeoPoint[] {
	const samples: GeoPoint[] = [];
	for (const line of outlineLines(geometry)) {
		if (line.length === 0) continue;
		const points = line.map(([lng, lat]) => ({ lng, lat }));
		if (points.length === 1) {
			samples.push(points[0]);
			continue;
		}
		const lengths: number[] = [];
		let total = 0;
		for (let i = 0; i + 1 < points.length; i++) {
			const d = distanceTo(points[i], points[i + 1]);
			lengths.push(d);
			total += d;
		}
		if (total === 0) {
			samples.push(points[0]);
			continue;
		}
		const first = line[0];
		const last = line[line.length - 1];
		const closed = first[0] === last[0] && first[1] === last[1];
		const count = Math.max(3, Math.ceil(total / stepM));
		const spacing = total / count;
		const n = closed ? count : count + 1;
		let segment = 0;
		let walked = 0;
		for (let k = 0; k < n; k++) {
			const target = Math.min(k * spacing, total);
			while (segment < lengths.length - 1 && walked + lengths[segment] < target) {
				walked += lengths[segment++];
			}
			const len = lengths[segment];
			const f = len > 0 ? Math.min(1, (target - walked) / len) : 0;
			const a = points[segment];
			const b = points[segment + 1];
			samples.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
		}
	}
	return samples;
}
