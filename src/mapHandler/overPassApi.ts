import { GeoBounds } from '@/types/geo';

// ---------------------------------------------------------------------------
// Overpass API instance pool
// Ordered list of public interpreters tried in sequence. All instances share
// the same request/response contract, so any of them can serve any query.
// ---------------------------------------------------------------------------

const OVERPASS_INSTANCES = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.private.coffee/api/interpreter',
	'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

// ---------------------------------------------------------------------------
// Timeouts (client-side, in addition to the Overpass [timeout:…] directive)
// ---------------------------------------------------------------------------

/** Client-side timeout applied to each individual instance attempt. */
const PER_ATTEMPT_TIMEOUT_MS = 12_000;
/** Overall client-side timeout for a single-node query (spans all attempts). */
const NODE_QUERY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Rate-limit cool-downs
// When an instance replies with HTTP 429 it is parked until a deadline so the
// pool skips it while it recovers. Deadlines are epoch-milliseconds.
// ---------------------------------------------------------------------------

const instanceCooldowns = new Map<string, number>();
/** Fallback cool-down when the server does not send a usable Retry-After. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** Upper bound for an accepted Retry-After value (guards against garbage). */
const MAX_COOLDOWN_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Module-level AbortController for area queries
// Ensures only the most recent area request is in-flight at any time.
// ---------------------------------------------------------------------------

let areaQueryController: AbortController | null = null;

// ---------------------------------------------------------------------------
// Last-area-query failure flag
// Tracks whether the most recent call to fetchMarkerData ended in a genuine
// network/server error, so callers can distinguish failure from supersession
// (abort) without changing the null-return contract.
// ---------------------------------------------------------------------------

let lastAreaQueryFailed = false;

/**
 * Returns `true` if the most recent {@link fetchMarkerData} call ended with a
 * genuine network or server error.  Returns `false` when the last call either
 * succeeded or was **superseded** (aborted by a newer request) — neither case
 * is an error worth surfacing to the user.
 *
 * The value is only meaningful immediately after `fetchMarkerData` resolves; it
 * is not reactive.
 */
export function wasLastAreaQueryFailure(): boolean {
	return lastAreaQueryFailed;
}

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

/** Maximum span (in degrees) allowed per axis for an area query bbox. */
const MAX_AREA_SPAN_DEGREES = 0.5;

/**
 * Clamps the requested bounds to at most {@link MAX_AREA_SPAN_DEGREES} on each
 * axis, keeping the same center. Huge desktop viewports would otherwise ask the
 * server for an area so large it overruns the `[timeout:15]` directive.
 */
function clampBounds(mapBounds: GeoBounds): GeoBounds {
	const clampAxis = (low: number, high: number): { low: number; high: number } => {
		const span = high - low;
		if (span <= MAX_AREA_SPAN_DEGREES) {
			return { low, high };
		}
		const center = (low + high) / 2;
		const half = MAX_AREA_SPAN_DEGREES / 2;
		return { low: center - half, high: center + half };
	};

	const lat = clampAxis(mapBounds.south, mapBounds.north);
	const lon = clampAxis(mapBounds.west, mapBounds.east);
	return { south: lat.low, north: lat.high, west: lon.low, east: lon.high };
}

function buildAreaQuery(mapBounds: GeoBounds): string {
	const bounds = clampBounds(mapBounds);
	const osmDataKeys = [
		'node[emergency=fire_hydrant]',
		'way[amenity=fire_station]',
		'node[emergency=water_tank]',
		'node[emergency=suction_point]',
		'node[emergency=fire_water_pond]'
	];
	const boundString = `(${bounds.south},${bounds.west},${bounds.north},${bounds.east})`;

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

/** Returns true while the given instance is parked on a rate-limit cool-down. */
function isCooledDown(baseUrl: string): boolean {
	const deadline = instanceCooldowns.get(baseUrl);
	return deadline !== undefined && deadline > Date.now();
}

/**
 * Parks an instance on a cool-down after a 429 response. Honours the
 * `Retry-After` header (in seconds) when present and sane, otherwise falls
 * back to {@link DEFAULT_COOLDOWN_MS}.
 */
function applyCooldown(baseUrl: string, retryAfter: string | null): void {
	let cooldownMs = DEFAULT_COOLDOWN_MS;
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_COOLDOWN_SECONDS) {
			cooldownMs = seconds * 1000;
		}
	}
	instanceCooldowns.set(baseUrl, Date.now() + cooldownMs);
}

/**
 * Attempts to fetch from a single Overpass instance.
 * Throws on any failure (network, HTTP error, abort, timeout). A 429 response
 * additionally parks the instance on a cool-down before throwing.
 */
async function fetchFromInstance(
	baseUrl: string,
	query: string,
	signal: AbortSignal
): Promise<OverPassElement[]> {
	// POST the query (rather than encoding it into the URL) so that the special
	// characters used by Overpass QL (`=`, `;`, `[`, `]`, `,`) can never be
	// mangled by URL encoding, which was a source of flaky responses.
	const response = await fetch(baseUrl, {
		method: 'POST',
		body: new URLSearchParams({ data: query }),
		signal
	});

	if (response.status === 429) {
		applyCooldown(baseUrl, response.headers.get('Retry-After'));
	}

	if (!response.ok) {
		throw new Error(`Overpass ${response.status} ${response.statusText} from ${baseUrl}`);
	}

	const data = await response.json();
	return (data?.elements as OverPassElement[]) ?? [];
}

/**
 * Runs a query against the instance pool, trying each interpreter in order.
 *
 * - Instances currently on a 429 cool-down are skipped; if every instance is
 *   cooled down they are all tried anyway (best effort).
 * - Each attempt gets its own {@link PER_ATTEMPT_TIMEOUT_MS} timeout, combined
 *   with `outerSignal` via `AbortSignal.any`.
 * - If `outerSignal` aborts (the request was superseded, or an owner-level
 *   timeout fired) the error is re-thrown immediately without trying further
 *   instances. A per-attempt timeout, 429, server or network error is treated
 *   as transient and moves on to the next instance.
 *
 * @throws the last encountered error when every attempted instance fails.
 */
async function fetchFromPool(query: string, outerSignal: AbortSignal): Promise<OverPassElement[]> {
	const available = OVERPASS_INSTANCES.filter((url) => !isCooledDown(url));
	const instances = available.length > 0 ? available : OVERPASS_INSTANCES;

	let lastError: unknown = new Error('No Overpass instances available');
	for (const baseUrl of instances) {
		const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS)]);
		try {
			return await fetchFromInstance(baseUrl, query, signal);
		} catch (error) {
			// The outer signal aborting means this query was superseded by a newer
			// one (or its owner timed out) — never fall through to the next instance.
			if (outerSignal.aborted) {
				throw error;
			}
			// Per-attempt timeout, 429, server or network error → try the next.
			console.warn(`Overpass instance ${baseUrl} failed, trying next…`, error);
			lastError = error;
		}
	}

	throw lastError;
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
 * - Runs against the ordered {@link OVERPASS_INSTANCES} pool, moving to the
 *   next interpreter on any transient failure and skipping instances that are
 *   on a 429 cool-down.
 * - Applies a per-attempt client-side timeout of {@link PER_ATTEMPT_TIMEOUT_MS}
 *   ms in addition to the server-side `[timeout:15]` directive.
 *
 * @returns The fetched elements on success (may be an empty array for areas
 *          with no data), or **`null`** when the request was aborted
 *          (superseded by a newer call) or every instance failed — so callers
 *          can distinguish "no data in this area" from "we never got a valid
 *          response" and avoid deleting cached markers.
 */
export async function fetchMarkerData(mapBounds: GeoBounds): Promise<OverPassElement[] | null> {
	// Cancel any previous in-flight area query
	if (areaQueryController) {
		areaQueryController.abort();
	}

	const controller = new AbortController();
	areaQueryController = controller;

	try {
		const query = buildAreaQuery(mapBounds);
		const result = await fetchFromPool(query, controller.signal);
		lastAreaQueryFailed = false;
		return result;
	} catch (error) {
		// Aborted (superseded by a newer call) → not a genuine failure
		if (controller.signal.aborted) {
			lastAreaQueryFailed = false;
			return null;
		}
		console.error('Overpass area query failed:', error);
		lastAreaQueryFailed = true;
		return null;
	} finally {
		// Only clear the module reference if it is still ours
		if (areaQueryController === controller) {
			areaQueryController = null;
		}
	}
}

/**
 * Fetches a single node or way by its OSM ID.
 *
 * Runs against the same {@link OVERPASS_INSTANCES} pool (with shared 429
 * cool-downs) as area queries. An overall client-side timeout of
 * {@link NODE_QUERY_TIMEOUT_MS} ms spans all instance attempts; on timeout or
 * total failure it returns `null`.
 */
export async function fetchNodeById(nodeId: number): Promise<OverPassElement | null> {
	const query = `[out:json][timeout:15];(node(${nodeId});way(${nodeId}););out center tags;`;

	const outerSignal = AbortSignal.timeout(NODE_QUERY_TIMEOUT_MS);

	try {
		const elements = await fetchFromPool(query, outerSignal);
		return elements.length > 0 ? elements[0] : null;
	} catch (e) {
		if (outerSignal.aborted) {
			console.warn('Overpass node query timed out for node:', nodeId);
			return null;
		}
		console.error('Error fetching node by ID:', e);
		return null;
	}
}
