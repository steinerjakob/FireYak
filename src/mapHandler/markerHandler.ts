import L, { LatLngBounds } from 'leaflet';

import iconFirestation from '../assets/markers/firestation.png';
import iconHydrant from '../assets/markers/hydrant.png';
import iconPump from '../assets/markers/pump.png';
import iconUnderground from '../assets/markers/underground.png';
import iconWall from '../assets/markers/wall.png';
import iconWater from '../assets/markers/water.png';
import iconWaterTank from '../assets/markers/watertank.png';

import { fetchMarkerData, OverPassElement } from './overPassApi';
import { getMapNodesForView, storeMapNodes } from '@/mapHandler/databaseHandler';
import { useMapMarkerStore } from '@/store/app';
import { NearbyMarker } from '@/composable/nearbyWaterSource';

function getIconForNode(element: OverPassElement): L.Icon {
	let iconData = iconHydrant;
	if (element.type === 'node') {
		const emergency = element.tags?.emergency;
		const type = element.tags?.['firehydrant:type'];
		switch (emergency) {
			case 'fire_hydrant':
				iconData =
					{
						pillar: iconHydrant,
						underground: iconUnderground,
						wall: iconWall
					}[type] || iconHydrant;
				break;
			case 'suction_point':
				iconData = iconPump;
				break;
			case 'fire_water_pond':
				iconData = iconWater;
				break;
			case 'water_tank':
				iconData = iconWaterTank;
				break;
		}
	}
	if (element.type === 'way') {
		iconData = iconFirestation;
	}

	return L.icon({
		iconUrl: iconData,
		iconSize: [32, 32]
	});
}

async function updateNodeCache(mapBounds: LatLngBounds) {
	const mapElements = await fetchMarkerData(mapBounds);
	await storeMapNodes(mapElements);
	return mapElements;
}

export async function getMarkersForView(mapBounds: LatLngBounds) {
	const markerList: L.Marker[] = [];
	try {
		let mapElements = await getMapNodesForView(mapBounds);
		// if nothing is in the cache wait for the api call
		if (!mapElements.length) {
			mapElements = await updateNodeCache(mapBounds);
		} else {
			updateNodeCache(mapBounds);
		}
		for (const element of mapElements) {
			const latLng = L.latLng(
				(element?.lat || element.center?.lat) as number,
				(element.lon || element.center?.lon) as number
			);
			// todo add additional marker information
			// icon and so on..
			const markerIcon = getIconForNode(element);
			markerList.push(L.marker(latLng, { title: `${element.id}`, icon: markerIcon }));
		}
	} catch (e) {
		// ignore error for now
	}

	return markerList;
}

/**
 * Sorts a list of map markers by their distance from a specified geographic location.
 *
 * @param elements
 * @param {L.LatLng} latLng - The reference geographic location used to calculate distances from each marker.
 * @return {Promise<NearbyMarker[]>} A promise that resolves to an array of objects, each containing a marker and its distance from the specified location, sorted in ascending order by distance.
 */
async function sortElementsByDistance(
	elements: OverPassElement[],
	latLng: L.LatLng
): Promise<NearbyMarker[]> {
	const markersWithDistance: NearbyMarker[] = elements.map((element) => {
		const elementLatLng = L.latLng(
			(element?.lat || element.center?.lat) as number,
			(element.lon || element.center?.lon) as number
		);
		return {
			element,
			distance: latLng.distanceTo(elementLatLng),
			icon: getIconForNode(element).options.iconUrl
		};
	});

	return markersWithDistance.sort((a, b) => a.distance - b.distance);
}

/**
 * Retrieves a list of nearby markers within the specified map bounds,
 * sorted by their distance from a given latitude and longitude.
 *
 * @param {LatLngBounds} mapBounds - The geographical bounds of the map view within which markers are searched.
 * @param {L.LatLng} latLng - The latitude and longitude coordinates used to sort the markers by proximity.
 * @return {Promise<NearbyMarker[]>} A promise that resolves with a list of sorted markers that fall within the specified bounds.
 */
export async function getNearbyMarkers(
	mapBounds: LatLngBounds,
	latLng: L.LatLng
): Promise<NearbyMarker[]> {
	const elements = await getMapNodesForView(mapBounds);
	return sortElementsByDistance(elements, latLng);
}

export async function getMarkerById(markerId: number) {
	const markerStore = useMapMarkerStore();
	return markerStore.fetchMarkerById(markerId);
}
