import { openDB } from 'idb';
import { OverPassElement } from '@/mapHandler/overPassApi';
import L, { LatLngBounds } from 'leaflet';

const markerStoreName = 'fireMarker';

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
			...nodes.map((node) => {
				return tx.store.put(node);
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
			const mapMarker = cursor.value as OverPassElement;

			const markerLatLng = new L.LatLng(
				mapMarker.lat || mapMarker.center?.lat || 0,
				mapMarker.lon || mapMarker.center?.lon || 0
			);

			// somehow the filter returns more markers than in the range specified?
			if (mapBounds.contains(markerLatLng)) {
				// Add the map marker to the results array
				results.push(mapMarker);
			}

			cursor = await cursor.continue();
		}
		return results;
	} catch (e) {
		console.error(e);
		return [];
	}
}
