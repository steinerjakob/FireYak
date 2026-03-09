import { openDB } from 'idb';
import { OverPassElement } from '@/mapHandler/overPassApi';
import L, { LatLng, LatLngBounds } from 'leaflet';

const markerStoreName = 'fireMarker';

type CachedMapNode = OverPassElement & { __deleted?: boolean };

function isDeleted(node: unknown): boolean {
	return Boolean((node as CachedMapNode | null | undefined)?.__deleted);
}

const dbPromise = openDB('FireMarker', 1, {
	upgrade(db) {
		// Create a store of objects
		const store = db.createObjectStore(markerStoreName, {
			// The 'id' property of the object will be the key.
			keyPath: 'id',
			// If it isn't explicitly set, create a value by auto incrementing.
			autoIncrement: true
		});
		// Create an index on the 'date' property of the objects.
		store.createIndex('id', 'id');
		store.createIndex('lat, lon', ['lat', 'lon']);
	}
});

export async function storeMapNodes(nodes: OverPassElement[]) {
	try {
		const tx = (await dbPromise).transaction(markerStoreName, 'readwrite');
		await Promise.all([
			...nodes.map(async (node) => {
				// Keep an existing soft-delete flag even when re-storing/updating the node.
				const existing = (await tx.store.get(node.id)) as CachedMapNode | undefined;
				const deletedFlag = existing?.__deleted ?? (node as CachedMapNode).__deleted ?? false;

				const toStore: CachedMapNode = { ...(node as CachedMapNode), __deleted: deletedFlag };
				return tx.store.put(toStore);
			}),
			tx.done
		]);
	} catch (e) {
		console.error(e);
	}
}

export async function getMapNodesForView(mapBounds: LatLngBounds) {
	try {
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const markerStore = transaction.objectStore(markerStoreName);

		// Create an index on lat and lon keys
		const index = markerStore.index('lat, lon'); // Replace 'latLonIndex' with the actual index name

		// Initialize an empty array to store the results
		const results: OverPassElement[] = [];

		// Iterate over the indexed items within the LatLngBounds
		const range = IDBKeyRange.bound(
			[mapBounds.getSouthWest().lat, mapBounds.getSouthWest().lng],
			[mapBounds.getNorthEast().lat, mapBounds.getNorthEast().lng]
		);

		// todo range is not correct?
		let cursor = await index.openCursor(range);

		while (cursor) {
			// Retrieve the map marker object from the cursor
			const mapMarker = cursor.value as CachedMapNode;

			if (!isDeleted(mapMarker)) {
				const markerLatLng = new L.LatLng(
					mapMarker.lat || mapMarker.center?.lat || 0,
					mapMarker.lon || mapMarker.center?.lon || 0
				);

				// somehow the filter returns more markers than in the range specified?
				if (mapBounds.contains(markerLatLng)) {
					// Add the map marker to the results array
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

export async function getNearbyMapNodes(location: LatLng, radius: number) {
	try {
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const markerStore = transaction.objectStore(markerStoreName);

		// Calculate approximate bounding box to reduce the search space
		// This is a rough approximation: 1 degree ≈ 111km at equator
		const latDelta = radius / 111000; // Convert meters to degrees (approximate)
		const lngDelta = radius / (111000 * Math.cos((location.lat * Math.PI) / 180));

		const southWest = L.latLng(location.lat - latDelta, location.lng - lngDelta);
		const northEast = L.latLng(location.lat + latDelta, location.lng + lngDelta);

		// Use the existing index for initial filtering
		const index = markerStore.index('lat, lon');
		const range = IDBKeyRange.bound([southWest.lat, southWest.lng], [northEast.lat, northEast.lng]);

		const results: OverPassElement[] = [];
		let cursor = await index.openCursor(range);

		while (cursor) {
			const mapMarker = cursor.value as CachedMapNode;

			if (!isDeleted(mapMarker)) {
				// Get the marker's coordinates
				const markerLatLng = new L.LatLng(
					mapMarker.lat || mapMarker.center?.lat || 0,
					mapMarker.lon || mapMarker.center?.lon || 0
				);

				// Calculate precise distance and check if within radius
				const distance = location.distanceTo(markerLatLng);

				if (distance <= radius) {
					results.push(mapMarker);
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

export async function getMapNodeIdsForBounds(mapBounds: LatLngBounds): Promise<number[]> {
	try {
		const transaction = (await dbPromise).transaction(markerStoreName, 'readonly');
		const markerStore = transaction.objectStore(markerStoreName);
		const index = markerStore.index('lat, lon');

		const range = IDBKeyRange.bound(
			[mapBounds.getSouthWest().lat, mapBounds.getSouthWest().lng],
			[mapBounds.getNorthEast().lat, mapBounds.getNorthEast().lng]
		);

		const ids: number[] = [];
		let cursor = await index.openCursor(range);

		while (cursor) {
			const mapMarker = cursor.value as CachedMapNode;
			const markerLatLng = new L.LatLng(
				mapMarker.lat || mapMarker.center?.lat || 0,
				mapMarker.lon || mapMarker.center?.lon || 0
			);

			if (mapBounds.contains(markerLatLng)) {
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
