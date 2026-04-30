import { GeoBounds } from '@/types/geo';

// ---------------------------------------------------------------------------
// Overpass API instances
// ---------------------------------------------------------------------------

/** Primary instance for area queries (bulk data fetching). */
const OVERPASS_PRIMARY_URL = 'https://overpass-api.de/api/interpreter';
//'https://overpass.private.coffee/api/interpreter';
/** Fallback instance for area queries when the primary is unavailable. */
const OVERPASS_FALLBACK_URL = 'https://overpass-api.de/api/interpreter';
/** Instance for single-node requests (low volume, public API is fine). */
const OVERPASS_NODE_URL = 'https://overpass-api.de/api/interpreter';

// ---------------------------------------------------------------------------
// Timeouts (client-side, in addition to the Overpass [timeout:…] directive)
// ---------------------------------------------------------------------------

/** Client-side timeout for area queries in milliseconds. */
const AREA_QUERY_TIMEOUT_MS = 20_000;
/** Client-side timeout for single-node queries in milliseconds. */
const NODE_QUERY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Module-level AbortController for area queries
// Ensures only the most recent area request is in-flight at any time.
// ---------------------------------------------------------------------------

let areaQueryController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverPassElement {
	id: number;
	type: string;
	lat?: number;
	lon?: number;
	center?: {
		lat: number;
		lon: number;
	};
	tags: {
		[key: string]: string;
	};
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

function buildAreaQuery(mapBounds: GeoBounds): string {
	const osmDataKeys = [
		'node[emergency=fire_hydrant]',
		'way[amenity=fire_station]',
		'node[emergency=water_tank]',
		'node[emergency=suction_point]',
		'node[emergency=fire_water_pond]'
	];
	const boundString = `(${mapBounds.south},${mapBounds.west},${mapBounds.north},${mapBounds.east})`;

	let query = '[out:json][timeout:15];(';
	for (const key of osmDataKeys) {
		query += key + boundString + ';';
	}
	query += ');out qt center 2000 tags;';
	return query;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to fetch from a single Overpass instance.
 * Throws on any failure (network, HTTP error, abort, timeout).
 */
async function fetchFromInstance(
	baseUrl: string,
	query: string,
	signal: AbortSignal
): Promise<OverPassElement[]> {
	const response = await fetch(`${baseUrl}?data=${encodeURI(query)}`, { signal });

	if (!response.ok) {
		throw new Error(`Overpass ${response.status} ${response.statusText} from ${baseUrl}`);
	}

	const data = await response.json();
	return (data?.elements as OverPassElement[]) ?? [];
}

/**
 * Tries the primary Overpass instance first; on rate-limit (429), server
 * errors (5xx), network failures, or timeouts it automatically retries with
 * the fallback instance.
 *
 * **Abort errors are never retried** and always re-thrown so callers can
 * distinguish a deliberate cancellation from a transient failure.
 */
async function fetchWithFallback(query: string, signal: AbortSignal): Promise<OverPassElement[]> {
	try {
		return await fetchFromInstance(OVERPASS_PRIMARY_URL, query, signal);
	} catch (error) {
		// Never retry an intentional abort (new request superseded this one)
		if (signal.aborted) {
			throw error;
		}
		console.warn('Primary Overpass instance failed, trying fallback…', error);
	}

	// Fallback — let errors propagate naturally
	return fetchFromInstance(OVERPASS_FALLBACK_URL, query, signal);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches marker data from the Overpass API for the given map bounds.
 *
 * - Automatically **aborts** any previous in-flight area query so only the
 *   latest request completes (prevents "too many requests" errors during
 *   rapid map panning).
 * - Uses **overpass.private.coffee** as primary with **overpass-api.de** as
 *   automatic fallback on failure.
 * - Enforces a client-side timeout of {@link AREA_QUERY_TIMEOUT_MS} ms in
 *   addition to the server-side `[timeout:15]` directive.
 *
 * @returns The fetched elements on success (may be an empty array for areas
 *          with no data), or **`null`** when the request was aborted or
 *          failed — so callers can distinguish "no data in this area" from
 *          "we never got a valid response" and avoid deleting cached markers.
 */
export async function fetchMarkerData(mapBounds: GeoBounds): Promise<OverPassElement[] | null> {
	// Cancel any previous in-flight area query
	if (areaQueryController) {
		areaQueryController.abort();
	}

	const controller = new AbortController();
	areaQueryController = controller;

	const timeoutId = setTimeout(() => controller.abort(), AREA_QUERY_TIMEOUT_MS);

	try {
		const query = buildAreaQuery(mapBounds);
		return await fetchWithFallback(query, controller.signal);
	} catch (error) {
		// Aborted (superseded by a newer call or timed out) → return null
		if (controller.signal.aborted) {
			return null;
		}
		console.error('Overpass area query failed:', error);
		return null;
	} finally {
		clearTimeout(timeoutId);
		// Only clear the module reference if it is still ours
		if (areaQueryController === controller) {
			areaQueryController = null;
		}
	}
}

/**
 * Fetches a single node or way by its OSM ID.
 *
 * Uses the public **overpass-api.de** instance (low-volume, single-element
 * queries). Includes a client-side timeout of {@link NODE_QUERY_TIMEOUT_MS}.
 */
export async function fetchNodeById(nodeId: number): Promise<OverPassElement | null> {
	const query = `[out:json][timeout:15];(node(${nodeId});way(${nodeId}););out center tags;`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), NODE_QUERY_TIMEOUT_MS);

	try {
		const response = await fetch(`${OVERPASS_NODE_URL}?data=${encodeURI(query)}`, {
			signal: controller.signal
		});

		if (!response.ok) {
			throw new Error(`Overpass API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		const elements = data?.elements as OverPassElement[];
		return elements && elements.length > 0 ? elements[0] : null;
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') {
			console.warn('Overpass node query timed out for node:', nodeId);
			return null;
		}
		console.error('Error fetching node by ID:', e);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}
