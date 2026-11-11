import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTileFetchers, type TileFetchDeps } from '@/offline/tileFetchers';
import { PRIORITY } from '@/offline/precachePolicy';

const key = (s: string, z: number, x: number, y: number) => `${s}/${z}/${x}/${y}`;
const bytes = (n: number) => new Uint8Array(n).fill(n % 255).buffer;

function fakes(options: { networkMs?: number; online?: boolean } = {}) {
	const area = new Map<string, Blob>();
	const cache = new Map<string, ArrayBuffer>();
	const calls: string[] = [];
	let arrived = 0;
	const deps: TileFetchDeps = {
		areaStore: {
			get: async (s, z, x, y) => area.get(key(s, z, x, y)) ?? null,
			has: async (s, z, x, y) => area.has(key(s, z, x, y)),
			put: async (s, z, x, y, blob) => void area.set(key(s, z, x, y), blob)
		},
		routingCache: {
			get: async (s, z, x, y) => cache.get(key(s, z, x, y))?.slice(0) ?? null,
			has: (s, z, x, y) => cache.has(key(s, z, x, y)),
			put: async (s, z, x, y, b) => void cache.set(key(s, z, x, y), b.slice(0)),
			whenReady: async () => undefined
		},
		network: (s, z, x, y, signal) =>
			new Promise((resolve, reject) => {
				calls.push(key(s, z, x, y));
				const timer = setTimeout(() => resolve(bytes(10 + x)), options.networkMs ?? 0);
				signal?.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new DOMException('aborted', 'AbortError'));
				});
			}),
		insideDownloadedArea: async () => false,
		isOnline: () => options.online ?? true,
		onArrived: () => {
			arrived++;
		}
	};
	return { deps, area, cache, calls, arrivals: () => arrived };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('lookup order: downloaded areas, routing cache, network', () => {
	it('a tile in a downloaded area is served from there, before the routing cache and the network', async () => {
		const f = fakes();
		f.area.set(key('terrain', 14, 1, 1), new Blob([new Uint8Array([1, 2, 3])]));
		f.cache.set(key('terrain', 14, 1, 1), bytes(99));
		const fetchers = createTileFetchers(f.deps);
		const got = await fetchers.fetchRoutingTile('terrain', 14, 1, 1);
		expect(got!.byteLength).toBe(3);
		expect(f.calls).toEqual([]);
		// Precaching skips it too.
		f.cache.clear();
		expect(await fetchers.prefetchTile('terrain', 14, 1, 1, PRIORITY.gpsRing)).toBe(false);
		expect(f.calls).toEqual([]);
	});

	it('the routing cache answers before the network, also for map browsing', async () => {
		const f = fakes();
		f.cache.set(key('protomaps', 15, 2, 2), bytes(42));
		const fetchers = createTileFetchers(f.deps);
		expect((await fetchers.fetchTileCacheFirst('protomaps', 15, 2, 2))!.byteLength).toBe(42);
		expect((await fetchers.fetchRoutingTile('protomaps', 15, 2, 2))!.byteLength).toBe(42);
		expect(f.calls).toEqual([]);
	});

	it('routing fills the routing cache and reports the arrival; map browsing does not', async () => {
		const f = fakes();
		const fetchers = createTileFetchers(f.deps);
		const p = fetchers.fetchRoutingTile('protomaps', 15, 3, 3);
		await vi.runAllTimersAsync();
		expect((await p)!.byteLength).toBe(13);
		expect(f.cache.has(key('protomaps', 15, 3, 3))).toBe(true);
		expect(f.arrivals()).toBe(1);

		const m = fetchers.fetchTileCacheFirst('protomaps', 15, 4, 4);
		await vi.runAllTimersAsync();
		expect(await m).not.toBeNull();
		expect(f.cache.has(key('protomaps', 15, 4, 4))).toBe(false);
		expect(f.arrivals()).toBe(1);
	});

	it('offline: no network request, the tile is missing', async () => {
		const f = fakes({ online: false });
		const fetchers = createTileFetchers(f.deps);
		expect(await fetchers.fetchRoutingTile('protomaps', 15, 5, 5)).toBeNull();
		expect(await fetchers.prefetchTile('protomaps', 15, 5, 5, PRIORITY.gpsRing)).toBe(false);
		expect(f.calls).toEqual([]);
	});
});

describe('the routing budget', () => {
	it('the wait ends when the budget aborts; the fetch lands later in the cache', async () => {
		const f = fakes({ networkMs: 5000 });
		const fetchers = createTileFetchers(f.deps);
		const budget = new AbortController();
		setTimeout(() => budget.abort(), 1500);
		let answer: ArrayBuffer | null | undefined;
		void fetchers.fetchRoutingTile('terrain', 14, 7, 7, budget.signal).then((b) => (answer = b));
		await vi.advanceTimersByTimeAsync(1500);
		expect(answer).toBeNull();
		expect(f.cache.has(key('terrain', 14, 7, 7))).toBe(false);
		await vi.advanceTimersByTimeAsync(3500);
		expect(f.cache.has(key('terrain', 14, 7, 7))).toBe(true);
		expect(f.arrivals()).toBe(1);
	});

	it('with the budget spent only local tiles are read; a background fetch is started', async () => {
		const f = fakes({ networkMs: 100 });
		const fetchers = createTileFetchers(f.deps);
		const spent = AbortSignal.abort();
		expect(await fetchers.fetchRoutingTile('terrain', 12, 8, 8, spent)).toBeNull();
		expect(f.calls).toEqual([key('terrain', 12, 8, 8)]);
		await vi.advanceTimersByTimeAsync(100);
		expect(await fetchers.fetchRoutingTile('terrain', 12, 8, 8, spent)).not.toBeNull();
	});

	it('concurrent callers share one request and each get their own copy', async () => {
		const f = fakes({ networkMs: 10 });
		const fetchers = createTileFetchers(f.deps);
		const a = fetchers.fetchRoutingTile('protomaps', 15, 9, 9);
		const b = fetchers.fetchRoutingTile('protomaps', 15, 9, 9);
		await vi.advanceTimersByTimeAsync(10);
		const [ba, bb] = await Promise.all([a, b]);
		expect(f.calls).toEqual([key('protomaps', 15, 9, 9)]);
		structuredClone(ba!, { transfer: [ba!] }); // detach one
		expect(bb!.byteLength).toBe(19);
	});
});
