import { openDB } from 'idb';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { GeoPoint, GeoBounds, distanceTo, boundsContains } from '@/types/geo';

const markerStoreName = 'fireMarker';

/**
 * A node as it lives in the IndexedDB cache: the raw Overpass element plus
 * cache-only bookkeeping (`__deleted` soft-delete flag and the `fetchedAt`
 * timestamp added in DB v2). The optional fields let it be used anywhere an
 * {@link OverPassElement} is expected while still exposing `fetchedAt`.
 */
export type CachedMapNode = OverPassElement & { __deleted?: boolean; fetchedAt?: number };

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
	/** Resume info: index of the last successfully completed data chunk (−1 = none). */
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

const dbPromise = openDB('FireMarker', 3, {
	async upgrade(db, oldVersion, _newVersion, tx) {
		if (oldVersion < 1) {
			// Fresh install: create the store keyed by the node `id`.
			const store = db.createObjectStore(markerStoreName, {
				keyPath: 'id',
				autoIncrement: true
			});
			store.createIndex('lat, lon', ['lat', 'lon']);
		}

		if (oldVersion < 2) {
			const store = tx.objectStore(markerStoreName);

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

				const existing = (await tx.store.get(node.id)) as CachedMapNode | undefined;
				const deletedFlag = existing?.__deleted ?? (node as CachedMapNode).__deleted ?? false;

				const toStore: CachedMapNode = {
					...(node as CachedMapNode),
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

export async function getMapNodeById(id: number) {
	try {
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const store = transaction.objectStore(markerStoreName);
		const result = (await store.get(id)) as CachedMapNode | undefined;
		if (!result || isDeleted(result)) return null;
		return result;
	} catch (e) {
		console.error(e);
		return null;
	}
}

export async function getMapNodeIdsForBounds(mapBounds: GeoBounds): Promise<number[]> {
	try {
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const markerStore = transaction.objectStore(markerStoreName);
		const index = markerStore.index('lat, lon');

		const range = IDBKeyRange.bound(
			[mapBounds.south, mapBounds.west],
			[mapBounds.north, mapBounds.east]
		);

		const ids: number[] = [];
		let cursor = await index.openCursor(range);

		while (cursor) {
			const mapMarker = cursor.value as CachedMapNode;
			const markerPoint = getNodePoint(mapMarker);

			if (markerPoint && boundsContains(mapBounds, markerPoint)) {
				ids.push(mapMarker.id);
			}

			cursor = await cursor.continue();
		}

		return ids;
	} catch (e) {
		console.error('Error getting map node IDs for bounds:', e);
		return [];
	}
}

export async function hardDeleteMapNodes(ids: number[]) {
	if (!ids.length) return;
	try {
		const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');
		await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
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

export async function deleteMapNode(id: number) {
	try {
		const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');

		// Soft-delete: keep the record in the cache, but mark it as deleted.
		const existing = (await tx.store.get(id)) as CachedMapNode | undefined;

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

/** Persists a new offline area and returns its generated id. */
export async function addOfflineArea(area: OfflineArea): Promise<number> {
	const key = await (await dbPromise).add(offlineAreasStoreName, area);
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
		await db.put(offlineAreasStoreName, { ...existing, ...patch, id });
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
	const key = await (await dbPromise).add(pendingEditsStoreName, edit);
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
		await db.put(pendingEditsStoreName, { ...existing, ...patch, localId });
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
