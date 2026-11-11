import { describe, expect, it } from 'vitest';
import {
	TERRAIN_DOWNLOAD_ZOOMS,
	tileCount,
	tileCountForZooms,
	tilesForBounds,
	tilesForZooms
} from '@/offline/tileMath';

// About 8 × 8 km around Melk.
const bounds = { west: 15.28, east: 15.39, south: 48.2, north: 48.27 };

describe('tile lists per zoom list (offline areas with the routing DEM z14)', () => {
	it('terrain downloads z0-12 and z14, not z13', () => {
		expect(TERRAIN_DOWNLOAD_ZOOMS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]);
	});

	it('tilesForZooms([0..12, 14]) equals the sum of the per-zoom counts and skips z13', () => {
		const tiles = [...tilesForZooms(bounds, TERRAIN_DOWNLOAD_ZOOMS)];
		const perZoom = TERRAIN_DOWNLOAD_ZOOMS.reduce((sum, z) => sum + tileCount(bounds, z, z), 0);
		expect(tiles.length).toBe(perZoom);
		expect(tileCountForZooms(bounds, TERRAIN_DOWNLOAD_ZOOMS)).toBe(perZoom);
		expect(tiles.some((t) => t.z === 13)).toBe(false);
		expect(tiles.filter((t) => t.z === 14).length).toBe(tileCount(bounds, 14, 14));
	});

	it('keeps the old z0-12 order as a prefix, so resume cursors stay valid', () => {
		const old = [...tilesForBounds(bounds, 0, 12)];
		const now = [...tilesForZooms(bounds, TERRAIN_DOWNLOAD_ZOOMS)];
		expect(now.slice(0, old.length)).toEqual(old);
	});
});
