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

function isDeleted(node: unknown): boolean {
	return Boolean((node as CachedMapNode | null | undefined)?.__deleted);
}

const dbPromise = openDB('FireMarker', 2, {
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
