// Utilities
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { fetchElementById } from '@/mapHandler/overPassApi';
import { CachedMapNode, getMapNodeById, storeMapNodes } from '@/mapHandler/databaseHandler';
import { fetchMediaWikiFiles, ImageInfo } from '@/mapHandler/markerImageHandler';
import { useNetworkStatus } from '@/composable/networkStatus';
import { OsmRef, parseRef, toRef } from '@/helper/osmRef';

export const useMapMarkerStore = defineStore('marker', () => {
	// State
	const fetchPromises = ref<Map<OsmRef, Promise<CachedMapNode | null>>>(new Map());
	const selectedMarker = ref<CachedMapNode | null>(null);
	const selectedMarkerImages = ref<ImageInfo[]>([]);

	// Actions
	async function fetchMarkerById(ref: OsmRef): Promise<CachedMapNode | null> {
		// Return in-flight promise if already fetching
		if (fetchPromises.value.has(ref)) {
			return fetchPromises.value.get(ref) || null;
		}

		// Create fetch promise
		const fetchPromise = (async () => {
			try {
				// Try database first
				let node = await getMapNodeById(ref);

				// If not in database, fetch from API
				if (!node) {
					// The ref carries the element type, so ask Overpass for exactly
					// that type. Relations matter here: the extract publishes
					// relation-typed ponds and tanks, and a bare `node(id);way(id)`
					// lookup would never find them — an `r…` marker opened from a
					// shared link or a cache miss would resolve to nothing.
					const parsed = parseRef(ref);
					const fetched = parsed ? await fetchElementById(parsed.type, parsed.id) : null;
					if (fetched) {
						// Store in database for future use — the element is valid data
						// regardless of whether it is the one that was asked for.
						await storeMapNodes([fetched]);
						// Guard against a response that isn't the element we asked for
						// (a differently-typed element with the same numeric id).
						const fetchedRef = toRef(fetched.type, fetched.id);
						node = fetchedRef === ref ? { ...fetched, ref: fetchedRef } : null;
					}
				}

				return node;
			} finally {
				// Cleanup
				fetchPromises.value.delete(ref);
			}
		})();

		// Cache the promise
		fetchPromises.value.set(ref, fetchPromise);

		return fetchPromise;
	}

	async function fetchMarkerImageInfoById(ref: OsmRef) {
		// Photo galleries (Wikimedia Commons) need a connection — skip the
		// request entirely while offline instead of letting it fail.
		const { isOnline } = useNetworkStatus();
		if (!isOnline.value) {
			selectedMarkerImages.value = [];
			return [];
		}

		const imageData = await fetchMediaWikiFiles(ref);
		const imageDataList: ImageInfo[] = [];
		imageData.forEach((image) => {
			imageDataList.push(...image.imageinfo);
		});
		selectedMarkerImages.value = imageDataList;
		return imageDataList;
	}

	async function selectMarker(ref: OsmRef | null) {
		selectedMarker.value = null;
		selectedMarkerImages.value.length = 0;

		if (ref) {
			selectedMarkerImages.value.length = 0;
			const marker = await fetchMarkerById(ref);
			if (marker) {
				selectedMarker.value = marker;
				fetchMarkerImageInfoById(ref);
			}
		}
	}

	function updateSelectedMarker(marker: OverPassElement) {
		const ref = toRef(marker.type, marker.id);
		if (selectedMarker.value && selectedMarker.value.ref === ref) {
			selectedMarker.value = { ...marker, ref };
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
