import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { RoutingCacheStore } from '@/offline/routingCache';
import { DAY_MS } from '@/offline/routingCacheIndex';

let dbCount = 0;
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill).buffer;

function store(budget: number, clock = { now: 1_000_000 }) {
	const name = `routing-cache-spec-${dbCount++}`;
	return { name, clock, cache: new RoutingCacheStore(name, budget, () => clock.now) };
}

describe('routing cache (IndexedDB)', () => {
	it('stores, reads back copies and survives a restart', async () => {
		const { name, clock, cache } = store(10_000);
		const original = bytes(100, 7);
		await cache.put('protomaps', 15, 1, 2, original);
		// The caller may transfer (detach) its buffer right after put.
		structuredClone(original, { transfer: [original] });
		const read = await cache.get('protomaps', 15, 1, 2);
		expect(new Uint8Array(read!)[0]).toBe(7);
		expect(read!.byteLength).toBe(100);

		const restarted = new RoutingCacheStore(name, 10_000, () => clock.now);
		await restarted.whenReady();
		expect(restarted.has('protomaps', 15, 1, 2)).toBe(true);
		expect(restarted.sizeBytes()).toBe(100);
	});

	it('evicts least recently used tiles by bytes, also from the database', async () => {
		const { name, clock, cache } = store(250);
		await cache.put('protomaps', 15, 0, 0, bytes(100));
		clock.now += 1;
		await cache.put('protomaps', 15, 0, 1, bytes(100));
		clock.now += 1;
		await cache.get('protomaps', 15, 0, 0); // 0/1 is now least recently used
		clock.now += 1;
		await cache.put('terrain', 14, 0, 0, bytes(100));
		expect(cache.has('protomaps', 15, 0, 1)).toBe(false);
		expect(cache.sizeBytes()).toBeLessThanOrEqual(250);

		const restarted = new RoutingCacheStore(name, 250, () => clock.now);
		expect(await restarted.get('protomaps', 15, 0, 1)).toBeNull();
		expect(await restarted.get('protomaps', 15, 0, 0)).not.toBeNull();
		expect(await restarted.get('terrain', 14, 0, 0)).not.toBeNull();
	});

	it('expired tiles are not served: basemap after 30 days, DEM after 180', async () => {
		const { clock, cache } = store(10_000);
		await cache.put('protomaps', 15, 0, 0, bytes(10));
		await cache.put('terrain', 14, 0, 0, bytes(10));
		clock.now += 31 * DAY_MS;
		expect(await cache.get('protomaps', 15, 0, 0)).toBeNull();
		expect(await cache.get('terrain', 14, 0, 0)).not.toBeNull();
		clock.now += 150 * DAY_MS;
		expect(await cache.get('terrain', 14, 0, 0)).toBeNull();
		expect(cache.sizeBytes()).toBe(0);
	});

	it('a lower budget evicts at once; clear empties it', async () => {
		const { clock, cache } = store(10_000);
		for (let i = 0; i < 5; i++) {
			clock.now += 1;
			await cache.put('protomaps', 15, i, 0, bytes(100));
		}
		await cache.setBudget(250);
		expect(cache.tileCount()).toBe(2);
		expect(cache.has('protomaps', 15, 4, 0)).toBe(true);
		await cache.clear();
		expect(cache.tileCount()).toBe(0);
		expect(await cache.get('protomaps', 15, 4, 0)).toBeNull();
	});
});
