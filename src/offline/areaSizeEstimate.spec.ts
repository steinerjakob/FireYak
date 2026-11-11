import { describe, expect, it } from 'vitest';
import {
	AVG_TILE_BYTES,
	avgTileBytes,
	estimateRangeMb,
	estimateSourceBytes
} from '@/offline/areaSizeEstimate';
import { tileCount } from '@/offline/tileMath';

const bounds = { west: 15.28, east: 15.39, south: 48.2, north: 48.27 };

describe('offline area size estimate', () => {
	it('terrain counts z0-12 at the overview size and z14 at the routing DEM size', () => {
		const overview = tileCount(bounds, 0, 12) * AVG_TILE_BYTES.terrain;
		const routing = tileCount(bounds, 14, 14) * avgTileBytes('terrain', 14);
		expect(estimateSourceBytes(bounds, 'terrain')).toBe(overview + routing);
		expect(avgTileBytes('terrain', 14)).toBeGreaterThan(AVG_TILE_BYTES.terrain);
		// z14 dominates: an 8 km area grows from well under 1 MB to a few MB.
		expect(overview).toBeLessThan(1024 * 1024);
		const { low, high } = estimateRangeMb(overview + routing);
		expect(low).toBeGreaterThanOrEqual(1);
		expect(high).toBeGreaterThan(low);
	});

	it('the basemap estimate is unchanged (z0-15 at 45 kB)', () => {
		expect(estimateSourceBytes(bounds, 'protomaps')).toBe(tileCount(bounds, 0, 15) * 45_000);
	});
});
