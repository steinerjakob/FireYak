import { ref } from 'vue';
import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';

import iconFirestation from '../assets/markers/firestation.png';
import iconHydrant from '../assets/markers/hydrant.png';
import iconPump from '../assets/markers/pump.png';
import iconUnderground from '../assets/markers/underground.png';
import iconWall from '../assets/markers/wall.png';
import iconWater from '../assets/markers/water.png';
import iconWaterTank from '../assets/markers/watertank.png';

import { fetchMarkerData, OverPassElement, wasLastAreaQueryFailure } from './overPassApi';
import {
	getMapNodesForView,
	getNearbyMapNodes,
	storeMapNodes,
	getMapNodeIdsForBounds,
	hardDeleteMapNodes
} from '@/mapHandler/databaseHandler';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { NearbyMarker } from '@/composable/nearbyWaterSource';
import { lngLatToTile, tileKey } from '@/helper/tileMath';

// Map icon keys to URLs for use in MapLibre image loading
export const markerIconUrls: Record<string, string> = {
	hydrant: iconHydrant,
	underground: iconUnderground,
	wall: iconWall,
	pump: iconPump,
	water: iconWater,
	watertank: iconWaterTank,
	firestation: iconFirestation
};

function getIconKeyForNode(element: OverPassElement): string {
	if (element.type === 'node') {
		const emergency = element.tags?.emergency;
		const type = element.tags?.['fire_hydrant:type'];
		switch (emergency) {
			case 'fire_hydrant':
				return (
					(
						{ pillar: 'hydrant', underground: 'underground', wall: 'wall' } as Record<
							string,
							string
						>
					)[type as string] || 'hydrant'
				);
			case 'suction_point':
				return 'pump';
			case 'fire_water_pond':
				return 'water';
			case 'water_tank':
				return 'watertank';
		}
	}
	if (element.type === 'way') {
		return 'firestation';
	}
	return 'hydrant';
}

function getIconUrlForNode(element: OverPassElement): string {
	return markerIconUrls[getIconKeyForNode(element)];
}

// --- Freshness registry (§1.4) -------------------------------------------
// Slippy-tile keys at a fixed zoom mapped to the last successful fetch time.
// Lets us skip a background Overpass refresh when the whole (padded) view was
// fetched only moments ago — cuts redundant load and rate-limiting on pans.

/** Zoom level whose tiles act as freshness buckets. */
const FRESHNESS_ZOOM = 12;
/** How long a fetched tile is considered fresh. */
const FRESHNESS_TTL_MS = 15 * 60 * 1000;
/** Fraction the requested bbox is grown by (per axis) before fetching. */
const BBOX_PADDING_RATIO = 0.25;

const tileFreshness = new Map<string, number>();

/**
 * Grows the bounds by {@link ratio} per axis (split evenly on each side) so a
 * small pan tends to stay inside an already-fetched area.
 */
function padBounds(bounds: GeoBounds, ratio: number): GeoBounds {
	const latPad = ((bounds.north - bounds.south) * ratio) / 2;
	const lngPad = ((bounds.east - bounds.west) * ratio) / 2;
	return {
		south: bounds.south - latPad,
		north: bounds.north + latPad,
		west: bounds.west - lngPad,
		east: bounds.east + lngPad
	};
}

/** All z{@link FRESHNESS_ZOOM} tile keys covering the given bounds. */
function coveringTileKeys(bounds: GeoBounds): string[] {
	const nw = lngLatToTile(bounds.north, bounds.west, FRESHNESS_ZOOM);
	const se = lngLatToTile(bounds.south, bounds.east, FRESHNESS_ZOOM);
	const keys: string[] = [];
	for (let x = nw.x; x <= se.x; x++) {
		for (let y = nw.y; y <= se.y; y++) {
			keys.push(tileKey({ z: FRESHNESS_ZOOM, x, y }));
		}
	}
	return keys;
}

/** True when every given tile was fetched within the freshness TTL. */
function areTilesFresh(keys: string[]): boolean {
	const now = Date.now();
	return keys.every((key) => {
		const fetchedAt = tileFreshness.get(key);
		return fetchedAt !== undefined && now - fetchedAt < FRESHNESS_TTL_MS;
	});
}

/** Stamps the given tiles as freshly fetched. */
function markTilesFresh(keys: string[]): void {
	const now = Date.now();
	for (const key of keys) {
		tileFreshness.set(key, now);
	}
}

async function reconcileDeletedNodes(mapBounds: GeoBounds, freshElements: OverPassElement[]) {
	const freshIds = new Set(freshElements.map((e) => e.id));
	const cachedIds = await getMapNodeIdsForBounds(mapBounds);
	const staleIds = cachedIds.filter((id) => !freshIds.has(id));
	await hardDeleteMapNodes(staleIds);
}

async function updateNodeCache(mapBounds: GeoBounds): Promise<OverPassElement[]> {
	// Pad the query bbox so small subsequent pans stay inside the fetched area.
	// (overPassApi clamps oversized bounds afterwards — padding first is fine.)
	const queryBounds = padBounds(mapBounds, BBOX_PADDING_RATIO);
	const mapElements = await fetchMarkerData(queryBounds);

	// null means the request was aborted or failed — skip cache operations
	// to avoid falsely deleting cached markers.
	if (mapElements === null) {
		return [];
	}

	// Mark the covering tiles fresh so a following pan within this area can
	// skip its background refresh.
	markTilesFresh(coveringTileKeys(queryBounds));

	await storeMapNodes(mapElements);
	// Only reconcile when the result is not truncated by the 2000-element limit,
	// otherwise we'd falsely hard-delete nodes that were just cut off.
	if (mapElements.length < 2000) {
		await reconcileDeletedNodes(queryBounds, mapElements);
	}
	return mapElements;
}

/** Reactive flag – `true` while markers are being fetched from the Overpass API for an uncached area. */
export const isLoadingMarkers = ref(false);

/**
 * Reactive flag – `true` when the most recent **uncached-area** fetch
 * genuinely failed (network error, server error, all instances timed out).
 * Reset to `false` as soon as any subsequent fetch succeeds.
 * Background refresh failures while cached data is already on screen do NOT
 * set this flag — only the blocking foreground load path does.
 */
export const markerFetchFailed = ref(false);

export async function getMarkersForView(mapBounds: GeoBounds): Promise<GeoJSON.FeatureCollection> {
	const features: GeoJSON.Feature[] = [];
	try {
		let mapElements: OverPassElement[] = await getMapNodesForView(mapBounds);
		// if nothing is in the cache wait for the api call
		if (!mapElements.length) {
			isLoadingMarkers.value = true;
			try {
				mapElements = await updateNodeCache(mapBounds);
				// updateNodeCache returns [] on both abort and genuine failure.
				// wasLastAreaQueryFailure() distinguishes them.
				markerFetchFailed.value = wasLastAreaQueryFailure();
			} finally {
				isLoadingMarkers.value = false;
			}
		} else {
			// Cache hit. Skip the background refresh entirely when the whole
			// (padded) view was already fetched within the freshness TTL —
			// avoids redundant Overpass load and rate-limiting on small pans.
			const tileKeys = coveringTileKeys(padBounds(mapBounds, BBOX_PADDING_RATIO));
			if (!areTilesFresh(tileKeys)) {
				// Fire-and-forget background cache refresh — silently ignore
				// abort errors (superseded by a newer request) and network failures.
				// Background failures while cached data is already on screen are
				// intentionally not surfaced (markerFetchFailed stays unchanged).
				updateNodeCache(mapBounds).catch(() => {});
			}
		}
		for (const element of mapElements) {
			const lat = (element?.lat || element.center?.lat) as number;
			const lng = (element.lon || element.center?.lon) as number;
			features.push({
				type: 'Feature',
				geometry: {
					type: 'Point',
					coordinates: [lng, lat]
				},
				properties: {
					id: element.id,
					icon: getIconKeyForNode(element)
				}
			});
		}
	} catch (e) {
		// ignore error for now
	}

	return { type: 'FeatureCollection', features };
}

/**
 * Sorts a list of map markers by their distance from a specified geographic location.
 *
 * @param elements
 * @param {GeoPoint} latLng - The reference geographic location used to calculate distances from each marker.
 * @return {Promise<NearbyMarker[]>} A promise that resolves to an array of objects, each containing a marker and its distance from the specified location, sorted in ascending order by distance.
 */
async function sortElementsByDistance(
	elements: OverPassElement[],
	latLng: GeoPoint
): Promise<NearbyMarker[]> {
	const markersWithDistance: NearbyMarker[] = elements.map((element) => {
		const elementPoint: GeoPoint = {
			lat: (element?.lat || element.center?.lat) as number,
			lng: (element.lon || element.center?.lon) as number
		};
		return {
			element,
			distance: distanceTo(latLng, elementPoint),
			icon: getIconUrlForNode(element)
		};
	});

	return markersWithDistance.sort((a, b) => a.distance - b.distance);
}

/**
 * Retrieves a list of nearby markers within the specified radius around a point,
 * sorted by their distance from the given coordinates.
 *
 * @param {GeoPoint} latLng - The latitude and longitude coordinates used as the center point.
 * @param {number} radius - The search radius in meters around the center point (default: 5000 meters).
 * @return {Promise<NearbyMarker[]>} A promise that resolves with a list of sorted markers containing their distance and icons.
 */
export async function getNearbyMarkers(latLng: GeoPoint, radius = 2000): Promise<NearbyMarker[]> {
	const elements = await getNearbyMapNodes(latLng, radius);
	return sortElementsByDistance(elements, latLng);
}

export async function getMarkerById(markerId: number) {
	const markerStore = useMapMarkerStore();
	return markerStore.fetchMarkerById(markerId);
}
