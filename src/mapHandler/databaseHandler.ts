import { openDB } from 'idb';
import { OverPassElement } from '@/mapHandler/overPassApi';

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
