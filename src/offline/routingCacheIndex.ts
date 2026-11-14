/**
 * Bookkeeping of the routing cache (plan §6.9): which tiles it holds, how many
 * bytes they take, when each expires and which goes first when the byte budget
 * is exceeded. Pure: no I/O and no clock (callers pass `now`), so the
 * eviction rules are testable on their own; `routingCache.ts` keeps one index
 * in memory next to the IndexedDB store.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MB = 1024 * 1024;

/** Default byte budget of the routing cache (user setting `routingCacheMb`). */
export const DEFAULT_ROUTING_CACHE_MB = 50;

/** Budgets offered in the settings, in MB. */
export const ROUTING_CACHE_MB_CHOICES = [25, 50, 100, 200] as const;

/**
 * Time to live per tile source: basemap tiles change with OSM edits (30
 * days), the terrain model hardly ever (180 days).
 */
export const ROUTING_CACHE_TTL_MS: Record<string, number> = {
	protomaps: 30 * DAY_MS,
	terrain: 180 * DAY_MS
};

/** TTL of a source without its own entry. */
const DEFAULT_TTL_MS = 30 * DAY_MS;

/** What the index knows about one cached tile (the bytes live elsewhere). */
export interface CacheEntryMeta {
	/** `source/z/x/y`. */
	key: string;
	source: string;
	/** Bytes of the tile. */
	size: number;
	/** When the bytes came from the network (TTL). */
	fetchedAt: number;
	/** Last read or write (LRU). */
	lastUsedAt: number;
}

export function cacheKey(source: string, z: number, x: number, y: number): string {
	return `${source}/${z}/${x}/${y}`;
}

export function ttlFor(source: string): number {
	return ROUTING_CACHE_TTL_MS[source] ?? DEFAULT_TTL_MS;
}

/** True once the entry is older than its source's TTL. */
export function isExpired(
	meta: Pick<CacheEntryMeta, 'source' | 'fetchedAt'>,
	now: number
): boolean {
	return now - meta.fetchedAt > ttlFor(meta.source);
}

/** Clamps a settings value to a usable budget in bytes (≥ 1 MB). */
export function budgetBytesFromMb(mb: number): number {
	const value = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_ROUTING_CACHE_MB;
	return Math.max(1, Math.round(value)) * MB;
}

/**
 * LRU index with a byte budget. Entries are kept least recently used first
 * (a `Map` in insertion order; a touch moves the entry to the end). Every
 * mutation returns the keys the caller must delete from the store.
 */
export class RoutingCacheIndex {
	private readonly entries = new Map<string, CacheEntryMeta>();
	private total = 0;

	constructor(private budget: number) {}

	get totalBytes(): number {
		return this.total;
	}

	get budgetBytes(): number {
		return this.budget;
	}

	get size(): number {
		return this.entries.size;
	}

	/** Keys from least to most recently used (specs, diagnostics). */
	keys(): string[] {
		return [...this.entries.keys()];
	}

	/** Replaces the contents with stored metadata, ordered by last use. */
	load(metas: CacheEntryMeta[]): void {
		this.entries.clear();
		this.total = 0;
		for (const meta of [...metas].sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
			this.entries.set(meta.key, { ...meta });
			this.total += meta.size;
		}
	}

	/** The entry when present and not expired. */
	get(key: string, now: number): CacheEntryMeta | undefined {
		const meta = this.entries.get(key);
		return meta && !isExpired(meta, now) ? meta : undefined;
	}

	/** True when the key is present, expired or not. */
	contains(key: string): boolean {
		return this.entries.has(key);
	}

	/** True when the key is present and not expired. */
	has(key: string, now: number): boolean {
		return this.get(key, now) !== undefined;
	}

	/** Marks the entry as just used. */
	touch(key: string, now: number): CacheEntryMeta | undefined {
		const meta = this.entries.get(key);
		if (!meta) return undefined;
		this.entries.delete(key);
		meta.lastUsedAt = now;
		this.entries.set(key, meta);
		return meta;
	}

	/** Adds (or replaces) an entry as most recently used; returns the evicted keys. */
	add(meta: CacheEntryMeta, now: number): string[] {
		this.remove(meta.key);
		this.entries.set(meta.key, { ...meta, lastUsedAt: now });
		this.total += meta.size;
		return this.evict(now);
	}

	/** Forgets an entry (the caller deletes the bytes). */
	remove(key: string): void {
		const meta = this.entries.get(key);
		if (!meta) return;
		this.entries.delete(key);
		this.total -= meta.size;
	}

	/** Changes the budget; returns the keys evicted to fit it. */
	setBudget(bytes: number, now: number): string[] {
		this.budget = bytes;
		return this.evict(now);
	}

	/**
	 * Drops expired entries, then the least recently used until the total is
	 * within the budget. Returns the dropped keys.
	 */
	evict(now: number): string[] {
		const evicted: string[] = [];
		for (const meta of [...this.entries.values()]) {
			if (isExpired(meta, now)) {
				this.remove(meta.key);
				evicted.push(meta.key);
			}
		}
		for (const key of this.entries.keys()) {
			if (this.total <= this.budget) break;
			this.remove(key);
			evicted.push(key);
		}
		return evicted;
	}
}
