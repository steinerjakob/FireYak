import { untilAborted } from '@/helper/routingBudget';
import { cacheKey } from '@/offline/routingCacheIndex';
import { FetchQueue, PRIORITY } from '@/offline/precachePolicy';

/**
 * The cache-first tile lookups of the main thread (plan §6.9), with their I/O
 * injected so the order and the budget rules are testable without MapLibre,
 * Capacitor or a network. `offlineProtocol.ts` wires the app's stores.
 *
 * Lookup order everywhere: downloaded areas (`tileStore`), then the routing
 * cache, then the network.
 *
 * - {@link TileFetchers.fetchTileCacheFirst} (map browsing): a network result
 *   is written through to the area store only inside a downloaded area, as
 *   before; it never fills the routing cache.
 * - {@link TileFetchers.fetchRoutingTile} (hose routing): network through the
 *   shared {@link FetchQueue} (3 per source, routing first); the result goes
 *   into the routing cache and is reported as arrived. The caller's wait ends
 *   when its budget signal aborts, the fetch does not; with the signal already
 *   aborted only local stores are read (a background fetch is started).
 * - {@link TileFetchers.prefetchTile}: the same network path at a precache
 *   priority, skipped when the tile is already local.
 *
 * Every caller gets its own copy of the bytes: they are transferred to the
 * routing worker or to MapLibre, which detaches them.
 */

export interface TileFetchDeps {
	/** Downloaded offline areas (`tileStore`). */
	areaStore: {
		get(source: string, z: number, x: number, y: number): Promise<Blob | null>;
		has(source: string, z: number, x: number, y: number): Promise<boolean>;
		put(source: string, z: number, x: number, y: number, data: Blob): Promise<void>;
	};
	routingCache: {
		get(source: string, z: number, x: number, y: number): Promise<ArrayBuffer | null>;
		has(source: string, z: number, x: number, y: number): boolean;
		put(source: string, z: number, x: number, y: number, bytes: ArrayBuffer): Promise<void>;
		whenReady(): Promise<void>;
	};
	/** Network fetch; rejects on HTTP errors and aborts. */
	network(
		source: string,
		z: number,
		x: number,
		y: number,
		signal?: AbortSignal
	): Promise<ArrayBuffer>;
	/** Write-through gate of map browsing. */
	insideDownloadedArea(z: number, x: number, y: number): Promise<boolean>;
	isOnline(): boolean;
	/** A routing or prefetch tile landed in the routing cache. */
	onArrived(): void;
	queue?: FetchQueue<ArrayBuffer | null>;
}

export interface TileFetchers {
	fetchTileCacheFirst(
		source: string,
		z: number,
		x: number,
		y: number,
		signal?: AbortSignal
	): Promise<ArrayBuffer | null>;
	fetchRoutingTile(
		source: string,
		z: number,
		x: number,
		y: number,
		signal?: AbortSignal
	): Promise<ArrayBuffer | null>;
	/** Resolves `true` when the tile was fetched, `false` when skipped, dropped or failed. */
	prefetchTile(source: string, z: number, x: number, y: number, priority: number): Promise<boolean>;
	/** The queue (supersede a prefetch batch with `dropQueued`). */
	queue: FetchQueue<ArrayBuffer | null>;
}

const copy = (bytes: ArrayBuffer | null) => (bytes ? bytes.slice(0) : null);

export function createTileFetchers(deps: TileFetchDeps): TileFetchers {
	const queue = deps.queue ?? new FetchQueue<ArrayBuffer | null>();

	async function readLocal(
		source: string,
		z: number,
		x: number,
		y: number
	): Promise<ArrayBuffer | null> {
		const area = await deps.areaStore.get(source, z, x, y);
		if (area) return area.arrayBuffer();
		return deps.routingCache.get(source, z, x, y);
	}

	/** Network → routing cache, deduplicated and queued; `null` on failure. */
	function fetchToCache(
		source: string,
		z: number,
		x: number,
		y: number,
		priority: number
	): Promise<ArrayBuffer | null> {
		return queue.request(cacheKey(source, z, x, y), source, priority, async (signal) => {
			let bytes: ArrayBuffer;
			try {
				bytes = await deps.network(source, z, x, y, signal);
			} catch (e) {
				if (signal.aborted) throw e; // preempted: the queue runs it again
				return null;
			}
			if (bytes.byteLength === 0) return null;
			await deps.routingCache.put(source, z, x, y, bytes);
			deps.onArrived();
			return bytes;
		});
	}

	return {
		queue,

		async fetchTileCacheFirst(source, z, x, y, signal) {
			const local = await readLocal(source, z, x, y);
			if (local) return local;
			try {
				const bytes = await deps.network(source, z, x, y, signal);
				if (await deps.insideDownloadedArea(z, x, y)) {
					await deps.areaStore.put(source, z, x, y, new Blob([bytes.slice(0)]));
				}
				return bytes;
			} catch (err) {
				if (signal?.aborted) throw err;
				// Offline and not cached → no data (the protocol renders a gap).
				return null;
			}
		},

		async fetchRoutingTile(source, z, x, y, signal) {
			const local = await readLocal(source, z, x, y);
			if (local) return local;
			if (!deps.isOnline()) return null;
			const landing = fetchToCache(source, z, x, y, PRIORITY.routing).catch(() => null);
			if (signal?.aborted) {
				// Budget spent: local only; fetch in the background for the recompute.
				return null;
			}
			return copy(await untilAborted(landing, signal, null));
		},

		async prefetchTile(source, z, x, y, priority) {
			await deps.routingCache.whenReady();
			if (deps.routingCache.has(source, z, x, y)) return false;
			if (queue.isPending(cacheKey(source, z, x, y))) {
				// Joins (and may raise) the running request.
				return fetchToCache(source, z, x, y, priority).then(
					(bytes) => bytes !== null,
					() => false
				);
			}
			if (await deps.areaStore.has(source, z, x, y)) return false;
			if (!deps.isOnline()) return false;
			return fetchToCache(source, z, x, y, priority).then(
				(bytes) => bytes !== null,
				() => false
			);
		}
	};
}
