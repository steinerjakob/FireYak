import maplibregl, { type RequestParameters, type GetResourceResponse } from 'maplibre-gl';
import { tileStore } from '@/offline/tileStore';
import { tileToBounds } from '@/offline/tileMath';
import { getAllOfflineAreas, type OfflineArea } from '@/mapHandler/databaseHandler';
import { GeoBounds } from '@/types/geo';
import { routingCache } from '@/offline/routingCache';
import { createTileFetchers } from '@/offline/tileFetchers';
import { notifyRoutingDataArrived } from '@/mapHandler/routingData';

const PROTOMAPS_API_KEY = import.meta.env.VITE_PROTOMAPS_API_KEY;

/** Upstream base for style assets (glyph ranges + sprite json/png). */
const ASSET_BASE = 'https://protomaps.github.io/basemaps-assets/';

/**
 * Upstream tile URL builders per source. Kept here (single source of truth) and
 * reused by the tile download manager.
 *   - satellite uses ArcGIS' `{z}/{y}/{x}` order (note x/y are swapped!).
 *   - terrain: Mapterhorn serves `.webp` (verified via tilejson.json on
 *     2026-07-05; the plan's `.png` was stale), terrarium-encoded, 512 px.
 */
export const NETWORK_URL: Record<string, (z: number, x: number, y: number) => string> = {
	protomaps: (z, x, y) =>
		`https://api.protomaps.com/tiles/v4/${z}/${x}/${y}.mvt?key=${PROTOMAPS_API_KEY}`,
	satellite: (z, x, y) =>
		`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
	terrain: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`
};

const TILE_URL_RE = /^offline:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;
const ASSET_URL_RE = /^offline:\/\/assets\/(.+)$/;

// ---------------------------------------------------------------------------
// Downloaded-area cache: the write-through gate runs on every browsed tile, so
// it must not hit IndexedDB per tile. We keep the areas' bounds in memory with a
// short TTL and an explicit invalidation hook the areas store calls on change.
// ---------------------------------------------------------------------------
const AREAS_TTL_MS = 15_000;
let cachedBounds: GeoBounds[] | null = null;
let cachedAt = 0;

/** Drops the in-memory downloaded-areas cache (called when areas change). */
export function invalidateDownloadedAreasCache(): void {
	cachedBounds = null;
}

async function downloadedAreaBounds(): Promise<GeoBounds[]> {
	const now = Date.now();
	if (cachedBounds && now - cachedAt < AREAS_TTL_MS) return cachedBounds;
	const areas: OfflineArea[] = await getAllOfflineAreas();
	cachedBounds = areas.map((a) => a.bounds);
	cachedAt = now;
	return cachedBounds;
}

function boundsIntersect(a: GeoBounds, b: GeoBounds): boolean {
	return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

/** True when the tile's footprint overlaps any downloaded area (write-through gate). */
async function isInsideDownloadedArea(z: number, x: number, y: number): Promise<boolean> {
	const bounds = await downloadedAreaBounds();
	if (bounds.length === 0) return false;
	const tb = tileToBounds(z, x, y);
	return bounds.some((area) => boundsIntersect(area, tb));
}

/**
 * Resolves an asset request (glyph/sprite). Cache-first, always write-through
 * (assets are small and global). `params.type` is `'json'` for the sprite index
 * and `'arrayBuffer'` for glyph pbf / sprite png — return shape follows that.
 */
async function handleAsset(
	path: string,
	params: RequestParameters,
	abort: AbortController
): Promise<GetResourceResponse<ArrayBuffer | object>> {
	const cached = await tileStore.getAsset(path);
	if (cached) return toResponse(cached, params.type);

	const resp = await fetch(ASSET_BASE + path, { signal: abort.signal });
	if (!resp.ok) throw new Error(`Asset ${resp.status}: ${path}`);
	const blob = await resp.blob();
	await tileStore.putAsset(path, blob);
	return toResponse(blob, params.type);
}

async function toResponse(
	blob: Blob,
	type: RequestParameters['type']
): Promise<GetResourceResponse<ArrayBuffer | object>> {
	if (type === 'json') {
		return { data: JSON.parse(await blob.text()) };
	}
	// 'arrayBuffer' | 'image' | 'string' | undefined → MapLibre decodes bytes itself.
	return { data: await blob.arrayBuffer() };
}

async function networkTile(
	source: string,
	z: number,
	x: number,
	y: number,
	signal?: AbortSignal
): Promise<ArrayBuffer> {
	const build = NETWORK_URL[source];
	if (!build) throw new Error(`Unknown offline source: ${source}`);
	const resp = await fetch(build(z, x, y), { signal });
	if (!resp.ok) throw new Error(`Tile ${resp.status}`);
	return resp.arrayBuffer();
}

/**
 * The app's tile lookups (see `tileFetchers.ts`): downloaded areas, then the
 * routing cache, then the network.
 */
const fetchers = createTileFetchers({
	areaStore: tileStore,
	routingCache,
	network: networkTile,
	insideDownloadedArea: isInsideDownloadedArea,
	isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
	onArrived: () => notifyRoutingDataArrived('tile')
});

/**
 * Cache-first tile fetch of the `offline://` protocol handler (map
 * browsing). Returns the tile bytes, or `null` when offline and uncached
 * (callers decide how to render/skip the gap); rethrows if the fetch was
 * aborted. Tiles write through to the area store only when browsed inside a
 * downloaded area so panning there offline works even for zooms the bulk
 * download hasn't reached yet — otherwise the store would grow into an
 * unbounded browse cache. Tiles the routing cache holds are served from there.
 */
export const fetchTileCacheFirst = fetchers.fetchTileCacheFirst;

/**
 * Cache-first tile fetch for hose routing (plan §6.9): network results fill
 * the routing cache and emit `routingDataArrived`; an aborted `signal` (the
 * routing budget is spent) means local stores only.
 */
export const fetchRoutingTile = fetchers.fetchRoutingTile;

/** Precaches one routing tile at a precache priority (see `routingPrefetch.ts`). */
export const prefetchTile = fetchers.prefetchTile;

/** The shared routing/precache network queue. */
export const routingFetchQueue = fetchers.queue;

/**
 * Registers the `offline://` protocol (MapLibre v5 async signature). URL scheme:
 *   - `offline://{source}/{z}/{x}/{y}`   → vector/raster/dem tiles
 *   - `offline://assets/{...path}`       → glyphs & sprites (path resolved
 *                                          against {@link ASSET_BASE})
 *
 * Cache-first everywhere. Tiles write through only when inside a downloaded area
 * (keeps the store from becoming an unbounded browse cache). Offline + uncached:
 * tiles return an empty buffer (MapLibre renders a gap, not an error); assets
 * rethrow so MapLibre can surface the missing-font/sprite.
 */
export function registerOfflineProtocol(): void {
	maplibregl.addProtocol(
		'offline',
		async (
			params: RequestParameters,
			abort: AbortController
		): Promise<GetResourceResponse<ArrayBuffer | object>> => {
			const assetMatch = params.url.match(ASSET_URL_RE);
			if (assetMatch) {
				return handleAsset(assetMatch[1], params, abort);
			}

			const m = params.url.match(TILE_URL_RE);
			if (!m) throw new Error(`Bad offline URL: ${params.url}`);
			const [, source, zs, xs, ys] = m;
			const z = +zs;
			const x = +xs;
			const y = +ys;

			const buf = await fetchTileCacheFirst(source, z, x, y, abort.signal);
			// Offline and not cached → empty tile renders a gap rather than erroring.
			return { data: buf ?? new ArrayBuffer(0) };
		}
	);
}
