import { OSM_DATA_API_URL } from '@/services/osmConfig';
import {
	fetchWaterAreasViaOverpass,
	WATER_AREA_MAX_RESULTS,
	WATER_AREA_NEAR_RADIUS_M,
	type WaterAreaCandidate
} from '@/mapHandler/overPassApi';

/**
 * Finds the OSM water areas at or next to a pin (plan §2.1), for marking an
 * existing pond as a fire water pond instead of adding a duplicate point.
 *
 * **OSM API first.** The API's `map` call for a small box around the pin is
 * fast and dependable (it is what OSM editors use), returns live data, and
 * includes complete ways with all their nodes — enough to decide "pin inside"
 * vs "next to the pin" here and to draw the outline. The public Overpass
 * servers were too slow for this in practice: the search regularly hit the
 * client timeouts, so no candidates were ever offered.
 *
 * **Overpass as fallback**, for when the API fails, and when the API finds
 * nothing although the pin may sit inside an area larger than the box (only
 * `is_in` on Overpass can answer that) — with a shorter timeout, so a slow
 * Overpass costs a few seconds instead of half a minute.
 *
 * @returns candidates (inside first, then nearest), or `null` when neither
 *          source answered — callers then offer "add as point".
 */
export async function fetchWaterAreasAt(
	lat: number,
	lon: number,
	signal?: AbortSignal
): Promise<WaterAreaCandidate[] | null> {
	const viaApi = await fetchWaterAreasViaApi(lat, lon, signal);
	if (signal?.aborted) return null;
	if (viaApi && viaApi.length > 0) return viaApi;

	const viaOverpass = await fetchWaterAreasViaOverpass(
		lat,
		lon,
		signal,
		OVERPASS_FALLBACK_TIMEOUT_MS
	);
	if (viaOverpass) return viaOverpass;
	// Overpass failed, but the API answered (with nothing): that is a valid
	// "no water area here", not an error.
	return viaApi;
}

/** Half-size of the API box around the pin (m). Covers the "near" radius with margin. */
const API_BOX_HALF_M = 60;
/** Client timeout for the API `map` call. */
const API_TIMEOUT_MS = 8_000;
/** Overpass fallback gets less time than a normal lookup. */
const OVERPASS_FALLBACK_TIMEOUT_MS = 12_000;

const WATER_TAGS = (tags: Record<string, string>): boolean =>
	tags['natural'] === 'water' || tags['landuse'] === 'reservoir' || tags['landuse'] === 'basin';
/** Other `emergency=*` areas (e.g. tanks) are never offered; fire ponds stay for the duplicate guard. */
const OFFERABLE = (tags: Record<string, string>): boolean =>
	tags['emergency'] == null || tags['emergency'] === 'fire_water_pond';

interface ApiNode {
	type: 'node';
	id: number;
	lat: number;
	lon: number;
}
interface ApiWay {
	type: 'way';
	id: number;
	nodes: number[];
	tags?: Record<string, string>;
}
interface ApiRelation {
	type: 'relation';
	id: number;
	members: { type: string; ref: number; role: string }[];
	tags?: Record<string, string>;
}
type ApiElement = ApiNode | ApiWay | ApiRelation;

/** Local metric projection around the pin (equirectangular; fine at these distances). */
function projector(lat0: number, lon0: number) {
	const rad = Math.PI / 180;
	const kx = 6_371_000 * Math.cos(lat0 * rad) * rad;
	const ky = 6_371_000 * rad;
	return (lat: number, lon: number): [number, number] => [(lon - lon0) * kx, (lat - lat0) * ky];
}

function segmentDistance(
	[px, py]: [number, number],
	[ax, ay]: [number, number],
	[bx, by]: [number, number]
) {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Even-odd test over a set of closed rings (holes work naturally). */
function insideRings(p: [number, number], rings: [number, number][][]): boolean {
	let inside = false;
	for (const ring of rings) {
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [xi, yi] = ring[i];
			const [xj, yj] = ring[j];
			if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
				inside = !inside;
		}
	}
	return inside;
}

function shoelace(ring: [number, number][]): number {
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	}
	return Math.abs(sum) / 2;
}

/**
 * Water areas around the pin from the OSM API `map` call. Returns `null` when
 * the request fails (caller falls back to Overpass), `[]` when it answered
 * but nothing qualifies.
 */
async function fetchWaterAreasViaApi(
	lat: number,
	lon: number,
	signal?: AbortSignal
): Promise<WaterAreaCandidate[] | null> {
	const dLat = API_BOX_HALF_M / 111_320;
	const dLon = API_BOX_HALF_M / (111_320 * Math.cos((lat * Math.PI) / 180));
	const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(7)).join(',');

	let elements: ApiElement[];
	try {
		const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
		const response = await fetch(`${OSM_DATA_API_URL}/api/0.6/map.json?bbox=${bbox}`, {
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout
		});
		if (!response.ok) return null;
		elements = ((await response.json()) as { elements?: ApiElement[] }).elements ?? [];
	} catch (e) {
		if (!signal?.aborted) console.warn('Water area lookup (OSM API) failed:', e);
		return null;
	}

	const nodes = new Map<number, ApiNode>();
	const ways = new Map<number, ApiWay>();
	for (const e of elements) {
		if (e.type === 'node') nodes.set(e.id, e);
		else if (e.type === 'way') ways.set(e.id, e);
	}
	const project = projector(lat, lon);
	const pin: [number, number] = [0, 0];

	/** Projected coordinates of a way (missing nodes dropped). */
	const wayLine = (way: ApiWay): { lat: number; lon: number }[] =>
		way.nodes.map((id) => nodes.get(id)).filter((n): n is ApiNode => n != null);

	const candidates: WaterAreaCandidate[] = [];
	const consider = (
		type: 'way' | 'relation',
		id: number,
		tags: Record<string, string>,
		lines: { lat: number; lon: number }[][]
	) => {
		// Only closed rings can decide "inside" (a multipolygon may come with just
		// some of its member ways); open pieces still count for the distance.
		const isClosed = (l: { lat: number; lon: number }[]) =>
			l.length >= 4 && l[0].lat === l[l.length - 1].lat && l[0].lon === l[l.length - 1].lon;
		const rings = lines.filter(isClosed).map((l) => l.map((n) => project(n.lat, n.lon)));
		const projected = lines.map((l) => l.map((n) => project(n.lat, n.lon)));
		if (!projected.some((l) => l.length >= 2)) return;

		let minDist = Infinity;
		for (const line of projected) {
			for (let i = 1; i < line.length; i++)
				minDist = Math.min(minDist, segmentDistance(pin, line[i - 1], line[i]));
		}
		const inside = rings.length > 0 && insideRings(pin, rings);
		if (!inside && minDist > WATER_AREA_NEAR_RADIUS_M) return;

		const all = lines.flat();
		const lats = all.map((n) => n.lat);
		const lons = all.map((n) => n.lon);
		const center = {
			lat: (Math.min(...lats) + Math.max(...lats)) / 2,
			lon: (Math.min(...lons) + Math.max(...lons)) / 2
		};
		const outline: GeoJSON.Geometry =
			type === 'way' && rings.length === 1
				? { type: 'Polygon', coordinates: [lines[0].map((n) => [n.lon, n.lat])] }
				: { type: 'MultiLineString', coordinates: lines.map((l) => l.map((n) => [n.lon, n.lat])) };
		candidates.push({
			element: { id, type, center, tags, outline },
			inside,
			approxAreaM2: rings.reduce((sum, r) => sum + shoelace(r), 0),
			distanceM: inside ? 0 : minDist,
			outline
		});
	};

	for (const way of ways.values()) {
		const tags = way.tags ?? {};
		if (!WATER_TAGS(tags) || !OFFERABLE(tags)) continue;
		const line = wayLine(way);
		// Only closed ways are areas; an open natural=water way is broken data.
		if (way.nodes.length < 4 || way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
		consider('way', way.id, tags, [line]);
	}
	for (const e of elements) {
		if (e.type !== 'relation') continue;
		const tags = e.tags ?? {};
		if (tags['type'] !== 'multipolygon' || !WATER_TAGS(tags) || !OFFERABLE(tags)) continue;
		// The map call includes the member ways near the box, not necessarily all
		// of them; that is enough to measure the distance to this shore and to
		// outline it. The center is that of the returned part.
		const lines = e.members
			.filter((m) => m.type === 'way' && ways.has(m.ref))
			.map((m) => wayLine(ways.get(m.ref)!));
		consider('relation', e.id, tags, lines);
	}

	return candidates
		.sort((a, b) => Number(b.inside) - Number(a.inside) || a.distanceM - b.distanceM)
		.slice(0, WATER_AREA_MAX_RESULTS);
}
