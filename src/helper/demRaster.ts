import type { GeoPoint } from '@/types/geo';

/**
 * Pure DEM raster helpers: terrarium decoding of RGBA pixels and bilinear
 * sampling **across** tile edges (plan §6.4, phase 1). Image decoding and
 * fetching stay in `demElevation.ts`; this module has no I/O so specs can run
 * it in Node.
 */

export interface DecodedDemTile {
	/** Edge length in pixels (Mapterhorn: 512). */
	size: number;
	/** Row-major elevations in metres. */
	elevations: Float32Array;
}

/** Elevations from RGBA pixels: terrarium `r*256 + g + b/256 - 32768`. */
export function terrariumToElevations(rgba: ArrayLike<number>, pixelCount: number): Float32Array {
	const elevations = new Float32Array(pixelCount);
	for (let i = 0; i < pixelCount; i++) {
		const p = i * 4;
		elevations[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
	}
	return elevations;
}

/** Continuous web-mercator tile coordinate (tile index + in-tile fraction). */
export function pointToTileCoord(point: GeoPoint, z: number): { tx: number; ty: number } {
	const n = 2 ** z;
	const tx = ((point.lng + 180) / 360) * n;
	const latRad = (point.lat * Math.PI) / 180;
	const ty = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
	return { tx, ty };
}

/** Tile key `x/y` used by the samplers. */
export function tileKey(x: number, y: number): string {
	return `${x}/${y}`;
}

/**
 * The four global pixel indexes (and weights) a bilinear sample at `point`
 * reads. Pixel centres sit at +0.5, so a point near a tile edge reads pixels
 * of the neighbouring tile.
 */
function bilinearPixels(point: GeoPoint, z: number, size: number) {
	const { tx, ty } = pointToTileCoord(point, z);
	const gx = tx * size - 0.5;
	const gy = ty * size - 0.5;
	const x0 = Math.floor(gx);
	const y0 = Math.floor(gy);
	return { x0, y0, dx: gx - x0, dy: gy - y0 };
}

/**
 * Keys of every tile a set of bilinear samples reads at zoom `z`, including
 * the neighbour tiles needed at tile edges.
 */
export function tilesForSamples(points: GeoPoint[], z: number, size = 512): Set<string> {
	const n = 2 ** z;
	const keys = new Set<string>();
	for (const point of points) {
		const { x0, y0 } = bilinearPixels(point, z, size);
		for (const px of [x0, x0 + 1]) {
			for (const py of [y0, y0 + 1]) {
				const x = Math.min(Math.max(Math.floor(px / size), 0), n - 1);
				const y = Math.min(Math.max(Math.floor(py / size), 0), n - 1);
				keys.add(tileKey(x, y));
			}
		}
	}
	return keys;
}

/**
 * Bilinear elevation at `point` from the decoded tiles in `tiles` (keyed by
 * {@link tileKey}). Pixels of a missing neighbour tile are replaced by the
 * nearest pixel of the tile the point lies in (the old clamped behaviour), so
 * a gap degrades gracefully. Returns `null` when the point's own tile is
 * missing.
 */
export function sampleBlended(
	tiles: Map<string, DecodedDemTile>,
	point: GeoPoint,
	z: number
): number | null {
	const { tx, ty } = pointToTileCoord(point, z);
	const homeX = Math.floor(tx);
	const homeY = Math.floor(ty);
	const home = tiles.get(tileKey(homeX, homeY));
	if (!home) return null;
	const size = home.size;
	const { x0, y0, dx, dy } = bilinearPixels(point, z, size);

	const pixel = (gx: number, gy: number): number => {
		const x = Math.floor(gx / size);
		const y = Math.floor(gy / size);
		const tile = x === homeX && y === homeY ? home : tiles.get(tileKey(x, y));
		if (tile && tile.size === size) {
			return tile.elevations[(gy - y * size) * size + (gx - x * size)];
		}
		// Neighbour missing: clamp into the home tile.
		const lx = Math.min(Math.max(gx - homeX * size, 0), size - 1);
		const ly = Math.min(Math.max(gy - homeY * size, 0), size - 1);
		return home.elevations[ly * size + lx];
	};

	const top = pixel(x0, y0) * (1 - dx) + pixel(x0 + 1, y0) * dx;
	const bottom = pixel(x0, y0 + 1) * (1 - dx) + pixel(x0 + 1, y0 + 1) * dx;
	return top * (1 - dy) + bottom * dy;
}
