// Utilities
import { defineStore } from 'pinia';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { fetchNodeById } from '@/mapHandler/overPassApi';
import { getMapNodeById, storeMapNodes } from '@/mapHandler/databaseHandler';

interface MarkerState {
	markers: Map<number, OverPassElement>;
	loadingMarkers: Set<number>;
	fetchPromises: Map<number, Promise<OverPassElement | null>>;
}

export const useMapMarkerStore = defineStore('marker', {
	state: (): MarkerState => ({
		markers: new Map(),
		loadingMarkers: new Set(),
		fetchPromises: new Map()
	}),

	getters: {
		getMarkerById: (state) => (markerId: number) => {
			return state.markers.get(markerId) || null;
		},

		isMarkerLoading: (state) => (markerId: number) => {
			return state.loadingMarkers.has(markerId);
		}
	},

	actions: {
		async fetchMarkerById(markerId: number): Promise<OverPassElement | null> {
			// Return cached data if available
			if (this.markers.has(markerId)) {
				return this.markers.get(markerId)!;
			}

			// Return in-flight promise if already fetching
			if (this.fetchPromises.has(markerId)) {
				return this.fetchPromises.get(markerId)!;
			}

			// Mark as loading
			this.loadingMarkers.add(markerId);

			// Create fetch promise
			const fetchPromise = (async () => {
				try {
					// Try database first
					let node = await getMapNodeById(markerId);

					// If not in database, fetch from API
					if (!node) {
						node = await fetchNodeById(markerId);
						// Store in database for future use
						if (node) {
							await storeMapNodes([node]);
						}
					}

					// Store in state if found
					if (node) {
						this.markers.set(markerId, node);
					}

					return node;
				} finally {
					// Cleanup
					this.loadingMarkers.delete(markerId);
					this.fetchPromises.delete(markerId);
				}
			})();

			// Cache the promise
			this.fetchPromises.set(markerId, fetchPromise);

			return fetchPromise;
		},

		clearMarkerCache() {
			this.markers.clear();
		},

		removeMarker(markerId: number) {
			this.markers.delete(markerId);
		}
	}
});
