/**
 * Minimal Web-Mercator slippy-tile helpers.
 *
 * Only what the freshness registry (§1.4) needs today — a fuller version
 * (tile-range enumeration, tile → bounds, etc.) arrives with the offline-mode
 * area download.
 */

export interface TileCoord {
	z: number;
	x: number;
	y: number;
}

/**
 * Returns the slippy tile containing the given lat/lng at zoom {@link z}.
 * Standard Web-Mercator formula; the result is clamped into the valid
 * `0 … 2^z - 1` range so points at/near the poles or antimeridian stay valid.
 */
export function lngLatToTile(lat: number, lng: number, z: number): TileCoord {
	const n = 2 ** z;
	const latRad = (lat * Math.PI) / 180;
	const x = Math.floor(((lng + 180) / 360) * n);
	const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
	const clamp = (v: number) => Math.min(n - 1, Math.max(0, v));
	return { z, x: clamp(x), y: clamp(y) };
}

/** Stable string key for a tile, e.g. `"12/2200/1416"`. */
export function tileKey(tile: TileCoord): string {
	return `${tile.z}/${tile.x}/${tile.y}`;
}
