import { describe, expect, it } from 'vitest';
import { distanceTo } from '@/types/geo';
import {
	FetchQueue,
	MAX_CONCURRENT_PER_SOURCE,
	PRIORITY,
	QueueDroppedError,
	boundsAround,
	clipToRadius,
	mapMovePrefetchDue,
	prefetchAllowed,
	ringNeedsRefresh,
	routingTilesForBounds,
	type PrefetchNetwork
} from '@/offline/precachePolicy';

const wifi: PrefetchNetwork = { online: true, saveData: false, connection: 'wifi' };

/** A point `m` metres north of `p`. */
const north = (p: { lat: number; lng: number }, m: number) => ({
	lat: p.lat + m / 111_195,
	lng: p.lng
});

describe('GPS ring', () => {
	const centre = { lat: 47.27, lng: 11.39 };

	it('refreshes after 500 m of movement, not 499 m', () => {
		expect(ringNeedsRefresh(null, centre)).toBe(true);
		const at499 = north(centre, 499);
		const at500 = north(centre, 500.5);
		expect(distanceTo(centre, at499)).toBeLessThan(500);
		expect(distanceTo(centre, at500)).toBeGreaterThanOrEqual(500);
		expect(ringNeedsRefresh(centre, at499)).toBe(false);
		expect(ringNeedsRefresh(centre, at500)).toBe(true);
	});

	it('covers basemap z15 and DEM z14 + z12 over the 2 km ring', () => {
		const tiles = routingTilesForBounds(boundsAround(centre, 2000));
		const count = (source: string, z: number) =>
			tiles.filter((t) => t.source === source && t.z === z).length;
		expect(count('protomaps', 15)).toBeGreaterThanOrEqual(25);
		expect(count('terrain', 14)).toBeGreaterThanOrEqual(4);
		expect(count('terrain', 12)).toBeGreaterThanOrEqual(1);
		expect(count('terrain', 13)).toBe(0);
	});
});

describe('trigger gating', () => {
	it('priority 3 (map move) needs zoom >= 14, 1.5 s idle and the marker fetch', () => {
		expect(mapMovePrefetchDue({ zoom: 14, idleMs: 1500, markersFetched: true })).toBe(true);
		expect(mapMovePrefetchDue({ zoom: 13.9, idleMs: 1500, markersFetched: true })).toBe(false);
		expect(mapMovePrefetchDue({ zoom: 15, idleMs: 1499, markersFetched: true })).toBe(false);
		expect(mapMovePrefetchDue({ zoom: 15, idleMs: 5000, markersFetched: false })).toBe(false);
	});

	it('priority 3 runs on Wi-Fi only; unknown (web without connection info) counts as not Wi-Fi', () => {
		expect(prefetchAllowed(PRIORITY.mapMove, wifi)).toBe(true);
		expect(prefetchAllowed(PRIORITY.mapMove, { ...wifi, connection: 'cellular' })).toBe(false);
		expect(prefetchAllowed(PRIORITY.mapMove, { ...wifi, connection: 'unknown' })).toBe(false);
	});

	it('the selection and the GPS ring also run on cellular and unknown connections', () => {
		for (const connection of ['cellular', 'unknown'] as const) {
			expect(prefetchAllowed(PRIORITY.selection, { ...wifi, connection })).toBe(true);
			expect(prefetchAllowed(PRIORITY.gpsRing, { ...wifi, connection })).toBe(true);
		}
	});

	it('nothing is fetched offline or with saveData', () => {
		for (const priority of [PRIORITY.selection, PRIORITY.gpsRing, PRIORITY.mapMove]) {
			expect(prefetchAllowed(priority, { ...wifi, online: false })).toBe(false);
			expect(prefetchAllowed(priority, { ...wifi, connection: 'none' })).toBe(false);
			expect(prefetchAllowed(priority, { ...wifi, saveData: true })).toBe(false);
		}
	});

	it('a zoomed-out view is clipped to 1.5 km around its centre', () => {
		const view = boundsAround({ lat: 48, lng: 15 }, 5000);
		const clipped = clipToRadius(view);
		const half = distanceTo(
			{ lat: 48, lng: clipped.west },
			{ lat: 48, lng: (clipped.west + clipped.east) / 2 }
		);
		expect(half).toBeGreaterThan(1450);
		expect(half).toBeLessThan(1550);
	});
});

/** A job runner whose requests the test resolves by hand. */
function manualRunner() {
	const started: string[] = [];
	const aborted: string[] = [];
	const resolvers = new Map<string, (v: string) => void>();
	const run = (key: string) => (signal: AbortSignal) =>
		new Promise<string>((resolve, reject) => {
			started.push(key);
			resolvers.set(key, resolve);
			signal.addEventListener('abort', () => {
				aborted.push(key);
				reject(new DOMException('aborted', 'AbortError'));
			});
		});
	const finish = async (key: string) => {
		resolvers.get(key)?.(`bytes ${key}`);
		await Promise.resolve();
		await Promise.resolve();
	};
	return { started, aborted, run, finish };
}

describe('fetch queue', () => {
	it('runs at most 3 requests per source; other sources have their own slots', async () => {
		const queue = new FetchQueue<string>();
		const r = manualRunner();
		for (let i = 0; i < 5; i++) void queue.request(`b${i}`, 'protomaps', 2, r.run(`b${i}`));
		void queue.request('d0', 'terrain', 2, r.run('d0'));
		expect(MAX_CONCURRENT_PER_SOURCE).toBe(3);
		expect(queue.runningCount('protomaps')).toBe(3);
		expect(queue.runningCount('terrain')).toBe(1);
		expect(r.started).toEqual(['b0', 'b1', 'b2', 'd0']);
		await r.finish('b0');
		expect(r.started).toContain('b3');
		expect(queue.runningCount('protomaps')).toBe(3);
	});

	it('the most urgent queued job starts first', async () => {
		const queue = new FetchQueue<string>(1);
		const r = manualRunner();
		void queue.request('ring', 'protomaps', PRIORITY.gpsRing, r.run('ring'));
		void queue.request('view', 'protomaps', PRIORITY.mapMove, r.run('view'));
		void queue.request('sel', 'protomaps', PRIORITY.selection, r.run('sel'));
		await r.finish('ring');
		expect(r.started).toEqual(['ring', 'sel']);
	});

	it('routing aborts a lower-priority running prefetch, which runs again afterwards', async () => {
		const queue = new FetchQueue<string>(1);
		const r = manualRunner();
		const ring = queue.request('ring', 'protomaps', PRIORITY.gpsRing, r.run('ring'));
		const routing = queue.request('route', 'protomaps', PRIORITY.routing, r.run('route'));
		expect(r.aborted).toEqual(['ring']);
		expect(r.started).toEqual(['ring', 'route']);
		await r.finish('route');
		await expect(routing).resolves.toBe('bytes route');
		expect(r.started).toEqual(['ring', 'route', 'ring']);
		await r.finish('ring');
		await expect(ring).resolves.toBe('bytes ring');
	});

	it('a request for a pending key joins it and raises its priority', async () => {
		const queue = new FetchQueue<string>(1);
		const r = manualRunner();
		void queue.request('busy', 'terrain', PRIORITY.selection, r.run('busy'));
		const prefetch = queue.request('tile', 'terrain', PRIORITY.mapMove, r.run('tile'));
		void queue.request('other', 'terrain', PRIORITY.gpsRing, r.run('other'));
		const routing = queue.request('tile', 'terrain', PRIORITY.routing, r.run('never'));
		// The routing request preempted the running selection job.
		expect(r.started).toEqual(['busy', 'tile']);
		await r.finish('tile');
		await expect(prefetch).resolves.toBe('bytes tile');
		await expect(routing).resolves.toBe('bytes tile');
		expect(r.started).not.toContain('never');
	});

	it('a new batch drops the queued jobs of the same priority only', async () => {
		const queue = new FetchQueue<string>(1);
		const r = manualRunner();
		void queue.request('a', 'protomaps', PRIORITY.gpsRing, r.run('a'));
		const old = queue.request('b', 'protomaps', PRIORITY.gpsRing, r.run('b'));
		void queue.request('c', 'protomaps', PRIORITY.mapMove, r.run('c'));
		expect(queue.dropQueued(PRIORITY.gpsRing)).toBe(1);
		await expect(old).rejects.toBeInstanceOf(QueueDroppedError);
		expect(queue.queuedCount()).toBe(1);
	});
});
