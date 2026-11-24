// Utilities
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { OverPassElement } from '@/mapHandler/overPassApi';
import { fetchElementById } from '@/mapHandler/overPassApi';
import { fetchElementFromOsmApi } from '@/mapHandler/osmApiElement';
import {
	CachedMapNode,
	getAllPendingEdits,
	getMapNodeById,
	storeMapNodes
} from '@/mapHandler/databaseHandler';
import { markerCacheVersion } from '@/mapHandler/markerHandler';
import { mergeFreshElement } from '@/helper/markerRevalidation';
import { isMarkerTags } from '@/helper/osmElement';
import { wasDryRunEdited } from '@/services/osmWrite';
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
	/**
	 * Lookup state of the marker being selected, so the info panel can tell
	 * "still loading" from "could not be loaded" instead of spinning forever.
	 */
	const selectedMarkerStatus = ref<'idle' | 'loading' | 'notFound'>('idle');
	const selectedMarkerImages = ref<ImageInfo[]>([]);
	/** Refs just loaded live on a cache miss — already current, no revalidation needed. */
	const loadedLive = new Set<OsmRef>();

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
					//
					// The OSM API answers first: a single-object read is fast and
					// authoritative, while Overpass can be slow, rate-limited or down —
					// and a shared link on a fresh device then opened nothing at all.
					// Overpass remains the fallback (and serves relations).
					const parsed = parseRef(ref);
					const fetched = parsed
						? ((await fetchElementFromOsmApi(parsed.type, parsed.id)) ??
							(await fetchElementById(parsed.type, parsed.id)))
						: null;
					if (fetched) {
						// Store in database for future use — the element is valid data
						// regardless of whether it is the one that was asked for.
						await storeMapNodes([fetched]);
						// Guard against a response that isn't the element we asked for
						// (a differently-typed element with the same numeric id).
						const fetchedRef = toRef(fetched.type, fetched.id);
						node = fetchedRef === ref ? { ...fetched, ref: fetchedRef } : null;
						if (node) loadedLive.add(ref);
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

	// --- Background revalidation against live OSM -----------------------------
	//
	// The cache is filled from the static extract, which is days behind OSM. A
	// marker is shown from the cache at once; in parallel its current version
	// is read from OSM, and if a value changed (say it was taken out of service)
	// the cache, the map and an open info panel pick it up. Never blocks the UI.

	const revalidations = new Map<OsmRef, Promise<OverPassElement | null>>();
	/** Bumped per ref whenever the app writes its own version (a save). */
	const localWrites = new Map<OsmRef, number>();

	/**
	 * Records that the app just stored its own version of `ref` (a successful
	 * save). A live read that started earlier may predate it and is discarded.
	 */
	function noteLocalWrite(ref: OsmRef) {
		localWrites.set(ref, (localWrites.get(ref) ?? 0) + 1);
	}

	/** Reads the live version: the OSM API, or Overpass for relations. */
	async function fetchLiveElement(ref: OsmRef): Promise<OverPassElement | null> {
		const parsed = parseRef(ref);
		if (!parsed || parsed.id <= 0) return null;
		const element =
			parsed.type === 'relation'
				? await fetchElementById(parsed.type, parsed.id)
				: await fetchElementFromOsmApi(parsed.type, parsed.id);
		// Guard against an answer for a differently typed element.
		return element && toRef(element.type, element.id) === ref ? element : null;
	}

	/** True when a queued offline edit targets `ref`: the cache holds the user's version. */
	async function hasPendingEdit(ref: OsmRef): Promise<boolean> {
		const edits = await getAllPendingEdits();
		return edits.some((edit) => toRef(edit.elementType ?? 'node', edit.osmId) === ref);
	}

	async function runRevalidation(ref: OsmRef): Promise<OverPassElement | null> {
		const writesBefore = localWrites.get(ref) ?? 0;
		const live = await fetchLiveElement(ref);
		if (!live) return null; // offline, failed or gone: keep showing the cache
		// Saved meanwhile: this answer may be older than what was just uploaded.
		if ((localWrites.get(ref) ?? 0) !== writesBefore) return null;

		// Local versions that are newer than OSM, as far as this device knows:
		// a queued offline edit, or a preview build's simulated save.
		if (wasDryRunEdited(ref) || (await hasPendingEdit(ref))) return null;
		// No longer a water source on OSM — leave the removal to the regular
		// map refresh rather than yanking an open panel away.
		if (!isMarkerTags(live.tags ?? {})) return null;

		const cached = await getMapNodeById(ref);
		if (!cached) return live; // not a cached marker (e.g. a water area being flagged)

		const merged = mergeFreshElement(cached, live);
		if (!merged) return live;
		if ((localWrites.get(ref) ?? 0) !== writesBefore) return null;
		await storeMapNodes([merged]);
		updateSelectedMarker(merged);
		markerCacheVersion.value++;
		return live;
	}

	/**
	 * Fetches the current OSM version of `ref` in the background and, when it
	 * differs, updates the local cache, the map and the selected marker.
	 *
	 * Resolves with the live element (also when unchanged), or `null` when it
	 * could not be read or must not replace the local copy. Never rejects.
	 * Concurrent calls (opening a marker, then tapping "edit" while the read
	 * is still running) share one request.
	 */
	function revalidateMarker(ref: OsmRef): Promise<OverPassElement | null> {
		const { isOnline } = useNetworkStatus();
		if (!isOnline.value) return Promise.resolve(null);
		const inFlight = revalidations.get(ref);
		if (inFlight) return inFlight;

		const promise = runRevalidation(ref)
			.catch((e) => {
				console.warn(`Revalidating ${ref} against OSM failed:`, e);
				return null;
			})
			.finally(() => revalidations.delete(ref));
		revalidations.set(ref, promise);
		return promise;
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

	/** Increments per selection; an older lookup must not overwrite a newer one. */
	let selectSequence = 0;

	async function selectMarker(ref: OsmRef | null) {
		const sequence = ++selectSequence;
		selectedMarker.value = null;
		selectedMarkerImages.value.length = 0;
		selectedMarkerStatus.value = ref ? 'loading' : 'idle';

		if (ref) {
			selectedMarkerImages.value.length = 0;
			const marker = await fetchMarkerById(ref);
			// A newer selection (or a deselect) happened meanwhile — don't let this
			// older lookup overwrite it.
			if (sequence !== selectSequence) return;
			selectedMarkerStatus.value = marker ? 'idle' : 'notFound';
			if (marker) {
				selectedMarker.value = marker;
				// Pass the tags we already hold so the Panoramax id doesn't cost
				// a second marker lookup.
				fetchMarkerImageInfoById(ref, marker.tags);
				// Show the cached values now, check OSM for newer ones meanwhile.
				if (!loadedLive.delete(ref)) void revalidateMarker(ref);
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
		selectedMarkerStatus,
		selectedMarkerImages,
		// Actions
		fetchMarkerById,
		revalidateMarker,
		noteLocalWrite,
		selectMarker,
		updateSelectedMarker,
		fetchMarkerImageInfoById
	};
});
