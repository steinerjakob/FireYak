import { openDB } from 'idb';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { GeoPoint, GeoBounds, distanceTo, boundsContains } from '@/types/geo';
import { OsmRef, toRef } from '@/helper/osmRef';

const markerStoreName = 'fireMarkerRefs';

/**
 * A node as it lives in the IndexedDB cache: the raw Overpass element plus
 * cache-only bookkeeping (`__deleted` soft-delete flag and the `fetchedAt`
 * timestamp added in DB v2), plus the namespaced {@link OsmRef} that has been
 * the store's keyPath since DB v4 (§4.5). The optional fields let it be used
 * anywhere an {@link OverPassElement} is expected while still exposing
 * `fetchedAt`.
 */
export type CachedMapNode = OverPassElement & {
	ref: OsmRef;
	__deleted?: boolean;
	fetchedAt?: number;
};

const offlineAreasStoreName = 'offlineAreas';
const pendingEditsStoreName = 'pendingEdits';

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

const dbPromise = openDB('FireMarker', 4, {
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

export async function storeMapNodes(nodes: OverPassElement[]) {
	try {
		const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');
		const fetchedAt = Date.now();
		await Promise.all([
			...nodes.map(async (node) => {
				const point = getNodePoint(node);
				if (!point) {
					return;
				}

				const ref = toRef(node.type ?? 'node', node.id);
				const existing = (await tx.store.get(ref)) as CachedMapNode | undefined;
				const deletedFlag = existing?.__deleted ?? (node as CachedMapNode).__deleted ?? false;

				const toStore: CachedMapNode = {
					...(node as CachedMapNode),
					ref,
					__deleted: deletedFlag,
					fetchedAt,
					lat: point.lat,
					lon: point.lng
				};
				return tx.store.put(toStore);
			}),
			tx.done
		]);
	} catch (e) {
		console.error(e);
	}
}

export async function getMapNodesForView(mapBounds: GeoBounds) {
	try {
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const markerStore = transaction.objectStore(markerStoreName);

		// Create an index on lat and lon keys
		const index = markerStore.index('lat, lon');

		// Initialize an empty array to store the results
		const results: CachedMapNode[] = [];

		const range = IDBKeyRange.bound(
			[mapBounds.south, mapBounds.west],
			[mapBounds.north, mapBounds.east]
		);

		let cursor = await index.openCursor(range);

		while (cursor) {
			const mapMarker = cursor.value as CachedMapNode;

			if (!isDeleted(mapMarker)) {
				const markerPoint = getNodePoint(mapMarker);

				if (markerPoint && boundsContains(mapBounds, markerPoint)) {
					results.push(mapMarker);
				}
			}

			cursor = await cursor.continue();
		}
		return results;
	} catch (e) {
		console.error(e);
		return [];
	}
}

export async function getNearbyMapNodes(location: GeoPoint, radius: number) {
	try {
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const markerStore = transaction.objectStore(markerStoreName);

		const latDelta = radius / 111000;
		const lngDelta = radius / (111000 * Math.cos((location.lat * Math.PI) / 180));

		const index = markerStore.index('lat, lon');
		const range = IDBKeyRange.bound(
			[location.lat - latDelta, location.lng - lngDelta],
			[location.lat + latDelta, location.lng + lngDelta]
		);

		const results: OverPassElement[] = [];
		let cursor = await index.openCursor(range);

		while (cursor) {
			const mapMarker = cursor.value as CachedMapNode;

			if (!isDeleted(mapMarker)) {
				const markerPoint = getNodePoint(mapMarker);

				if (markerPoint) {
					const distance = distanceTo(location, markerPoint);

					if (distance <= radius) {
						results.push(mapMarker);
					}
				}
			}

			cursor = await cursor.continue();
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
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const markerStore = transaction.objectStore(markerStoreName);
		const index = markerStore.index('lat, lon');

		const range = IDBKeyRange.bound(
			[mapBounds.south, mapBounds.west],
			[mapBounds.north, mapBounds.east]
		);

		const refs: CachedNodeRef[] = [];
		let cursor = await index.openCursor(range);

		while (cursor) {
			const mapMarker = cursor.value as CachedMapNode;
			const markerPoint = getNodePoint(mapMarker);

			if (markerPoint && boundsContains(mapBounds, markerPoint)) {
				refs.push({ ref: mapMarker.ref, fetchedAt: mapMarker.fetchedAt ?? 0 });
			}

			cursor = await cursor.continue();
		}

		return refs;
	} catch (e) {
		console.error('Error getting map node refs for bounds:', e);
		return [];
	}
}

export async function hardDeleteMapNodes(refs: OsmRef[]) {
	if (!refs.length) return;
	try {
		const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');
		await Promise.all([...refs.map((ref) => tx.store.delete(ref)), tx.done]);
	} catch (e) {
		console.error('Error hard-deleting map nodes:', e);
	}
}

/**
 * Deletes cached nodes older than {@link maxAgeMs} to keep the cache from
 * growing unboundedly as the user pans around (§2.2). Nodes are stamped with a
 * `fetchedAt` timestamp on every store; anything older than the cutoff (or
 * without a timestamp) is treated as stale. Iterates the `fetchedAt` index so
 * only stale rows are visited.
 */
export async function pruneStaleMapNodes(maxAgeMs: number) {
	try {
		// Nodes inside a downloaded offline area must never be pruned, even when
		// stale — the whole point of an offline area is that its data survives.
		// Membership is a pure bounds check, so we load the areas once per run.
		const areas = await getAllOfflineAreas();
		const isProtected = (node: CachedMapNode): boolean => {
			if (areas.length === 0) return false;
			const point = getNodePoint(node);
			return point !== null && areas.some((area) => boundsContains(area.bounds, point));
		};

		const cutoff = Date.now() - maxAgeMs;
		const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');
		const index = tx.store.index('fetchedAt');

		// upperBound(cutoff, true) → strictly `fetchedAt < cutoff`.
		let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff, true));
		while (cursor) {
			if (!isProtected(cursor.value as CachedMapNode)) {
				await cursor.delete();
			}
			cursor = await cursor.continue();
		}

		await tx.done;
	} catch (e) {
		console.error('Error pruning stale map nodes:', e);
	}
}

export async function deleteMapNode(ref: OsmRef) {
	try {
		const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');

		// Soft-delete: keep the record in the cache, but mark it as deleted.
		const existing = (await tx.store.get(ref)) as CachedMapNode | undefined;

		if (existing) {
			await tx.store.put({ ...existing, __deleted: true });
		}

		await tx.done;
	} catch (e) {
		console.error(e);
	}
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
