import type { GeoBounds } from '@/types/geo';
import {
	PROTOMAPS_MAX_ZOOM,
	SATELLITE_MAX_ZOOM,
	TERRAIN_DOWNLOAD_ZOOMS,
	TERRAIN_ROUTING_ZOOM,
	tileCount,
	zoomRange
} from '@/offline/tileMath';

/**
 * Pre-download size estimates for offline areas. Pure: tile counts per zoom
 * times calibrated average bytes per tile. The estimates are rough, so the UI
 * shows them as a ±40 % range rather than a fake exact figure.
 */

/** Average compressed bytes per tile per source (all zooms unless overridden below). */
export const AVG_TILE_BYTES: Record<string, number> = {
	protomaps: 45_000,
	satellite: 25_000,
	terrain: 35_000
};

/**
 * Per-zoom overrides. The routing DEM z14 tiles carry far more relief detail
 * than the overview zooms: the routing fixtures measured ~68 kB per tile in
 * the Alps (plan §6.14); flatter land compresses better, so 65 kB.
 */
export const AVG_TILE_BYTES_BY_ZOOM: Record<string, Record<number, number>> = {
	terrain: { [TERRAIN_ROUTING_ZOOM]: 65_000 }
};

/** The zooms an offline area downloads per source. */
export const SOURCE_ZOOMS: Record<string, readonly number[]> = {
	protomaps: zoomRange(PROTOMAPS_MAX_ZOOM),
	satellite: zoomRange(SATELLITE_MAX_ZOOM),
	terrain: TERRAIN_DOWNLOAD_ZOOMS
};

/** Average bytes of one tile of `source` at zoom `z`. */
export function avgTileBytes(source: string, z: number): number {
	return AVG_TILE_BYTES_BY_ZOOM[source]?.[z] ?? AVG_TILE_BYTES[source] ?? 0;
}

/** Estimated download bytes for one tile source over the given bounds, summed per zoom. */
export function estimateSourceBytes(bounds: GeoBounds, source: string): number {
	return (SOURCE_ZOOMS[source] ?? []).reduce(
		(sum, z) => sum + tileCount(bounds, z, z) * avgTileBytes(source, z),
		0
	);
}

/** Widens a byte estimate into a ±40% MB range (raw numbers, not localized). */
export function estimateRangeMb(bytes: number): { low: number; high: number } {
	const mb = bytes / (1024 * 1024);
	const low = Math.max(1, Math.round(mb * 0.6));
	const high = Math.max(low, Math.round(mb * 1.4));
	return { low, high };
}
