import { openDB, type IDBPDatabase } from 'idb';
import {
	DEFAULT_ROUTING_CACHE_MB,
	MB,
	RoutingCacheIndex,
	cacheKey,
	type CacheEntryMeta
} from '@/offline/routingCacheIndex';

/**
 * The routing cache (plan §6.9): CDN tiles (basemap z15, terrain DEM) that
 * hose routing and the background precache fetched, kept in their own
 * IndexedDB database `FireRoutingCache`, separate from downloaded offline
 * areas (`tileStore.ts`), under a byte budget with LRU eviction and a TTL per
 * source (`routingCacheIndex.ts`). The metadata of every entry is kept in
 * memory, so "is it cached?" costs no database read and the map's tile
 * requests can ask here on every miss of the area store.
 *
 * Bytes are stored as `ArrayBuffer` copies: callers transfer the buffers they
 * get to the routing worker or to MapLibre, which detaches them.
 */

const DB_NAME = 'FireRoutingCache';
const META_STORE = 'meta';
const BYTES_STORE = 'bytes';

/** A last-use time is written back only when it moved by more than this (fewer writes). */
const TOUCH_WRITE_MS = 10 * 60 * 1000;

export class RoutingCacheStore {
	private readonly index: RoutingCacheIndex;
	private db: Promise<IDBPDatabase> | null = null;
	private ready: Promise<void> | null = null;
	/** Last-use times as stored, to throttle the write-back. */
	private readonly storedUse = new Map<string, number>();

	constructor(
		private readonly dbName = DB_NAME,
		budgetBytes = DEFAULT_ROUTING_CACHE_MB * MB,
		private readonly now: () => number = Date.now
	) {
		this.index = new RoutingCacheIndex(budgetBytes);
	}

	private open(): Promise<IDBPDatabase> {
		this.db ??= openDB(this.dbName, 1, {
			upgrade(db) {
				db.createObjectStore(META_STORE);
				db.createObjectStore(BYTES_STORE);
			}
		});
		return this.db;
	}

	/** Loads the metadata once and drops what expired or exceeds the budget. */
	private init(): Promise<void> {
		this.ready ??= (async () => {
			const db = await this.open();
			const metas = (await db.getAll(META_STORE)) as CacheEntryMeta[];
			this.index.load(metas);
			for (const meta of metas) this.storedUse.set(meta.key, meta.lastUsedAt);
			await this.deleteKeys(this.index.evict(this.now()));
		})().catch((e) => {
			// No IndexedDB (private mode, quota): the cache stays empty.
			console.warn('Routing cache unavailable:', e);
		});
		return this.ready;
	}

	private async deleteKeys(keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		const db = await this.open();
		const tx = db.transaction([META_STORE, BYTES_STORE], 'readwrite');
		for (const key of keys) {
			this.storedUse.delete(key);
			void tx.objectStore(META_STORE).delete(key);
			void tx.objectStore(BYTES_STORE).delete(key);
		}
		await tx.done;
	}

	/** Waits for the metadata (callers that need {@link has} answered). */
	whenReady(): Promise<void> {
		return this.init();
	}

	/** True when the tile is cached and not expired (in memory; false before {@link whenReady}). */
	has(source: string, z: number, x: number, y: number): boolean {
		return this.index.has(cacheKey(source, z, x, y), this.now());
	}

	/** The cached bytes (a fresh copy), or `null`. Marks the tile as used. */
	async get(source: string, z: number, x: number, y: number): Promise<ArrayBuffer | null> {
		await this.init();
		const key = cacheKey(source, z, x, y);
		const now = this.now();
		if (!this.index.get(key, now)) {
			// Expired (or unknown): drop it now rather than at the next eviction.
			if (this.index.contains(key)) {
				this.index.remove(key);
				await this.deleteKeys([key]).catch(() => undefined);
			}
			return null;
		}
		try {
			const db = await this.open();
			const bytes = (await db.get(BYTES_STORE, key)) as ArrayBuffer | undefined;
			if (!bytes) {
				this.index.remove(key);
				return null;
			}
			const meta = this.index.touch(key, now);
			if (meta && now - (this.storedUse.get(key) ?? 0) > TOUCH_WRITE_MS) {
				this.storedUse.set(key, now);
				void db.put(META_STORE, { ...meta }, key).catch(() => undefined);
			}
			return bytes;
		} catch (e) {
			console.warn('Routing cache read failed:', e);
			return null;
		}
	}

	/**
	 * Stores a tile (a copy is taken at once, so the caller may transfer
	 * `bytes` right after) and evicts what no longer fits.
	 */
	put(source: string, z: number, x: number, y: number, bytes: ArrayBuffer): Promise<void> {
		const copy = bytes.slice(0);
		return this.store(source, cacheKey(source, z, x, y), copy);
	}

	private async store(source: string, key: string, bytes: ArrayBuffer): Promise<void> {
		await this.init();
		const now = this.now();
		const meta: CacheEntryMeta = {
			key,
			source,
			size: bytes.byteLength,
			fetchedAt: now,
			lastUsedAt: now
		};
		const evicted = this.index.add(meta, now).filter((k) => k !== key);
		const stored = this.index.has(key, now);
		try {
			const db = await this.open();
			const tx = db.transaction([META_STORE, BYTES_STORE], 'readwrite');
			if (stored) {
				void tx.objectStore(META_STORE).put(meta, key);
				void tx.objectStore(BYTES_STORE).put(bytes, key);
				this.storedUse.set(key, now);
			}
			for (const k of evicted) {
				this.storedUse.delete(k);
				void tx.objectStore(META_STORE).delete(k);
				void tx.objectStore(BYTES_STORE).delete(k);
			}
			await tx.done;
		} catch (e) {
			// Quota or a closed database: forget the entry so reads do not miss.
			this.index.remove(key);
			console.warn('Routing cache write failed:', e);
		}
	}

	/** Changes the byte budget and evicts down to it. */
	async setBudget(bytes: number): Promise<void> {
		await this.init();
		await this.deleteKeys(this.index.setBudget(bytes, this.now()));
	}

	/** Bytes held (after {@link whenReady}). */
	sizeBytes(): number {
		return this.index.totalBytes;
	}

	/** Number of tiles held (after {@link whenReady}). */
	tileCount(): number {
		return this.index.size;
	}

	/** Empties the cache. */
	async clear(): Promise<void> {
		await this.init();
		await this.deleteKeys(this.index.keys());
		this.index.load([]);
	}
}

/** The app's routing cache. */
export const routingCache = new RoutingCacheStore();
