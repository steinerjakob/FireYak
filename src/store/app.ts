// Utilities
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { fetchNodeById } from '@/mapHandler/overPassApi';
import { getMapNodeById, storeMapNodes } from '@/mapHandler/databaseHandler';

export const useMapMarkerStore = defineStore('marker', () => {
	// State
	const markers = ref<Map<number, OverPassElement>>(new Map());
	const loadingMarkers = ref<Set<number>>(new Set());
	const fetchPromises = ref<Map<number, Promise<OverPassElement | null>>>(new Map());
	const selectedMarker = ref<OverPassElement | null>(null);

	// Getters
	const getMarkerById = computed(() => {
		return (markerId: number) => {
			return markers.value.get(markerId) || null;
		};
	});

	const isMarkerLoading = computed(() => {
		return (markerId: number) => {
			return loadingMarkers.value.has(markerId);
		};
	});

	// Actions
	async function fetchMarkerById(markerId: number): Promise<OverPassElement | null> {
		// Return cached data if available
		if (markers.value.has(markerId)) {
			return markers.value.get(markerId) || null;
		}

		// Return in-flight promise if already fetching
		if (fetchPromises.value.has(markerId)) {
			return fetchPromises.value.get(markerId) || null;
		}

		// Mark as loading
		loadingMarkers.value.add(markerId);

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
					markers.value.set(markerId, node);
				}

				return node;
			} finally {
				// Cleanup
				loadingMarkers.value.delete(markerId);
				fetchPromises.value.delete(markerId);
			}
		})();

		// Cache the promise
		fetchPromises.value.set(markerId, fetchPromise);

		return fetchPromise;
	}

	async function selectMarker(markerId: number | null) {
		if (markerId) {
			const marker = await fetchMarkerById(markerId);
			if (marker) {
				selectedMarker.value = marker;
			}
		} else {
			selectedMarker.value = null;
		}
	}

	return {
		// State
		markers,
		loadingMarkers,
		fetchPromises,
		selectedMarker,
		// Getters
		getMarkerById,
		isMarkerLoading,
		// Actions
		fetchMarkerById,
		selectMarker
	};
});
