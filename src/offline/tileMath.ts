import { GeoBounds } from '@/types/geo';

/**
 * Web-Mercator (XYZ) tile math shared by the download manager, the size
 * estimator and the offline protocol's write-through gate. Pure functions, no
 * side effects — safe to call from a tight worker-pool loop.
 */

export interface TileCoord {
	z: number;
	x: number;
	y: number;
}

// ---------------------------------------------------------------------------
// Per-source maximum download zoom levels (§2.3).
//   - Protomaps vector: z0–15, MapLibre overzooms past 15 for display.
//   - Satellite raster: capped at z17 for size; the style keeps maxzoom 19 so
//     18–19 are covered by overzoom of the downloaded z17 tiles.
//   - Terrain DEM (Mapterhorn): z0–12. Mapterhorn's tilejson advertises no
//     explicit maxzoom (defaults apply); 12 keeps the DEM download bounded and
//     matches the raster-dem source maxzoom inlined in MainMap's style.
// ---------------------------------------------------------------------------
export const PROTOMAPS_MAX_ZOOM = 15;
export const SATELLITE_MAX_ZOOM = 17;
export const TERRAIN_MAX_ZOOM = 12;

/** Converts a lng/lat pair to the XYZ tile it falls into at zoom `z`. */
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
	const n = 2 ** z;
	const x = Math.floor(((lng + 180) / 360) * n);
	const latRad = (lat * Math.PI) / 180;
	const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
	// Clamp into the valid tile grid so a bound sitting exactly on 180°/85° or a
	// tiny rounding overshoot can't yield an out-of-range tile index.
	return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

/**
 * Iterates every tile covering `b` from `zMin` to `zMax` inclusive. Yields
 * lazily (a generator, not an array) because z15+ tile lists for a district get
 * large — the download manager shares one iterator across its worker pool.
 */
export function* tilesForBounds(b: GeoBounds, zMin: number, zMax: number): Generator<TileCoord> {
	for (let z = zMin; z <= zMax; z++) {
		const min = lngLatToTile(b.west, b.north, z); // top-left
		const max = lngLatToTile(b.east, b.south, z); // bottom-right
		for (let x = min.x; x <= max.x; x++) {
			for (let y = min.y; y <= max.y; y++) yield { z, x, y };
		}
	}
}

/** Total tile count covering `b` from `zMin` to `zMax` (for progress + estimates). */
export function tileCount(b: GeoBounds, zMin: number, zMax: number): number {
	let count = 0;
	for (let z = zMin; z <= zMax; z++) {
		const min = lngLatToTile(b.west, b.north, z);
		const max = lngLatToTile(b.east, b.south, z);
		count += (max.x - min.x + 1) * (max.y - min.y + 1);
	}
	return count;
}

/**
 * Geographic bounds of a single XYZ tile — used by the offline protocol to test
 * whether a browsed tile lies inside a downloaded area before write-through
 * caching it.
 */
export function tileToBounds(z: number, x: number, y: number): GeoBounds {
	const n = 2 ** z;
	const lngW = (x / n) * 360 - 180;
	const lngE = ((x + 1) / n) * 360 - 180;
	const latN = tileYToLat(y, n);
	const latS = tileYToLat(y + 1, n);
	return { west: lngW, east: lngE, north: latN, south: latS };
}

function tileYToLat(y: number, n: number): number {
	const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
	return (latRad * 180) / Math.PI;
}
