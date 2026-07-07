import { GeoPoint } from '@/types/geo';
import type { ElevationPoint } from '@/helper/elevationData';
import { fetchTileCacheFirst } from '@/offline/offlineProtocol';
import { TERRAIN_MAX_ZOOM } from '@/offline/tileMath';

/**
 * Elevation sampling from the Mapterhorn terrain tiles (terrarium-encoded
 * raster DEM) that the map already uses for hillshade/3D. Tiles go through the
 * same cache-first pipeline as the map (`offline://terrain/...`), so inside a
 * downloaded area this works fully offline — the pump calculation no longer
 * needs the Open-Meteo API there.
 */

/** Sample at the DEM's max zoom: z12 × 512 px ≈ 19 m/px at ~47° latitude. */
const DEM_ZOOM = TERRAIN_MAX_ZOOM;

/** Decoded tiles kept in memory (Float32Array per tile, ~1 MB each). */
const TILE_CACHE_LIMIT = 8;

interface DecodedTile {
	size: number;
	elevations: Float32Array;
}

/** Insertion-ordered Map used as an LRU (touch = delete + re-set). */
const tileCache = new Map<string, DecodedTile>();

function cacheGet(key: string): DecodedTile | undefined {
	const tile = tileCache.get(key);
	if (tile) {
		tileCache.delete(key);
		tileCache.set(key, tile);
	}
	return tile;
}

function cachePut(key: string, tile: DecodedTile): void {
	tileCache.set(key, tile);
	while (tileCache.size > TILE_CACHE_LIMIT) {
		const oldest = tileCache.keys().next().value as string;
		tileCache.delete(oldest);
	}
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

/** Decodes a terrarium webp/png tile into per-pixel elevations in meters. */
async function decodeTerrariumTile(buf: ArrayBuffer): Promise<DecodedTile> {
	const bitmap = await createImageBitmap(new Blob([buf]));
	try {
		const size = bitmap.width;
		const ctx = make2dContext(size);
		if (!ctx) throw new Error('No 2d canvas context for DEM decode');
		ctx.drawImage(bitmap, 0, 0);
		const { data } = ctx.getImageData(0, 0, size, size);
		const elevations = new Float32Array(size * size);
		for (let i = 0; i < elevations.length; i++) {
			const p = i * 4;
			// Terrarium encoding: elevation = r*256 + g + b/256 - 32768.
			elevations[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
		}
		return { size, elevations };
	} finally {
		bitmap.close();
	}
}

/** Continuous web-mercator tile coordinate (tile index + in-tile fraction). */
function pointToTileCoord(point: GeoPoint, z: number): { tx: number; ty: number } {
	const n = 2 ** z;
	const tx = ((point.lng + 180) / 360) * n;
	const latRad = (point.lat * Math.PI) / 180;
	const ty = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
	return { tx, ty };
}

function tileIndex(t: number, n: number): number {
	return Math.min(Math.max(Math.floor(t), 0), n - 1);
}

/**
 * Bilinear sample inside a single tile. The sample window is clamped to the
 * tile, so points within half a pixel (~10 m) of a tile edge degrade to the
 * edge pixel instead of blending into the neighbor tile — an acceptable error
 * at the 20 m elevation raster, and it saves fetching up to three extra tiles
 * per point.
 */
function sampleTile(tile: DecodedTile, fx: number, fy: number): number {
	const { size, elevations } = tile;
	const x = Math.min(Math.max(fx * size - 0.5, 0), size - 1);
	const y = Math.min(Math.max(fy * size - 0.5, 0), size - 1);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, size - 1);
	const y1 = Math.min(y0 + 1, size - 1);
	const dx = x - x0;
	const dy = y - y0;
	const top = elevations[y0 * size + x0] * (1 - dx) + elevations[y0 * size + x1] * dx;
	const bottom = elevations[y1 * size + x0] * (1 - dx) + elevations[y1 * size + x1] * dx;
	return top * (1 - dy) + bottom * dy;
}

/**
 * Elevations for `points` from the terrain DEM tiles, or `null` when any
 * needed tile is unavailable (offline and uncached, or decode failure) — the
 * caller falls back to another source rather than mixing DEMs.
 */
export async function getDemElevations(points: GeoPoint[]): Promise<ElevationPoint[] | null> {
	if (points.length === 0) return [];
	try {
		const n = 2 ** DEM_ZOOM;
		// Fetch + decode each distinct tile once (points come in path order, so
		// consecutive points usually share a tile). Tiles are pinned in a local
		// map for this call so LRU eviction can't drop one mid-computation.
		const neededTiles = new Set<string>();
		for (const point of points) {
			const { tx, ty } = pointToTileCoord(point, DEM_ZOOM);
			neededTiles.add(`${tileIndex(tx, n)}/${tileIndex(ty, n)}`);
		}
		const tiles = new Map<string, DecodedTile>();
		for (const key of neededTiles) {
			let tile = cacheGet(key);
			if (!tile) {
				const [x, y] = key.split('/').map(Number);
				const buf = await fetchTileCacheFirst('terrain', DEM_ZOOM, x, y);
				if (!buf || buf.byteLength === 0) return null;
				tile = await decodeTerrariumTile(buf);
				cachePut(key, tile);
			}
			tiles.set(key, tile);
		}
		return points.map((point) => {
			const { tx, ty } = pointToTileCoord(point, DEM_ZOOM);
			const x = tileIndex(tx, n);
			const y = tileIndex(ty, n);
			const tile = tiles.get(`${x}/${y}`) as DecodedTile;
			const elevation = sampleTile(tile, tx - x, ty - y);
			return { latLng: point, elevation: Math.round(elevation * 10) / 10 };
		});
	} catch (e) {
		console.warn('DEM elevation sampling failed, falling back:', e);
		return null;
	}
}
