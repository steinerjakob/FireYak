// Utilities
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { fetchNodeById } from '@/mapHandler/overPassApi';
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
					// Overpass keys nodes and ways by numeric id in separate element
					// types; the ref's numeric id is all `fetchNodeById` needs, it
					// queries both `node(id)` and `way(id)`.
					const parsed = parseRef(ref);
					const fetched = parsed ? await fetchNodeById(parsed.id) : null;
					if (fetched) {
						// Store in database for future use — the element is valid data
						// regardless of whether it is the one that was asked for.
						await storeMapNodes([fetched]);
						// `fetchNodeById` queries `node(id)` and `way(id)` together and
						// returns whichever came back first, so for an id that exists as
						// both it can answer with the wrong element type. Only adopt it
						// when it actually matches the requested ref.
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
