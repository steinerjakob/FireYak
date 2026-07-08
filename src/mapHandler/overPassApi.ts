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
// Client identification (Overpass usage policy)
// The OSM wiki asks apps to send a User-Agent or Referer that uniquely
// identifies them. Browsers forbid setting those headers directly, so we use
// the fetch `referrer` option instead. It must be same-origin with the app,
// therefore the identification lives in the path: the app hostname plus a
// random per-install id, so not every user shares one identity (and one
// rate-limit bucket) at the Overpass servers.
// ---------------------------------------------------------------------------

const CLIENT_ID_STORAGE_KEY = 'overpassClientId';

let cachedClientReferrer: string | null = null;

/** Random id generated once per install and persisted across sessions. */
function getClientId(): string {
	try {
		let id = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
		if (!id) {
			id = crypto.randomUUID();
			localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
		}
		return id;
	} catch {
		// localStorage unavailable (private mode etc.) → session-unique fallback
		return crypto.randomUUID();
	}
}

/**
 * Same-origin referrer URL identifying this app install, e.g.
 * `https://fireyak.example/overpass-client/2f9c…`. Sent with every Overpass
 * request via the `referrer` fetch option (see {@link fetchFromInstance}).
 */
function getClientReferrer(): string {
	if (!cachedClientReferrer) {
		cachedClientReferrer = `${location.origin}/overpass-client/${getClientId()}`;
	}
	return cachedClientReferrer;
}

// ---------------------------------------------------------------------------
// Timeouts (client-side, in addition to the Overpass [timeout:…] directive)
// ---------------------------------------------------------------------------

// The server-side Overpass `[timeout:…]` directive is kept SHORTER than the
// client per-attempt timeout so the server always finishes (or fails cleanly)
// before the client aborts. Aborting mid-execution doesn't stop the server or
// refund the rate-limit slot, so a too-short client timeout would make us
// consume two instances' resources for one query — a fast way to earn 429s.
/** Server-side `[timeout:N]` (seconds) embedded in every query. */
const SERVER_TIMEOUT_SECONDS = 15;
/** Client-side timeout applied to each individual instance attempt. */
const PER_ATTEMPT_TIMEOUT_MS = 18_000;
/** Overall client-side timeout for a single-node query (spans all attempts). */
const NODE_QUERY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Rate-limit cool-downs
// When an instance replies with HTTP 429 it is parked until a deadline so the
// pool skips it while it recovers. Deadlines are epoch-milliseconds.
// ---------------------------------------------------------------------------

const instanceCooldowns = new Map<string, number>();
/** Fallback cool-down when the server does not send a usable Retry-After. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/**
 * Shorter park applied on a 5xx (500/504 usually mean the instance is
 * overloaded). Kept below the 429 cool-down so a briefly-struggling instance is
 * skipped on the next pan but comes back into rotation quickly.
 */
const SERVER_ERROR_COOLDOWN_MS = 45_000;
/** Upper bound for an accepted Retry-After value (guards against garbage). */
const MAX_COOLDOWN_SECONDS = 3600;

// Last instance that answered successfully. Tried first on the next query so
// the primary (overpass-api.de) doesn't absorb 100% of traffic and 429 first.
let lastGoodInstance: string | null = null;

// ---------------------------------------------------------------------------
// Module-level AbortController for area queries
// Ensures only the most recent area request is in-flight at any time.
// ---------------------------------------------------------------------------

let areaQueryController: AbortController | null = null;

// The area query currently in flight. Aborting a superseded request does NOT
// refund its server-side rate-limit slot, so byte-identical queries (map load
// + style reload + moveend often ask for the same bounds within a second)
// share the in-flight promise instead of abort-and-resend.
let inflightAreaQuery: { query: string; promise: Promise<OverPassElement[] | null> } | null = null;

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
 * Grid (in degrees) the clamped bounds are snapped outward to. Panning produces
 * a slightly different bbox every frame; snapping to a coarse grid makes small
 * pans and the load/style-reload/moveend burst resolve to the *same* query
 * string, so the in-flight dedup ({@link fetchMarkerData}) and the caller's
 * tile-freshness cache hit far more often.
 */
const SNAP_GRID_DEGREES = 0.05;

/**
 * Clamps the requested bounds to at most {@link MAX_AREA_SPAN_DEGREES} on each
 * axis (keeping the same center), then snaps the result **outward** to the
 * {@link SNAP_GRID_DEGREES} grid so nearby viewports yield an identical bbox.
 * Huge desktop viewports would otherwise ask the server for an area so large it
 * overruns the server timeout directive; the outward snap can grow a span by up
 * to one grid cell per side beyond the clamp, which is negligible.
 *
 * Exported so callers that track which area was actually fetched (freshness
 * stamps, stale-node reconciliation) can apply the exact same clamp+snap
 * instead of assuming their requested bounds were fetched in full.
 */
export function clampBounds(mapBounds: GeoBounds): GeoBounds {
	const clampAxis = (low: number, high: number): { low: number; high: number } => {
		let clampedLow = low;
		let clampedHigh = high;
		if (high - low > MAX_AREA_SPAN_DEGREES) {
			const center = (low + high) / 2;
			const half = MAX_AREA_SPAN_DEGREES / 2;
			clampedLow = center - half;
			clampedHigh = center + half;
		}
		// Snap outward: floor the low edge, ceil the high edge to grid lines.
		return {
			low: Math.floor(clampedLow / SNAP_GRID_DEGREES) * SNAP_GRID_DEGREES,
			high: Math.ceil(clampedHigh / SNAP_GRID_DEGREES) * SNAP_GRID_DEGREES
		};
	};

	const lat = clampAxis(mapBounds.south, mapBounds.north);
	const lon = clampAxis(mapBounds.west, mapBounds.east);
	return { south: lat.low, north: lat.high, west: lon.low, east: lon.high };
}

function buildAreaQuery(mapBounds: GeoBounds): string {
	const bounds = clampBounds(mapBounds);
	const boundString = `(${bounds.south},${bounds.west},${bounds.north},${bounds.east})`;

	// A single regex node filter does one bbox scan server-side instead of four
	// separate `node[emergency=…]` scans — cheaper and less likely to time out
	// on large bboxes.
	const statements = [
		`node[emergency~"^(fire_hydrant|water_tank|suction_point|fire_water_pond)$"]${boundString};`,
		`way[amenity=fire_station]${boundString};`
	];

	return `[out:json][timeout:${SERVER_TIMEOUT_SECONDS}];(${statements.join('')});out qt center 2000 tags;`;
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
		// Retry-After is either delta-seconds or an HTTP-date.
		let seconds = Number(retryAfter);
		if (!Number.isFinite(seconds)) {
			const dateMs = Date.parse(retryAfter);
			if (!Number.isNaN(dateMs)) {
				seconds = (dateMs - Date.now()) / 1000;
			}
		}
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
		// Identify this app install per the Overpass usage policy. `Referer` is a
		// forbidden header, so the `referrer` option is the only way to set it;
		// without `unsafe-url` the default policy would strip the identifying
		// path down to the bare origin on this cross-origin request.
		referrer: getClientReferrer(),
		referrerPolicy: 'unsafe-url',
		signal
	});

	if (response.status === 429) {
		applyCooldown(baseUrl, response.headers.get('Retry-After'));
	} else if (response.status >= 500) {
		// 5xx (typically 504/500) means the instance is overloaded — park it
		// briefly so the next pan doesn't hit it first again.
		instanceCooldowns.set(baseUrl, Date.now() + SERVER_ERROR_COOLDOWN_MS);
	}

	if (!response.ok) {
		throw new Error(`Overpass ${response.status} ${response.statusText} from ${baseUrl}`);
	}

	const data = await response.json();

	// Overpass can answer HTTP 200 with a partial element list plus a `remark`
	// like "runtime error: Query timed out…" when it hits its own timeout or
	// memory limit. Treat that as a failure so the pool tries another instance
	// instead of silently accepting truncated data.
	if (typeof data?.remark === 'string' && data.remark.includes('runtime error')) {
		throw new Error(`Overpass runtime error from ${baseUrl}: ${data.remark}`);
	}

	lastGoodInstance = baseUrl;
	return (data?.elements as OverPassElement[]) ?? [];
}

/**
 * Runs a query against the instance pool, trying each interpreter in order.
 *
 * - Instances currently on a 429 cool-down are skipped; if every instance is
 *   cooled down the query fails immediately instead of burning more
 *   rate-limit budget.
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
	// Try the last instance that succeeded first, so traffic (and the first 429)
	// doesn't always land on the primary. The rest keep their declared order.
	const instances =
		lastGoodInstance && available.includes(lastGoodInstance)
			? [lastGoodInstance, ...available.filter((url) => url !== lastGoodInstance)]
			: available;
	if (instances.length === 0) {
		// Every instance recently answered 429. Hitting them again would only
		// burn more rate-limit budget and extend the cool-downs — fail fast and
		// let the cache/freshness layers serve what they have.
		throw new Error('All Overpass instances are rate-limited (429 cool-down)');
	}

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
 * - **Reuses** an identical in-flight area query (same bounds → same promise)
 *   instead of re-sending it — aborting doesn't refund the server-side
 *   rate-limit slot, so re-sending identical queries invites 429s.
 * - Otherwise **aborts** any previous in-flight area query so only the
 *   latest request completes (prevents "too many requests" errors during
 *   rapid map panning).
 * - Runs against the ordered {@link OVERPASS_INSTANCES} pool, moving to the
 *   next interpreter on any transient failure and skipping instances that are
 *   on a 429 cool-down.
 * - Applies a per-attempt client-side timeout of {@link PER_ATTEMPT_TIMEOUT_MS}
 *   ms, deliberately longer than the server-side `[timeout:10]` directive so the
 *   server bails before the client does.
 *
 * @returns The fetched elements on success (may be an empty array for areas
 *          with no data), or **`null`** when the request was aborted
 *          (superseded by a newer call) or every instance failed — so callers
 *          can distinguish "no data in this area" from "we never got a valid
 *          response" and avoid deleting cached markers.
 */
export async function fetchMarkerData(mapBounds: GeoBounds): Promise<OverPassElement[] | null> {
	const query = buildAreaQuery(mapBounds);

	// Identical query already in flight → share its result instead of
	// aborting it and re-sending the same request.
	if (inflightAreaQuery && inflightAreaQuery.query === query) {
		return inflightAreaQuery.promise;
	}

	// Cancel any previous (different) in-flight area query
	if (areaQueryController) {
		areaQueryController.abort();
	}

	const controller = new AbortController();
	areaQueryController = controller;

	const promise = (async (): Promise<OverPassElement[] | null> => {
		try {
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
			// Only clear the module references if they are still ours. A newer
			// (different-bounds) call replaces both together, so the controller
			// identity also tells us whether the inflight entry is this call's.
			if (areaQueryController === controller) {
				areaQueryController = null;
				inflightAreaQuery = null;
			}
		}
	})();

	inflightAreaQuery = { query, promise };
	return promise;
}

/**
 * Fetches raw Overpass data for a single area chunk, used exclusively by the
 * offline area downloader (§1.2).
 *
 * Unlike {@link fetchMarkerData} this takes its **own** {@link AbortSignal} and
 * does not touch the module-level area-query {@link AbortController}. That split
 * is deliberate: map panning must never cancel an in-progress area download, and
 * an area download must never cancel the map's live queries. The downloader owns
 * the signal (per-area cancel), while sharing the same instance pool, POST
 * transport and 429 cool-downs as every other query.
 *
 * @throws on failure (network, HTTP error, timeout, abort) so the downloader can
 *         retry / mark the chunk as failed.
 */
export async function fetchAreaRaw(
	bounds: GeoBounds,
	signal: AbortSignal
): Promise<OverPassElement[]> {
	return fetchFromPool(buildAreaQuery(bounds), signal);
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
	const query = `[out:json][timeout:${SERVER_TIMEOUT_SECONDS}];(node(${nodeId});way(${nodeId}););out center tags;`;

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
