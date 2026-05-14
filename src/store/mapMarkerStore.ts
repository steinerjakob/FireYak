// Utilities
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { fetchNodeById } from '@/mapHandler/overPassApi';
import { getMapNodeById, storeMapNodes } from '@/mapHandler/databaseHandler';
import {
	fetchMediaWikiFiles,
	fetchPanoramaxImages,
	fetchMapillaryImages,
	ImageInfo
} from '@/mapHandler/markerImageHandler';

export const useMapMarkerStore = defineStore('marker', () => {
	// State
	const fetchPromises = ref<Map<number, Promise<OverPassElement | null>>>(new Map());
	const selectedMarker = ref<OverPassElement | null>(null);
	const selectedMarkerImages = ref<ImageInfo[]>([]);

	// Actions
	async function fetchMarkerById(markerId: number): Promise<OverPassElement | null> {
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

	/**
	 * Fetches images for a marker from all available sources in parallel:
	 * - Wikimedia Commons (by OSM node ID prefix)
	 * - Panoramax (from the `panoramax` OSM tag)
	 * - Mapillary (from the `mapillary` OSM tag)
	 *
	 * @param markerId  The OSM node/way ID
	 * @param tags      Optional marker tags used to resolve Panoramax / Mapillary keys
	 */
	async function fetchMarkerImageInfoById(
		markerId: number,
		tags?: Record<string, string>
	): Promise<ImageInfo[]> {
		const promises: Promise<ImageInfo[]>[] = [fetchMediaWikiFiles(markerId)];

		const panoramaxId = tags?.['panoramax'];
		if (panoramaxId) {
			promises.push(fetchPanoramaxImages(panoramaxId));
		}

		const mapillaryKey = tags?.['mapillary'];
		if (mapillaryKey) {
			promises.push(fetchMapillaryImages(mapillaryKey));
		}

		const results = await Promise.allSettled(promises);
		const imageDataList: ImageInfo[] = [];
		for (const result of results) {
			if (result.status === 'fulfilled') {
				imageDataList.push(...result.value);
			}
		}

		// Sort priority:
		//  1. Panoramax first (most recent field-captured photos)
		//  2. Mapillary second
		//  3. Wikimedia Commons last
		// Within each source group, sort newest capturedAt first.
		const sourcePriority: Record<string, number> = { panoramax: 0, mapillary: 1, wikimedia: 2 };
		imageDataList.sort((a, b) => {
			const priorityDiff = (sourcePriority[a.source] ?? 99) - (sourcePriority[b.source] ?? 99);
			if (priorityDiff !== 0) return priorityDiff;
			// Same source: newer first (undefined dates go to the end)
			const aTime = a.capturedAt ? new Date(a.capturedAt).getTime() : 0;
			const bTime = b.capturedAt ? new Date(b.capturedAt).getTime() : 0;
			return bTime - aTime;
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
				// Pass marker tags so Panoramax / Mapillary IDs can be resolved
				fetchMarkerImageInfoById(markerId, marker.tags);
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
