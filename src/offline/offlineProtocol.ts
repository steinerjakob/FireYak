import maplibregl, { type RequestParameters, type GetResourceResponse } from 'maplibre-gl';
import { tileStore } from '@/offline/tileStore';
import { tileToBounds } from '@/offline/tileMath';
import { getAllOfflineAreas, type OfflineArea } from '@/mapHandler/databaseHandler';
import { GeoBounds } from '@/types/geo';

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

/**
 * Cache-first tile fetch shared by the `offline://` protocol handler and the
 * obstacle-geometry decoder. Returns the tile bytes, or `null` when offline and
 * uncached (callers decide how to render/skip the gap). Throws for an unknown
 * source, and rethrows if the fetch was aborted.
 *
 * Tiles write through to the store only when browsed inside a downloaded area so
 * panning there offline works even for zooms the bulk download hasn't reached
 * yet — otherwise the store would grow into an unbounded browse cache.
 */
export async function fetchTileCacheFirst(
	source: string,
	z: number,
	x: number,
	y: number,
	signal?: AbortSignal
): Promise<ArrayBuffer | null> {
	const cached = await tileStore.get(source, z, x, y);
	if (cached) return cached.arrayBuffer();

	const build = NETWORK_URL[source];
	if (!build) throw new Error(`Unknown offline source: ${source}`);

	try {
		const resp = await fetch(build(z, x, y), { signal });
		if (!resp.ok) throw new Error(`Tile ${resp.status}`);
		const buf = await resp.arrayBuffer();
		// Warm-cache tiles browsed inside a downloaded area so panning there
		// offline works even for zooms the bulk download hasn't reached yet.
		if (await isInsideDownloadedArea(z, x, y)) {
			await tileStore.put(source, z, x, y, new Blob([buf]));
		}
		return buf;
	} catch (err) {
		if (signal?.aborted) throw err;
		// Offline and not cached → no data (protocol renders a gap rather than erroring).
		return null;
	}
}

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
