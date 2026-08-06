import { openDB } from 'idb';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { GeoPoint, GeoBounds, distanceTo, boundsContains } from '@/types/geo';
import { OsmRef, toRef } from '@/helper/osmRef';
import { lngLatToTile, tileKey, tileKeysForBounds } from '@/helper/tileMath';

const markerStoreName = 'fireMarkerRefs';

/**
 * Zoom level of the slippy tile each cached node is filed under (DB v5).
 *
 * Every viewport read resolves to "which tiles does this bbox touch?" plus one
 * index lookup per tile, so the zoom trades read count against over-fetch. At
 * z10 a tile is roughly 27 × 19 km at central-European latitudes — about a
 * city — which keeps a typical viewport at a handful of lookups while never
 * pulling in more than a city's worth of rows per lookup.
 *
 * This value is baked into the stored `tile` property, so changing it requires
 * a migration that recomputes every row.
 */
export const CACHE_TILE_ZOOM = 10;

/**
 * A node as it lives in the IndexedDB cache: the raw Overpass element plus
 * cache-only bookkeeping (`__deleted` soft-delete flag and the `fetchedAt`
 * timestamp added in DB v2), plus the namespaced {@link OsmRef} that has been
 * the store's keyPath since DB v4 (§4.5) and the `tile` key added in DB v5.
 * The optional fields let it be used anywhere an {@link OverPassElement} is
 * expected while still exposing `fetchedAt`.
 */
export type CachedMapNode = OverPassElement & {
	ref: OsmRef;
	__deleted?: boolean;
	fetchedAt?: number;
	/** z{@link CACHE_TILE_ZOOM} {@link tileKey} of the node's position. */
	tile?: string;
};

const offlineAreasStoreName = 'offlineAreas';
const pendingEditsStoreName = 'pendingEdits';
const deletedRefsStoreName = 'deletedRefs';

/**
 * A tombstone for a node the user deleted locally (DB v5).
 *
 * Before v5 this lived as a `__deleted` flag on the cached node itself, which
 * meant every single write had to `get` the existing row first just to find out
 * whether it was carrying one — doubling the request count of a 1000-node
 * viewport store. Keeping the refs in their own tiny store lets
 * {@link storeMapNodes} read the whole tombstone set in one request and then
 * issue nothing but `put`s. The flag is still mirrored onto the node so readers
 * (and the reconciliation pass) need not join across two stores.
 */
interface DeletedRefRecord {
	ref: OsmRef;
	deletedAt: number;
}

/**
 * A pre-downloaded offline area: the geographic bounds plus download bookkeeping.
 * The `includeSatellite`/`includeTerrain` flags and the `tileCount`/`sizeBytes`
 * fields are part of the final schema but are only acted on by the later tile
 * package (Part 2); for now they are stored and default to `false`/`0`.
 */
export interface OfflineArea {
	id?: number;
	name: string;
	bounds: GeoBounds;
	createdAt: number;
	lastRefreshedAt: number | null;
	includeSatellite: boolean;
	includeTerrain: boolean;
	/** When set, the area is auto-refreshed on Wi-Fi once it is older than 30 days. */
	autoRefreshOnWifi: boolean;
	nodeCount: number;
	tileCount: number;
	sizeBytes: number;
	status: 'downloading' | 'ready' | 'error' | 'refreshing';
	progress: { done: number; total: number };
	/**
	 * Data-phase resume state. Originally the index of the last successfully
	 * completed Overpass chunk (−1 = none); since §4.6 the data phase is a single
	 * FlatGeobuf read, so the field is repurposed as a tri-state flag — see
	 * {@link DATA_PHASE_DONE} / {@link DATA_PHASE_PENDING}. The field type is
	 * unchanged, so records written by older versions still load; any non-negative
	 * value in one is a legacy chunk index and is treated as "not done".
	 */
	lastCompletedChunk: number;
	/**
	 * Tile-phase resume cursor: per-source count of tiles already processed
	 * (`{ protomaps: n, satellite: n, terrain: n }`). Optional — absent on records
	 * created before the tile package and reset to `{}` on refresh. As a new
	 * optional field it needs no IndexedDB migration.
	 */
	tileResume?: Record<string, number>;
}

/**
 * `lastCompletedChunk` value meaning "the data phase finished for this area".
 *
 * Deliberately **not** `0`: before §4.6 the field held a chunk index, where `0`
 * meant "chunk 0 of N done" — i.e. a *partial* download. Reusing `0` as the done
 * flag would make every legacy record that got at least one chunk in look fully
 * downloaded, so a resumed download would skip the data read and leave the area
 * with a fraction of its water sources. `-2` is outside the legacy value range
 * (`-1` or a chunk index `>= 0`), so it can only ever have been written by a
 * version that means it.
 */
export const DATA_PHASE_DONE = -2;

/** `lastCompletedChunk` value meaning "the data phase still has to run". */
export const DATA_PHASE_PENDING = -1;

/**
 * True when the area's data phase is known to have completed. Legacy chunk
 * indices (`>= 0`) are *not* accepted: they came from a chunked download whose
 * completion cannot be reconstructed, so they fall back to "run the data read
 * again" — a single bbox read that upserts, hence safe to repeat. The record is
 * normalized to {@link DATA_PHASE_DONE}/{@link DATA_PHASE_PENDING} as soon as
 * that run persists its progress.
 */
export function isDataPhaseDone(area: Pick<OfflineArea, 'lastCompletedChunk'>): boolean {
	return area.lastCompletedChunk === DATA_PHASE_DONE;
}

/**
 * A queued OSM edit made while offline. The store is created here (DB v3) so the
 * schema is final, but the queue/sync logic itself lands in a later package.
 */
export interface PendingEdit {
	localId?: number;
	action: 'create' | 'update' | 'delete';
	elementType: 'node';
	/** Negative temp ID for creates (−1, −2, …), real OSM ID otherwise. */
	osmId: number;
	/** Snapshot of the tags at edit time — used for conflict detection. */
	baseTags: Record<string, string> | null;
	tags: Record<string, string>;
	lat: number;
	lon: number;
	createdAt: number;
	status: 'pending' | 'uploading' | 'conflict' | 'error';
	errorMessage?: string;
}

function isDeleted(node: unknown): boolean {
	return Boolean((node as CachedMapNode | null | undefined)?.__deleted);
}

/** Store name used before the DB v4 namespaced-key migration (§4.5). */
const legacyMarkerStoreName = 'fireMarker';

/**
 * Rows read (and rewritten) per batch by the DB v5 backfill. Small enough that
 * an upgrade on a large cache never holds thousands of records in memory,
 * large enough that the writes pipeline instead of paying a round-trip each.
 */
const MIGRATION_CHUNK_SIZE = 1000;

const dbPromise = openDB('FireMarker', 5, {
	async upgrade(db, oldVersion, _newVersion, tx) {
		if (oldVersion < 1) {
			// Fresh install: create the store keyed by the node `id`.
			const store = db.createObjectStore(legacyMarkerStoreName, {
				keyPath: 'id',
				autoIncrement: true
			});
			store.createIndex('lat, lon', ['lat', 'lon']);
		}

		if (oldVersion < 2) {
			const store = tx.objectStore(legacyMarkerStoreName);

			// The `id` index is redundant — `id` is already the keyPath.
			if (store.indexNames.contains('id')) {
				store.deleteIndex('id');
			}
			// Freshness index powering the TTL refresh (§1.4) and pruning (§2.2).
			if (!store.indexNames.contains('fetchedAt')) {
				store.createIndex('fetchedAt', 'fetchedAt');
			}

			// Stamp pre-existing rows with `Date.now()` (not 0): a per-session
			// freshness refresh handles staleness, and stamping 0 here would make
			// the startup prune wipe the user's whole cache right after upgrading.
			const now = Date.now();
			let cursor = await store.openCursor();
			while (cursor) {
				const value = cursor.value as CachedMapNode;
				if (value.fetchedAt === undefined) {
					await cursor.update({ ...value, fetchedAt: now });
				}
				cursor = await cursor.continue();
			}
		}

		if (oldVersion < 3) {
			// Offline data areas (§1.1). `id` autoIncrements.
			db.createObjectStore(offlineAreasStoreName, { keyPath: 'id', autoIncrement: true });
			// Offline edit queue (§1.3) — store created now so the schema is final;
			// the queue logic lands in a later package.
			const edits = db.createObjectStore(pendingEditsStoreName, {
				keyPath: 'localId',
				autoIncrement: true
			});
			edits.createIndex('status', 'status');
		}

		if (oldVersion < 4) {
			// Namespaced marker keys (§4.5): `node/123` and `way/123` are distinct
			// OSM objects that would overwrite each other under the old bare-`id`
			// keyPath. IndexedDB cannot change a store's keyPath in place, so we
			// create a new store keyed by `ref` (`n123` / `w456`), copy every row
			// across, and drop the old store.
			//
			// This MUST be a copy, never a wipe. The old `fireMarker` store also
			// holds the water-source data for downloaded offline areas while
			// `offlineAreas` still reports `status: 'ready'` — wiping it here would
			// leave those areas claiming "ready" with no data behind them, a state
			// the user only discovers once they are offline and it actually matters.
			const newStore = db.createObjectStore(markerStoreName, { keyPath: 'ref' });
			newStore.createIndex('lat, lon', ['lat', 'lon']);
			newStore.createIndex('fetchedAt', 'fetchedAt');

			// Defensive existence check: the `< 1` block above always creates
			// `fireMarker` first (even for a brand-new install starting at
			// `oldVersion === 0`, since every block up to v4 runs in this same
			// upgrade transaction), so this is always true in practice.
			if (tx.objectStoreNames.contains(legacyMarkerStoreName)) {
				const oldStore = tx.objectStore(legacyMarkerStoreName);
				let cursor = await oldStore.openCursor();
				while (cursor) {
					const row = cursor.value as CachedMapNode;
					// Preserve `__deleted` tombstones and `fetchedAt` (the freshness
					// index and the startup prune both depend on it), and keep `id`
					// and `type` on the record — they are the OSM wire identity that
					// `osm-api` and `fetchNodeById` still need.
					await newStore.put({ ...row, ref: toRef(row.type ?? 'node', row.id) });
					cursor = await cursor.continue();
				}
				db.deleteObjectStore(legacyMarkerStoreName);
			}
		}

		if (oldVersion < 5) {
			// Tile-keyed reads (see CACHE_TILE_ZOOM). The `lat, lon` index this
			// replaces is a *compound* index, and `IDBKeyRange.bound([south, west],
			// [north, east])` over one is lexicographic, not a 2D box: it matches
			// every row whose latitude falls in the band, at any longitude on the
			// planet. Reads therefore cost what the whole cache holds at that
			// latitude rather than what the viewport holds — which is why the map
			// got slower the more the user had panned around. A plain `tile` index
			// turns the same query into one exact-match lookup per covered tile.
			//
			// `lat, lon` is deliberately kept: `readNodesForBounds` still falls back
			// to it for bounds too large to enumerate as tiles.
			const store = tx.objectStore(markerStoreName);
			if (!store.indexNames.contains('tile')) {
				store.createIndex('tile', 'tile');
			}

			// Soft-delete tombstones move out of the node rows — see DeletedRefRecord.
			const tombstones = db.objectStoreNames.contains(deletedRefsStoreName)
				? tx.objectStore(deletedRefsStoreName)
				: db.createObjectStore(deletedRefsStoreName, { keyPath: 'ref' });

			// Backfill `tile` on every existing row, and lift its `__deleted` flag
			// into the tombstone store. Walked in primary-key order in bounded
			// batches whose writes are issued together: awaiting each `put` in turn
			// would make an upgrade on a six-figure cache pay one IndexedDB
			// round-trip per row, stalling the first launch after the update.
			const migratedAt = Date.now();
			let lastRef: OsmRef | undefined;
			for (;;) {
				const range = lastRef === undefined ? undefined : IDBKeyRange.lowerBound(lastRef, true);
				const rows = (await store.getAll(range, MIGRATION_CHUNK_SIZE)) as CachedMapNode[];
				if (rows.length === 0) break;

				const writes: Promise<unknown>[] = [];
				for (const row of rows) {
					if (row.__deleted) {
						writes.push(tombstones.put({ ref: row.ref, deletedAt: migratedAt }));
					}
					const point = getNodePoint(row);
					// A row without coordinates was already invisible to every reader
					// (they all resolve a point first), so leaving it untiled changes
					// nothing except that the prune will eventually collect it.
					if (!point) continue;
					writes.push(
						store.put({
							...row,
							tile: tileKey(lngLatToTile(point.lat, point.lng, CACHE_TILE_ZOOM))
						})
					);
				}
				await Promise.all(writes);

				lastRef = rows[rows.length - 1].ref;
				if (rows.length < MIGRATION_CHUNK_SIZE) break;
			}
		}
	}
});

function getNodePoint(node: OverPassElement): GeoPoint | null {
	const lat = node.lat ?? node.center?.lat;
	const lng = node.lon ?? node.center?.lon;

	if (lat === undefined || lng === undefined) {
		return null;
	}

	return { lat, lng };
}

// ---------------------------------------------------------------------------
// In-memory tile cache
//
// IndexedDB is the durable store; this is the read path in front of it. Panning
// around a city re-reads the same handful of tiles over and over, and every one
// of those reads otherwise costs a structured-clone of a few thousand records
// out of the database thread. Holding the decoded rows keeps a small pan
// entirely on the main thread's own heap.
//
// Correctness rests on two things: every mutation below updates or drops the
// affected tiles, and `cacheEpoch` fences reads that were already in flight when
// a mutation landed so they cannot write what they read back into the cache.
// ---------------------------------------------------------------------------

/** Tiles held in memory, in least-recently-used-first order. */
const tileCache = new Map<string, CachedMapNode[]>();

/**
 * Tile budget. A z{@link CACHE_TILE_ZOOM} tile is about a city, so this is
 * generous for a session's worth of panning while bounding worst-case memory.
 */
const MAX_CACHED_TILES = 96;

/**
 * Bumped by every mutation. A read that started before the bump must not
 * populate the cache with the rows it saw, because they predate the write.
 */
let cacheEpoch = 0;

/**
 * Resolves once every write handed to {@link trackWrite} has settled.
 *
 * Marker writes are deliberately not awaited by the code that renders (see
 * `markerHandler`'s `updateNodeCache`), so a read issued moments later could
 * otherwise open its transaction *before* the write opened its own and observe
 * the pre-write state. Readers await this first, which costs nothing in the
 * common case where no write is outstanding.
 */
let pendingWrites: Promise<void> = Promise.resolve();

function trackWrite(work: Promise<unknown>): Promise<void> {
	pendingWrites = Promise.allSettled([pendingWrites, work]).then(() => undefined);
	return pendingWrites;
}

function evictTiles(): void {
	while (tileCache.size > MAX_CACHED_TILES) {
		const oldest = tileCache.keys().next();
		if (oldest.done) break;
		tileCache.delete(oldest.value);
	}
}

/** Drops every cached tile. Used when a mutation's extent isn't worth tracking. */
function clearTileCache(): void {
	cacheEpoch++;
	tileCache.clear();
}

/**
 * Folds freshly stored rows into the tiles that happen to be resident. Rows for
 * tiles that aren't cached are ignored — the next read pulls them from
 * IndexedDB. Refs are removed from every tile first so a node whose position
 * moved across a tile boundary doesn't linger in its old one.
 */
function applyStoredNodesToCache(rows: CachedMapNode[]): void {
	if (rows.length === 0) return;
	const refs = new Set(rows.map((row) => row.ref));
	forgetRefsInCache(refs);
	for (const row of rows) {
		const bucket = row.tile ? tileCache.get(row.tile) : undefined;
		if (bucket) bucket.push(row);
	}
	cacheEpoch++;
}

/** Removes the given refs from every resident tile. */
function forgetRefsInCache(refs: Set<OsmRef>): void {
	for (const [key, rows] of tileCache) {
		const kept = rows.filter((row) => !refs.has(row.ref));
		// Replacing an existing key's value leaves Map iteration order untouched,
		// so mutating while iterating is safe here.
		if (kept.length !== rows.length) tileCache.set(key, kept);
	}
	cacheEpoch++;
}

/** Flags a resident node as soft-deleted without dropping its tile. */
function markDeletedInCache(ref: OsmRef): void {
	for (const [key, rows] of tileCache) {
		const index = rows.findIndex((row) => row.ref === ref);
		if (index === -1) continue;
		const updated = rows.slice();
		updated[index] = { ...updated[index], __deleted: true };
		tileCache.set(key, updated);
	}
	cacheEpoch++;
}

/** One exact-match index lookup per tile, all inside a single transaction. */
async function readTilesFromDb(keys: string[]): Promise<Map<string, CachedMapNode[]>> {
	const tx = (await dbPromise).transaction(markerStoreName, 'readonly');
	const index = tx.store.index('tile');
	const batches = await Promise.all(
		keys.map((key) => index.getAll(key) as Promise<CachedMapNode[]>)
	);
	await tx.done;
	return new Map(keys.map((key, i) => [key, batches[i]]));
}

/** Returns every cached node in the given tiles, reading the missing ones. */
async function getTiles(keys: string[], attempt = 0): Promise<CachedMapNode[]> {
	const missing = keys.filter((key) => !tileCache.has(key));
	let fetched: Map<string, CachedMapNode[]> | null = null;

	if (missing.length > 0) {
		await pendingWrites;
		const epoch = cacheEpoch;
		fetched = await readTilesFromDb(missing);

		if (epoch !== cacheEpoch) {
			// A write landed mid-read. Retrying is cheap (the tiles it touched are
			// the ones we want anyway) but must not spin forever under a steady
			// write load, so fall through and serve what we read after two tries.
			if (attempt < 2) return getTiles(keys, attempt + 1);
		} else {
			for (const [key, rows] of fetched) tileCache.set(key, rows);
			evictTiles();
		}
	}

	const results: CachedMapNode[] = [];
	for (const key of keys) {
		const rows = tileCache.get(key);
		if (rows) {
			// Touch for LRU: re-inserting moves the key to the end of the Map.
			tileCache.delete(key);
			tileCache.set(key, rows);
			results.push(...rows);
			continue;
		}
		const justRead = fetched?.get(key);
		if (justRead) results.push(...justRead);
	}
	return results;
}

/**
 * Upper bound on tiles a single bbox read will enumerate. The map only fetches
 * markers above zoom 9 and clamps its query span, so real viewports stay far
 * below this; the cap exists so an unexpectedly wide bbox degrades to one broad
 * scan instead of thousands of index lookups.
 */
const MAX_TILE_QUERY_KEYS = 128;

/**
 * Every cached node whose tile overlaps `bounds` — a superset of the nodes
 * actually inside it, since tiles overhang the edges. Callers filter.
 */
async function readNodesForBounds(bounds: GeoBounds): Promise<CachedMapNode[]> {
	const keys = tileKeysForBounds(bounds, CACHE_TILE_ZOOM);
	if (keys.length > MAX_TILE_QUERY_KEYS) {
		await pendingWrites;
		const tx = (await dbPromise).transaction(markerStoreName, 'readonly');
		const index = tx.store.index('lat, lon');
		const range = IDBKeyRange.bound([bounds.south, bounds.west], [bounds.north, bounds.east]);
		const rows = (await index.getAll(range)) as CachedMapNode[];
		await tx.done;
		return rows;
	}
	return getTiles(keys);
}

export async function storeMapNodes(nodes: OverPassElement[]) {
	if (nodes.length === 0) return;
	const write = (async () => {
		try {
			const tx = (await dbPromise).transaction(
				[markerStoreName, deletedRefsStoreName],
				'readwrite'
			);
			const markers = tx.objectStore(markerStoreName);

			// One request for the whole tombstone set, rather than a `get` per node
			// just to find out whether this particular one was soft-deleted. Read
			// inside the same transaction as the writes so a concurrent
			// `deleteMapNode` can't slip between the two and be overwritten.
			const tombstones = new Set(
				(await tx.objectStore(deletedRefsStoreName).getAllKeys()) as OsmRef[]
			);

			const fetchedAt = Date.now();
			const stored: CachedMapNode[] = [];
			const writes: Promise<unknown>[] = [];

			for (const node of nodes) {
				const point = getNodePoint(node);
				if (!point) continue;

				const ref = toRef(node.type ?? 'node', node.id);
				const toStore: CachedMapNode = {
					...(node as CachedMapNode),
					ref,
					__deleted: tombstones.has(ref) || Boolean((node as CachedMapNode).__deleted),
					fetchedAt,
					lat: point.lat,
					lon: point.lng,
					tile: tileKey(lngLatToTile(point.lat, point.lng, CACHE_TILE_ZOOM))
				};
				stored.push(toStore);
				writes.push(markers.put(toStore));
			}

			await Promise.all([...writes, tx.done]);
			applyStoredNodesToCache(stored);
		} catch (e) {
			console.error(e);
			// The cache may hold rows this write was meant to replace; drop it
			// rather than serve a half-applied view.
			clearTileCache();
		}
	})();

	await trackWrite(write);
}

export async function getMapNodesForView(mapBounds: GeoBounds): Promise<CachedMapNode[]> {
	try {
		const candidates = await readNodesForBounds(mapBounds);
		return candidates.filter((node) => {
			if (isDeleted(node)) return false;
			const point = getNodePoint(node);
			return point !== null && boundsContains(mapBounds, point);
		});
	} catch (e) {
		console.error(e);
		return [];
	}
}

export async function getNearbyMapNodes(location: GeoPoint, radius: number) {
	try {
		const latDelta = radius / 111000;
		const lngDelta = radius / (111000 * Math.cos((location.lat * Math.PI) / 180));
		const bounds: GeoBounds = {
			south: location.lat - latDelta,
			north: location.lat + latDelta,
			west: location.lng - lngDelta,
			east: location.lng + lngDelta
		};

		const candidates = await readNodesForBounds(bounds);
		const results: OverPassElement[] = [];

		for (const node of candidates) {
			if (isDeleted(node)) continue;
			const point = getNodePoint(node);
			if (point && distanceTo(location, point) <= radius) {
				results.push(node);
			}
		}

		return results;
	} catch (e) {
		console.error('Error getting nearby map nodes:', e);
		return [];
	}
}

export async function getMapNodeById(ref: OsmRef) {
	try {
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const store = transaction.objectStore(markerStoreName);
		const result = (await store.get(ref)) as CachedMapNode | undefined;
		if (!result || isDeleted(result)) return null;
		return result;
	} catch (e) {
		console.error(e);
		return null;
	}
}

/**
 * A cached node's key plus when we last learned about it. `fetchedAt` lets
 * deletion reconciliation tell "the source says this is gone" apart from "the
 * source is simply older than what we know" — see `reconcileDeletedNodes`.
 */
export interface CachedNodeRef {
	ref: OsmRef;
	fetchedAt: number;
}

export async function getMapNodeRefsForBounds(mapBounds: GeoBounds): Promise<CachedNodeRef[]> {
	try {
		const candidates = await readNodesForBounds(mapBounds);
		const refs: CachedNodeRef[] = [];

		for (const node of candidates) {
			// Soft-deleted rows are deliberately included: reconciliation is what
			// eventually collects them once the source agrees they are gone.
			const point = getNodePoint(node);
			if (point && boundsContains(mapBounds, point)) {
				refs.push({ ref: node.ref, fetchedAt: node.fetchedAt ?? 0 });
			}
		}

		return refs;
	} catch (e) {
		console.error('Error getting map node refs for bounds:', e);
		return [];
	}
}

export async function hardDeleteMapNodes(refs: OsmRef[]) {
	if (!refs.length) return;
	const write = (async () => {
		try {
			const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');
			await Promise.all([...refs.map((ref) => tx.store.delete(ref)), tx.done]);
			// Surgical rather than a full clear: this runs after every viewport
			// fetch, and dropping all resident tiles each time would undo the
			// in-memory cache entirely.
			forgetRefsInCache(new Set(refs));
		} catch (e) {
			console.error('Error hard-deleting map nodes:', e);
			clearTileCache();
		}
	})();

	await trackWrite(write);
}

/**
 * Deletes cached nodes older than {@link maxAgeMs} to keep the cache from
 * growing unboundedly as the user pans around (§2.2). Nodes are stamped with a
 * `fetchedAt` timestamp on every store; anything older than the cutoff (or
 * without a timestamp) is treated as stale. Iterates the `fetchedAt` index so
 * only stale rows are visited.
 */
/** Nodes deleted per prune transaction — see {@link pruneStaleMapNodes}. */
const PRUNE_BATCH_SIZE = 500;

export async function pruneStaleMapNodes(maxAgeMs: number) {
	try {
		// Nodes inside a downloaded offline area must never be pruned, even when
		// stale — the whole point of an offline area is that its data survives.
		// Membership is a pure bounds check, so we load the areas once per run.
		const areas = await getAllOfflineAreas();
		const isProtected = (node: CachedMapNode): boolean => {
			const point = getNodePoint(node);
			return point !== null && areas.some((area) => boundsContains(area.bounds, point));
		};

		const cutoff = Date.now() - maxAgeMs;
		const db = await dbPromise;

		// Phase 1 — decide what goes, under a *readonly* transaction. The previous
		// implementation cursor-deleted inside one long readwrite transaction,
		// which holds an exclusive lock on the marker store: every viewport read
		// issued while it ran queued behind it. Since this is kicked off at
		// startup, that lock sat directly in front of the first map render.
		const readTx = db.transaction(markerStoreName, 'readonly');
		const index = readTx.store.index('fetchedAt');
		// upperBound(cutoff, true) → strictly `fetchedAt < cutoff`.
		const range = IDBKeyRange.upperBound(cutoff, true);
		// With no offline areas nothing can be protected, so the coordinates are
		// never needed and the keys alone are far cheaper to materialize.
		const doomed: OsmRef[] =
			areas.length === 0
				? ((await index.getAllKeys(range)) as OsmRef[])
				: ((await index.getAll(range)) as CachedMapNode[])
						.filter((node) => !isProtected(node))
						.map((node) => node.ref);
		await readTx.done;

		if (doomed.length === 0) return;

		// Phase 2 — delete in bounded batches, each its own short transaction, so
		// a read never waits on more than one batch.
		for (let i = 0; i < doomed.length; i += PRUNE_BATCH_SIZE) {
			const batch = doomed.slice(i, i + PRUNE_BATCH_SIZE);
			const tx = db.transaction(markerStoreName, 'readwrite');
			await Promise.all([...batch.map((ref) => tx.store.delete(ref)), tx.done]);
		}

		clearTileCache();
	} catch (e) {
		console.error('Error pruning stale map nodes:', e);
		clearTileCache();
	}
}

export async function deleteMapNode(ref: OsmRef) {
	const write = (async () => {
		try {
			const tx = (await dbPromise).transaction(
				[markerStoreName, deletedRefsStoreName],
				'readwrite'
			);
			const markers = tx.objectStore(markerStoreName);

			// The tombstone is the authoritative record — it is what keeps a later
			// `storeMapNodes` from resurrecting the node when the extract, which is
			// days behind OSM, still lists it. The flag on the row is a mirror so
			// readers don't have to join the two stores.
			const existing = (await markers.get(ref)) as CachedMapNode | undefined;
			const writes: Promise<unknown>[] = [
				tx.objectStore(deletedRefsStoreName).put({ ref, deletedAt: Date.now() } as DeletedRefRecord)
			];
			if (existing) {
				writes.push(markers.put({ ...existing, __deleted: true }));
			}

			await Promise.all([...writes, tx.done]);
			markDeletedInCache(ref);
		} catch (e) {
			console.error(e);
			clearTileCache();
		}
	})();

	await trackWrite(write);
}

// ---------------------------------------------------------------------------
// Offline area CRUD (§1.1)
// ---------------------------------------------------------------------------

/** Returns all stored offline areas (empty array on error). */
export async function getAllOfflineAreas(): Promise<OfflineArea[]> {
	try {
		return (await (await dbPromise).getAll(offlineAreasStoreName)) as OfflineArea[];
	} catch (e) {
		console.error('Error reading offline areas:', e);
		return [];
	}
}

/** Returns a single offline area by id, or `undefined` if it does not exist. */
export async function getOfflineArea(id: number): Promise<OfflineArea | undefined> {
	try {
		return (await (await dbPromise).get(offlineAreasStoreName, id)) as OfflineArea | undefined;
	} catch (e) {
		console.error('Error reading offline area:', e);
		return undefined;
	}
}

/**
 * Deep-copies a record into plain objects. Callers hand in values that may be
 * (or contain) Vue reactive proxies — e.g. bounds coming from a `ref` in the
 * add-area form, or a selected marker's `tags` — and IndexedDB's structured
 * clone throws a `DataCloneError` on proxies. Area and pending-edit records
 * are pure JSON data, so a JSON round-trip is loss-free.
 */
function toPlain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Persists a new offline area and returns its generated id. */
export async function addOfflineArea(area: OfflineArea): Promise<number> {
	const key = await (await dbPromise).add(offlineAreasStoreName, toPlain(area));
	return key as number;
}

/**
 * Merges `patch` into the stored area. No-op if the area no longer exists (it
 * may have been deleted while a download was still running).
 */
export async function updateOfflineArea(id: number, patch: Partial<OfflineArea>): Promise<void> {
	try {
		const db = await dbPromise;
		const existing = (await db.get(offlineAreasStoreName, id)) as OfflineArea | undefined;
		if (!existing) return;
		await db.put(offlineAreasStoreName, toPlain({ ...existing, ...patch, id }));
	} catch (e) {
		console.error('Error updating offline area:', e);
	}
}

/** Removes an offline area record. Cached nodes are left for pruning to reclaim. */
export async function deleteOfflineArea(id: number): Promise<void> {
	try {
		await (await dbPromise).delete(offlineAreasStoreName, id);
	} catch (e) {
		console.error('Error deleting offline area:', e);
	}
}

// ---------------------------------------------------------------------------
// Offline edit queue CRUD (§1.3)
// DB access lives here (repo convention); the queue/sync logic sits in
// `src/offline/editQueue.ts`.
// ---------------------------------------------------------------------------

/** Persists a new queued edit and returns its generated `localId`. */
export async function addPendingEdit(edit: PendingEdit): Promise<number> {
	const key = await (await dbPromise).add(pendingEditsStoreName, toPlain(edit));
	return key as number;
}

/** Returns all queued edits in FIFO order (ascending `localId`). */
export async function getAllPendingEdits(): Promise<PendingEdit[]> {
	try {
		return (await (await dbPromise).getAll(pendingEditsStoreName)) as PendingEdit[];
	} catch (e) {
		console.error('Error reading pending edits:', e);
		return [];
	}
}

/**
 * Returns queued edits with the given status. Because the query is scoped to a
 * single status value, IndexedDB yields the matches in primary-key order, i.e.
 * FIFO by `localId` — the order the sync engine relies on.
 */
export async function getPendingEditsByStatus(
	status: PendingEdit['status']
): Promise<PendingEdit[]> {
	try {
		const db = await dbPromise;
		return (await db.getAllFromIndex(pendingEditsStoreName, 'status', status)) as PendingEdit[];
	} catch (e) {
		console.error('Error reading pending edits by status:', e);
		return [];
	}
}

/** Returns a single queued edit by id, or `undefined` if it no longer exists. */
export async function getPendingEdit(localId: number): Promise<PendingEdit | undefined> {
	try {
		return (await (await dbPromise).get(pendingEditsStoreName, localId)) as PendingEdit | undefined;
	} catch (e) {
		console.error('Error reading pending edit:', e);
		return undefined;
	}
}

/** Merges `patch` into the stored edit. No-op if the edit no longer exists. */
export async function updatePendingEdit(
	localId: number,
	patch: Partial<PendingEdit>
): Promise<void> {
	try {
		const db = await dbPromise;
		const existing = (await db.get(pendingEditsStoreName, localId)) as PendingEdit | undefined;
		if (!existing) return;
		await db.put(pendingEditsStoreName, toPlain({ ...existing, ...patch, localId }));
	} catch (e) {
		console.error('Error updating pending edit:', e);
	}
}

/** Removes a queued edit (e.g. after it has been synced or discarded). */
export async function deletePendingEdit(localId: number): Promise<void> {
	try {
		await (await dbPromise).delete(pendingEditsStoreName, localId);
	} catch (e) {
		console.error('Error deleting pending edit:', e);
	}
}
