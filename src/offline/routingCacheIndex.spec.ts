import { describe, expect, it } from 'vitest';
import {
	DAY_MS,
	MB,
	RoutingCacheIndex,
	budgetBytesFromMb,
	cacheKey,
	isExpired,
	type CacheEntryMeta
} from '@/offline/routingCacheIndex';
import { lngLatToTile, PROTOMAPS_MAX_ZOOM, TERRAIN_ROUTING_ZOOM } from '@/offline/tileMath';

const meta = (key: string, size: number, at: number, source = 'protomaps'): CacheEntryMeta => ({
	key,
	source,
	size,
	fetchedAt: at,
	lastUsedAt: at
});

describe('byte budget and LRU', () => {
	it('keeps the byte total within the budget and evicts least recently used first', () => {
		const index = new RoutingCacheIndex(1000);
		expect(index.add(meta('a', 400, 1), 1)).toEqual([]);
		expect(index.add(meta('b', 400, 2), 2)).toEqual([]);
		index.touch('a', 3); // b is now the least recently used
		expect(index.add(meta('c', 400, 4), 4)).toEqual(['b']);
		expect(index.keys()).toEqual(['a', 'c']);
		expect(index.totalBytes).toBe(800);
		expect(index.add(meta('d', 900, 5), 5)).toEqual(['a', 'c']);
		expect(index.totalBytes).toBeLessThanOrEqual(1000);
	});

	it('a tile larger than the whole budget is not kept', () => {
		const index = new RoutingCacheIndex(100);
		expect(index.add(meta('big', 101, 1), 1)).toEqual(['big']);
		expect(index.size).toBe(0);
	});

	it('replacing a key does not count it twice', () => {
		const index = new RoutingCacheIndex(1000);
		index.add(meta('a', 400, 1), 1);
		index.add(meta('a', 500, 2), 2);
		expect(index.totalBytes).toBe(500);
	});

	it('a smaller budget evicts down to it; load orders by last use', () => {
		const index = new RoutingCacheIndex(10_000);
		index.load([meta('new', 300, 30), meta('old', 300, 10), meta('mid', 300, 20)]);
		expect(index.keys()).toEqual(['old', 'mid', 'new']);
		expect(index.setBudget(400, 31)).toEqual(['old', 'mid']);
	});

	it('the settings value becomes bytes, invalid values fall back to the default', () => {
		expect(budgetBytesFromMb(100)).toBe(100 * MB);
		expect(budgetBytesFromMb(Number.NaN)).toBe(50 * MB);
		expect(budgetBytesFromMb(-5)).toBe(50 * MB);
	});
});

describe('TTL', () => {
	it('basemap tiles expire after 30 days, DEM tiles after 180 days', () => {
		const t0 = 1_000_000;
		expect(isExpired({ source: 'protomaps', fetchedAt: t0 }, t0 + 30 * DAY_MS)).toBe(false);
		expect(isExpired({ source: 'protomaps', fetchedAt: t0 }, t0 + 30 * DAY_MS + 1)).toBe(true);
		expect(isExpired({ source: 'terrain', fetchedAt: t0 }, t0 + 179 * DAY_MS)).toBe(false);
		expect(isExpired({ source: 'terrain', fetchedAt: t0 }, t0 + 180 * DAY_MS + 1)).toBe(true);
	});

	it('expired entries are not served and go first at the next eviction', () => {
		const index = new RoutingCacheIndex(10_000);
		index.add(meta('basemap', 100, 0, 'protomaps'), 0);
		index.add(meta('dem', 100, 0, 'terrain'), 0);
		const later = 31 * DAY_MS;
		expect(index.has('basemap', later)).toBe(false);
		expect(index.has('dem', later)).toBe(true);
		expect(index.evict(later)).toEqual(['basemap']);
		expect(index.keys()).toEqual(['dem']);
	});
});

describe('a 20 km drive (synthetic tile stream)', () => {
	it('never exceeds the budget and keeps the tiles around the current position', () => {
		const budget = 5 * MB;
		const index = new RoutingCacheIndex(budget);
		let now = 0;
		let maxTotal = 0;
		let lastKeys: string[] = [];
		// Eastwards along 48° N, a 2 km ring every 500 m: basemap z15 (≈ 30-120 kB,
		// denser in town) and DEM z14 (≈ 68 kB).
		for (let km = 0; km <= 20; km += 0.5) {
			const lng = 15 + km / (111.32 * Math.cos((48 * Math.PI) / 180));
			const ringKeys: string[] = [];
			for (const [z, source, size] of [
				[PROTOMAPS_MAX_ZOOM, 'protomaps', km > 8 && km < 12 ? 120_000 : 30_000],
				[TERRAIN_ROUTING_ZOOM, 'terrain', 68_000]
			] as const) {
				const min = lngLatToTile(lng - 0.027, 48.018, z);
				const max = lngLatToTile(lng + 0.027, 47.982, z);
				for (let x = min.x; x <= max.x; x++) {
					for (let y = min.y; y <= max.y; y++) {
						const key = cacheKey(source, z, x, y);
						now += 1000;
						if (index.has(key, now)) index.touch(key, now);
						else index.add(meta(key, size, now, source), now);
						ringKeys.push(key);
						maxTotal = Math.max(maxTotal, index.totalBytes);
					}
				}
			}
			lastKeys = ringKeys;
		}
		expect(maxTotal).toBeLessThanOrEqual(budget);
		expect(lastKeys.every((k) => index.has(k, now))).toBe(true);
	});
});
