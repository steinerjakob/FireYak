// Utilities
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { fetchNodeById } from '@/mapHandler/overPassApi';
import { CachedMapNode, getMapNodeById, storeMapNodes } from '@/mapHandler/databaseHandler';
import { fetchMediaWikiFiles, ImageInfo } from '@/mapHandler/markerImageHandler';
import { useNetworkStatus } from '@/composable/networkStatus';

export const useMapMarkerStore = defineStore('marker', () => {
	// State
	const fetchPromises = ref<Map<number, Promise<CachedMapNode | null>>>(new Map());
	const selectedMarker = ref<CachedMapNode | null>(null);
	const selectedMarkerImages = ref<ImageInfo[]>([]);

	// Actions
	async function fetchMarkerById(markerId: number): Promise<CachedMapNode | null> {
		// Return in-flight promise if already fetching
		if (fetchPromises.value.has(markerId)) {
			return fetchPromises.value.get(markerId) || null;
		}

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

				return node;
			} finally {
				// Cleanup
				fetchPromises.value.delete(markerId);
			}
		})();

		// Cache the promise
		fetchPromises.value.set(markerId, fetchPromise);

		return fetchPromise;
	}

	async function fetchMarkerImageInfoById(markerId: number) {
		// Photo galleries (Wikimedia Commons) need a connection — skip the
		// request entirely while offline instead of letting it fail.
		const { isOnline } = useNetworkStatus();
		if (!isOnline.value) {
			selectedMarkerImages.value = [];
			return [];
		}

		const imageData = await fetchMediaWikiFiles(markerId);
		const imageDataList: ImageInfo[] = [];
		imageData.forEach((image) => {
			imageDataList.push(...image.imageinfo);
		});
		selectedMarkerImages.value = imageDataList;
		return imageDataList;
	}

	async function selectMarker(markerId: number | null) {
		selectedMarker.value = null;
		selectedMarkerImages.value.length = 0;

		if (markerId) {
			selectedMarkerImages.value.length = 0;
			const marker = await fetchMarkerById(markerId);
			if (marker) {
				selectedMarker.value = marker;
				fetchMarkerImageInfoById(markerId);
			}
		}
	}

	function updateSelectedMarker(marker: OverPassElement) {
		if (selectedMarker.value && selectedMarker.value.id === marker.id) {
			selectedMarker.value = marker;
		}
	}

	return {
		// State
		fetchPromises,
		selectedMarker,
		selectedMarkerImages,
		// Actions
		fetchMarkerById,
		selectMarker,
		updateSelectedMarker,
		fetchMarkerImageInfoById
	};
});
