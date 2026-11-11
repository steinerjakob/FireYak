import { GeoPoint } from '@/types/geo';
import type { ElevationPoint } from '@/helper/elevationData';
import { TERRAIN_MAX_ZOOM, TERRAIN_ROUTING_ZOOM } from '@/offline/tileMath';
import {
	type DecodedDemTile,
	type HeightRaster,
	type RasterFrame,
	buildHeightRaster,
	sampleBlended,
	terrariumToElevations,
	tilesForFrame,
	tilesForSamples
} from '@/helper/demRaster';

/**
 * Elevation sampling from the Mapterhorn terrain tiles (terrarium-encoded
 * raster DEM): the decode LRU, the routing height raster and route profiles.
 *
 * This module has no app I/O import, so it runs on the main thread and in the
 * hose routing worker (plan §6.10); each realm has its own LRU. Where the tile
 * bytes come from is injected with {@link setDemTileFetcher}: on the main
 * thread `demElevation.ts` sets the cache-first `offline://` pipeline, in the
 * worker the bytes are fetched by the main thread and transferred. The pure
 * parts (terrarium decode, cross-tile bilinear sampling) live in `demRaster.ts`.
 */

/** Pump-calculation zoom: z12 × 512 px ≈ 12.8 m/px at 48° latitude. */
const DEM_ZOOM = TERRAIN_MAX_ZOOM;

/** Decoded tiles kept in memory (Float32Array per tile, ~1 MB each; ESTIMATE 16 MB). */
const TILE_CACHE_LIMIT = 16;

/** Insertion-ordered Map used as an LRU (touch = delete + re-set), keyed `z/x/y`. */
const tileCache = new Map<string, DecodedDemTile>();

function cacheGet(key: string): DecodedDemTile | undefined {
	const tile = tileCache.get(key);
	if (tile) {
		tileCache.delete(key);
		tileCache.set(key, tile);
	}
	return tile;
}

function cachePut(key: string, tile: DecodedDemTile): void {
	tileCache.set(key, tile);
	while (tileCache.size > TILE_CACHE_LIMIT) {
		const oldest = tileCache.keys().next().value as string;
		tileCache.delete(oldest);
	}
}

/** Drops every decoded DEM tile (tests and offline-area changes). */
export function invalidateDemCache(): void {
	tileCache.clear();
}

function make2dContext(
	size: number
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
	if (typeof OffscreenCanvas !== 'undefined') {
		return new OffscreenCanvas(size, size).getContext('2d', { willReadFrequently: true });
	}
	if (typeof document === 'undefined') return null;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	return canvas.getContext('2d', { willReadFrequently: true });
}

/**
 * Decodes a terrarium webp/png tile into per-pixel elevations in meters
 * (browser: `createImageBitmap` and a 2D canvas, offscreen where available).
 */
export async function decodeTerrariumImage(buf: ArrayBuffer): Promise<DecodedDemTile> {
	const bitmap = await createImageBitmap(new Blob([buf]));
	try {
		const size = bitmap.width;
		const ctx = make2dContext(size);
		if (!ctx) throw new Error('No 2d canvas context for DEM decode');
		ctx.drawImage(bitmap, 0, 0);
		const { data } = ctx.getImageData(0, 0, size, size);
		return { size, elevations: terrariumToElevations(data, size * size) };
	} finally {
		bitmap.close();
	}
}

export type DemTileDecoder = (buf: ArrayBuffer) => Promise<DecodedDemTile>;

/** Fetches a tile's bytes; `null` = unavailable (offline and uncached). */
export type DemTileFetcher = (
	source: string,
	z: number,
	x: number,
	y: number,
	signal?: AbortSignal
) => Promise<ArrayBuffer | null>;

let decodeTile: DemTileDecoder = decodeTerrariumImage;

/** No fetcher configured: every tile is unavailable. */
const noTiles: DemTileFetcher = async () => null;
let fetchTile: DemTileFetcher = noTiles;

/**
 * Sets where this realm's DEM tile bytes come from (main thread: the
 * cache-first `offline://` pipeline; worker: the main thread). Drops the
 * decoded tiles.
 */
export function setDemTileFetcher(fetcher: DemTileFetcher | null): void {
	fetchTile = fetcher ?? noTiles;
	tileCache.clear();
}

/**
 * Replaces the image decoder. Node has no `createImageBitmap`, so specs pass a
 * WASM WebP decoder here; a worker without `OffscreenCanvas` passes one that
 * asks the main thread to decode.
 */
export function setDemTileDecoder(decoder: DemTileDecoder | null): void {
	decodeTile = decoder ?? decodeTerrariumImage;
	tileCache.clear();
}

/**
 * Fetches and decodes the DEM tiles `keys` (`x/y`) at zoom `z`, cache-first.
 * Tiles that are unavailable (offline and uncached, or a decode failure) are
 * left out. With `tolerant`, an abort or a failing tile only drops that tile;
 * otherwise the first error is rethrown.
 */
async function loadDemTiles(
	keys: Iterable<string>,
	z: number,
	signal?: AbortSignal,
	tolerant = false,
	tiles = new Map<string, DecodedDemTile>()
): Promise<Map<string, DecodedDemTile>> {
	// Tiles are pinned in a local map for this call so LRU eviction can't drop
	// one mid-computation; with `tiles` given, each lands there as it arrives.
	await Promise.all(
		[...keys].map(async (key) => {
			const cacheKey = `${z}/${key}`;
			try {
				let tile = cacheGet(cacheKey);
				if (!tile) {
					const [x, y] = key.split('/').map(Number);
					const buf = await fetchTile('terrain', z, x, y, signal);
					if (!buf || buf.byteLength === 0) return;
					tile = await decodeTile(buf);
					cachePut(cacheKey, tile);
				}
				tiles.set(key, tile);
			} catch (e) {
				if (!tolerant) throw e;
			}
		})
	);
	return tiles;
}

/**
 * Elevations (metres) for `points` at DEM zoom `z`, bilinear across tile
 * edges (neighbour tiles are fetched as needed). `null` when a tile a point
 * lies in is unavailable (offline and uncached, or a decode failure); a missing
 * neighbour only degrades the edge pixels. Rethrows when `signal` aborts.
 */
export async function sampleElevationsBlended(
	points: GeoPoint[],
	z: number,
	signal?: AbortSignal
): Promise<number[] | null> {
	if (points.length === 0) return [];
	const tiles = await loadDemTiles(tilesForSamples(points, z), z, signal);
	const heights: number[] = [];
	for (const point of points) {
		const h = sampleBlended(tiles, point, z);
		if (h === null) return null;
		heights.push(h);
	}
	return heights;
}

/** Cells of the raster (halo included) without a height. */
function unknownCells(raster: HeightRaster): number {
	let n = 0;
	for (const h of raster.heights) if (Number.isNaN(h)) n++;
	return n;
}

/** Budget for the routing DEM (both zooms are fetched at once, plan §6.9). */
export const ROUTING_DEM_BUDGET_MS = 1500;

/**
 * The height raster of a cost grid (plan §6.4): z14
 * ({@link TERRAIN_ROUTING_ZOOM}) when its tiles cover every cell within the
 * budget (a missing neighbour tile only degrades the edge pixels), else z12
 * (grades over the 24 m baseline), else a partial z14 raster (unknown cells
 * cost no slope), else `null` (routing without slope). Both zooms are
 * requested at once and the wait stops at `budgetMs`; the z12 tiles are few
 * and usually cached (display tiles, offline areas). Tiles still in flight at
 * the deadline are not aborted: they land in the decode cache, so the next
 * routing request finds them (see {@link isCompleteRoutingRaster}).
 */
export async function loadRoutingHeights(
	frame: RasterFrame,
	budgetMs = ROUTING_DEM_BUDGET_MS
): Promise<HeightRaster | null> {
	const fine = new Map<string, DecodedDemTile>();
	const coarse = new Map<string, DecodedDemTile>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, budgetMs);
	});
	const all = Promise.all([
		loadDemTiles(
			tilesForFrame(frame, TERRAIN_ROUTING_ZOOM),
			TERRAIN_ROUTING_ZOOM,
			undefined,
			true,
			fine
		),
		loadDemTiles(tilesForFrame(frame, TERRAIN_MAX_ZOOM), TERRAIN_MAX_ZOOM, undefined, true, coarse)
	]);
	try {
		await Promise.race([all, deadline]);
		// Snapshot: tiles arriving later must not change a raster being built.
		const fineRaster =
			fine.size > 0 ? buildHeightRaster(frame, new Map(fine), TERRAIN_ROUTING_ZOOM) : null;
		if (fineRaster && unknownCells(fineRaster) === 0) return fineRaster;
		const coarseRaster =
			coarse.size > 0 ? buildHeightRaster(frame, new Map(coarse), TERRAIN_MAX_ZOOM) : null;
		if (coarseRaster && unknownCells(coarseRaster) === 0) return coarseRaster;
		return fineRaster ?? coarseRaster;
	} catch (e) {
		console.warn('Routing DEM failed, routing without slope:', e);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * True when a routing raster is the best one there is (z14, every cell known).
 * Anything less is worth loading again on the next request: the tiles that
 * missed the budget may have arrived since.
 */
export function isCompleteRoutingRaster(raster: HeightRaster | null): boolean {
	return raster !== null && raster.zoom >= TERRAIN_ROUTING_ZOOM && unknownCells(raster) === 0;
}

/** Budget for the z14 attempt before the route profile falls back to z12. */
export const ROUTE_DEM_BUDGET_MS = 1500;

/**
 * Heights for a route profile: z14 when its tiles arrive within the budget,
 * else z12 (callers show at most the amber class then), else `null`.
 */
export async function sampleRouteElevations(
	points: GeoPoint[],
	budgetMs = ROUTE_DEM_BUDGET_MS
): Promise<{ heights: number[]; zoom: number } | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), budgetMs);
	try {
		const heights = await sampleElevationsBlended(points, TERRAIN_ROUTING_ZOOM, controller.signal);
		if (heights) return { heights, zoom: TERRAIN_ROUTING_ZOOM };
	} catch (e) {
		if (!controller.signal.aborted) console.warn('DEM z14 sampling failed:', e);
	} finally {
		clearTimeout(timer);
	}
	try {
		const heights = await sampleElevationsBlended(points, TERRAIN_MAX_ZOOM);
		if (heights) return { heights, zoom: TERRAIN_MAX_ZOOM };
	} catch (e) {
		console.warn('DEM z12 sampling failed:', e);
	}
	return null;
}

/**
 * Elevations for `points` from the terrain DEM tiles, or `null` when any
 * needed tile is unavailable (offline and uncached, or decode failure) — the
 * caller falls back to another source rather than mixing DEMs.
 */
export async function getDemElevations(points: GeoPoint[]): Promise<ElevationPoint[] | null> {
	if (points.length === 0) return [];
	try {
		const heights = await sampleElevationsBlended(points, DEM_ZOOM);
		if (!heights) return null;
		return points.map((point, i) => ({
			latLng: point,
			elevation: Math.round(heights[i] * 10) / 10
		}));
	} catch (e) {
		console.warn('DEM elevation sampling failed, falling back:', e);
		return null;
	}
}
