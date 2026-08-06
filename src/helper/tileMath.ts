/**
 * Minimal Web-Mercator slippy-tile helpers.
 *
 * Used by the marker freshness registry (§1.4) and by the IndexedDB marker
 * cache, whose rows carry a tile key so a viewport read can be answered from a
 * handful of index lookups instead of a scan.
 */

import { GeoBounds } from '@/types/geo';

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

/**
 * Every zoom-{@link z} tile overlapping {@link bounds}, as {@link tileKey}
 * strings.
 *
 * Walks the x axis with wrap-around so bounds that cross the antimeridian
 * (`west > east`, which `boundsContains` accepts too) enumerate the two short
 * runs either side of ±180° rather than the whole planet the other way round.
 * The column count is capped at `2 ** z`, so a world-spanning bbox yields each
 * column exactly once.
 */
export function tileKeysForBounds(bounds: GeoBounds, z: number): string[] {
	const n = 2 ** z;
	const nw = lngLatToTile(bounds.north, bounds.west, z);
	const se = lngLatToTile(bounds.south, bounds.east, z);

	// y grows southward, so `north` maps to the smaller index — but the caller's
	// bounds are not guaranteed to be normalized, hence min/max rather than a
	// straight nw.y → se.y walk.
	const yStart = Math.min(nw.y, se.y);
	const yEnd = Math.max(nw.y, se.y);
	const columns = Math.min(n, ((se.x - nw.x + n) % n) + 1);

	const keys: string[] = [];
	for (let i = 0; i < columns; i++) {
		const x = (nw.x + i) % n;
		for (let y = yStart; y <= yEnd; y++) {
			keys.push(tileKey({ z, x, y }));
		}
	}
	return keys;
}
