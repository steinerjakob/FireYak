import { GeoPoint } from '@/types/geo';
import type { ElevationPoint } from '@/helper/elevationData';
import { fetchTileCacheFirst } from '@/offline/offlineProtocol';
import { TERRAIN_MAX_ZOOM, TERRAIN_ROUTING_ZOOM } from '@/offline/tileMath';
import {
	type DecodedDemTile,
	sampleBlended,
	terrariumToElevations,
	tilesForSamples
} from '@/helper/demRaster';

/**
 * Elevation sampling from the Mapterhorn terrain tiles (terrarium-encoded
 * raster DEM) that the map already uses for hillshade/3D. Tiles go through the
 * same cache-first pipeline as the map (`offline://terrain/...`), so inside a
 * downloaded area this works fully offline — the pump calculation no longer
 * needs the Open-Meteo API there.
 *
 * The pure parts (terrarium decode, cross-tile bilinear sampling) live in
 * `demRaster.ts`; this module fetches and decodes the images.
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
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	return canvas.getContext('2d', { willReadFrequently: true });
}

/** Decodes a terrarium webp/png tile into per-pixel elevations in meters (browser). */
async function decodeTerrariumImage(buf: ArrayBuffer): Promise<DecodedDemTile> {
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

let decodeTile: DemTileDecoder = decodeTerrariumImage;

/**
 * Replaces the image decoder. Node has no `createImageBitmap`, so specs pass a
 * WASM WebP decoder here; the app never calls this.
 */
export function setDemTileDecoder(decoder: DemTileDecoder | null): void {
	decodeTile = decoder ?? decodeTerrariumImage;
	tileCache.clear();
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
	// Fetch + decode each distinct tile once. Tiles are pinned in a local map
	// for this call so LRU eviction can't drop one mid-computation.
	const tiles = new Map<string, DecodedDemTile>();
	const keys = [...tilesForSamples(points, z)];
	await Promise.all(
		keys.map(async (key) => {
			const cacheKey = `${z}/${key}`;
			let tile = cacheGet(cacheKey);
			if (!tile) {
				const [x, y] = key.split('/').map(Number);
				const buf = await fetchTileCacheFirst('terrain', z, x, y, signal);
				if (!buf || buf.byteLength === 0) return;
				tile = await decodeTile(buf);
				cachePut(cacheKey, tile);
			}
			tiles.set(key, tile);
		})
	);
	const heights: number[] = [];
	for (const point of points) {
		const h = sampleBlended(tiles, point, z);
		if (h === null) return null;
		heights.push(h);
	}
	return heights;
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
