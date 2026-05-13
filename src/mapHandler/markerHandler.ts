import { ref } from 'vue';
import { GeoBounds, GeoPoint, distanceTo } from '@/types/geo';

import iconFirestation from '../assets/markers/firestation.png';
import iconHydrant from '../assets/markers/hydrant.png';
import iconPump from '../assets/markers/pump.png';
import iconUnderground from '../assets/markers/underground.png';
import iconWall from '../assets/markers/wall.png';
import iconWater from '../assets/markers/water.png';
import iconWaterTank from '../assets/markers/watertank.png';

import { fetchMarkerData, OverPassElement } from './overPassApi';
import {
	getMapNodesForView,
	getNearbyMapNodes,
	storeMapNodes,
	getMapNodeIdsForBounds,
	hardDeleteMapNodes
} from '@/mapHandler/databaseHandler';
import { useMapMarkerStore } from '@/store/mapMarkerStore';
import { NearbyMarker } from '@/composable/nearbyWaterSource';

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

async function reconcileDeletedNodes(mapBounds: GeoBounds, freshElements: OverPassElement[]) {
	const freshIds = new Set(freshElements.map((e) => e.id));
	const cachedIds = await getMapNodeIdsForBounds(mapBounds);
	const staleIds = cachedIds.filter((id) => !freshIds.has(id));
	await hardDeleteMapNodes(staleIds);
}

async function updateNodeCache(mapBounds: GeoBounds): Promise<OverPassElement[]> {
	const mapElements = await fetchMarkerData(mapBounds);

	// null means the request was aborted or failed — skip cache operations
	// to avoid falsely deleting cached markers.
	if (mapElements === null) {
		return [];
	}

	await storeMapNodes(mapElements);
	// Only reconcile when the result is not truncated by the 2000-element limit,
	// otherwise we'd falsely hard-delete nodes that were just cut off.
	if (mapElements.length < 2000) {
		await reconcileDeletedNodes(mapBounds, mapElements);
	}
	return mapElements;
}

/** Reactive flag – `true` while markers are being fetched from the Overpass API for an uncached area. */
export const isLoadingMarkers = ref(false);

export async function getMarkersForView(mapBounds: GeoBounds): Promise<GeoJSON.FeatureCollection> {
	const features: GeoJSON.Feature[] = [];
	try {
		let mapElements = await getMapNodesForView(mapBounds);
		// if nothing is in the cache wait for the api call
		if (!mapElements.length) {
			isLoadingMarkers.value = true;
			try {
				mapElements = await updateNodeCache(mapBounds);
			} finally {
				isLoadingMarkers.value = false;
			}
		} else {
			// Fire-and-forget background cache refresh — silently ignore
			// abort errors (superseded by a newer request) and network failures.
			updateNodeCache(mapBounds).catch(() => {});
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
