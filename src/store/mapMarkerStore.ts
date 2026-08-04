// Utilities
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { fetchElementById } from '@/mapHandler/overPassApi';
import { CachedMapNode, getMapNodeById, storeMapNodes } from '@/mapHandler/databaseHandler';
import {
	fetchMediaWikiFiles,
	fetchPanoramaxImages,
	ImageInfo,
	ImageSource
} from '@/mapHandler/markerImageHandler';
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

	/**
	 * Order the photo sources are shown in. Street-level captures are usually
	 * the most recent view of a water source, so they lead; the curated Commons
	 * uploads come last. The first entry is also what {@link MarkerInfoPanel}
	 * uses as the thumbnail, so this ordering decides that too.
	 */
	const sourcePriority: Record<ImageSource, number> = {
		panoramax: 0,
		wikimedia: 1
	};

	/**
	 * Fetches photos for a marker from every configured source in parallel:
	 * - Wikimedia Commons, matched by the OSM node id
	 * - Panoramax, from the `panoramax` tag
	 *
	 * @param ref  The marker's namespaced OSM ref.
	 * @param tags The marker's OSM tags. Resolved from the cache/selection when
	 *             omitted, so callers that only hold a ref (the image viewer
	 *             opened from a deep link) still get the tagged sources.
	 */
	async function fetchMarkerImageInfoById(
		ref: OsmRef,
		tags?: Record<string, string>
	): Promise<ImageInfo[]> {
		// Photo galleries need a connection — skip the requests entirely while
		// offline instead of letting them fail.
		const { isOnline } = useNetworkStatus();
		if (!isOnline.value) {
			selectedMarkerImages.value = [];
			return [];
		}

		const markerTags =
			tags ??
			(selectedMarker.value?.ref === ref
				? selectedMarker.value.tags
				: (await fetchMarkerById(ref))?.tags);

		const requests: Promise<ImageInfo[]>[] = [fetchMediaWikiFiles(ref)];

		if (markerTags?.panoramax) {
			requests.push(fetchPanoramaxImages(markerTags.panoramax));
		}

		// Every fetcher already swallows its own errors, but settling keeps one
		// unexpected rejection from dropping the photos of the other sources.
		const results = await Promise.allSettled(requests);
		const imageDataList = results.flatMap((result) =>
			result.status === 'fulfilled' ? result.value : []
		);

		imageDataList.sort((a, b) => {
			const priorityDiff = sourcePriority[a.source] - sourcePriority[b.source];
			if (priorityDiff !== 0) return priorityDiff;
			// Same source: newest first, undated entries last
			const aTime = a.capturedAt ? Date.parse(a.capturedAt) : 0;
			const bTime = b.capturedAt ? Date.parse(b.capturedAt) : 0;
			return (bTime || 0) - (aTime || 0);
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
				// Pass the tags we already hold so the Panoramax id doesn't cost
				// a second marker lookup.
				fetchMarkerImageInfoById(ref, marker.tags);
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
