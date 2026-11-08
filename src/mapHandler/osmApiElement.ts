import { OSM_DATA_API_URL } from '@/services/osmConfig';
import type { OverPassElement } from '@/mapHandler/overPassApi';
import type { OsmType } from '@/helper/osmRef';

/**
 * Looks up a single node or way from the OSM API (read-only) and returns it in
 * the app's {@link OverPassElement} shape.
 *
 * Used for markers that are not in the local cache yet, typically a shared
 * link (`/#/markers/n123`) opened on a fresh device. A single-object read from
 * the API is fast and authoritative, while Overpass can be slow, rate-limited
 * or down — and then the link opened nothing at all. Overpass stays as the
 * fallback (and is used for relations, whose full download can be large).
 *
 * Ways get a `center` like Overpass `out center`: the middle of their bounding
 * box. Returns `null` when the object does not exist (anymore) or the request
 * fails, so callers can fall back.
 */

/** Client-side timeout for one API read. */
const API_TIMEOUT_MS = 10_000;

interface ApiNode {
	type: 'node';
	id: number;
	lat: number;
	lon: number;
	tags?: Record<string, string>;
}

interface ApiWay {
	type: 'way';
	id: number;
	nodes: number[];
	tags?: Record<string, string>;
}

type ApiElement = ApiNode | ApiWay | { type: 'relation'; id: number };

export async function fetchElementFromOsmApi(
	type: OsmType,
	id: number
): Promise<OverPassElement | null> {
	if (id <= 0 || type === 'relation') return null;
	const path = type === 'way' ? `way/${id}/full.json` : `node/${id}.json`;

	let elements: ApiElement[];
	try {
		const response = await fetch(`${OSM_DATA_API_URL}/api/0.6/${path}`, {
			signal: AbortSignal.timeout(API_TIMEOUT_MS)
		});
		if (!response.ok) return null; // 404 / 410 (deleted) / 5xx → fall back
		elements = ((await response.json()) as { elements?: ApiElement[] }).elements ?? [];
	} catch (e) {
		console.warn(`OSM API lookup failed for ${type} ${id}:`, e);
		return null;
	}

	if (type === 'node') {
		const node = elements.find((e): e is ApiNode => e.type === 'node' && e.id === id);
		return node ? { id, type: 'node', lat: node.lat, lon: node.lon, tags: node.tags ?? {} } : null;
	}

	const way = elements.find((e): e is ApiWay => e.type === 'way' && e.id === id);
	if (!way) return null;
	const coords = new Map(
		elements.filter((e): e is ApiNode => e.type === 'node').map((n) => [n.id, n])
	);
	let south = Infinity;
	let west = Infinity;
	let north = -Infinity;
	let east = -Infinity;
	for (const ref of way.nodes) {
		const node = coords.get(ref);
		if (!node) continue;
		south = Math.min(south, node.lat);
		north = Math.max(north, node.lat);
		west = Math.min(west, node.lon);
		east = Math.max(east, node.lon);
	}
	if (!Number.isFinite(south)) return null;
	return {
		id,
		type: 'way',
		center: { lat: (south + north) / 2, lon: (west + east) / 2 },
		tags: way.tags ?? {}
	};
}
