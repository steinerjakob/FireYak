import L, { LatLngBounds } from 'leaflet';

import iconFirestation from '../assets/markers/firestation.png';
import iconHydrant from '../assets/markers/hydrant.png';
import iconPump from '../assets/markers/pump.png';
import iconUnderground from '../assets/markers/underground.png';
import iconWall from '../assets/markers/wall.png';
import iconWater from '../assets/markers/water.png';
import iconWaterTank from '../assets/markers/watertank.png';

import { fetchMarkerData, OverPassElement } from './overPassApi';

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
export async function getMarkersForView(mapBounds: LatLngBounds) {
	const markerList: L.Marker[] = [];
	try {
		const mapElements = await fetchMarkerData(mapBounds);
		for (const element of mapElements) {
			const latLng = L.latLng(
				(element?.lat || element.center?.lat) as number,
				(element.lon || element.center?.lon) as number
			);
			// todo add additional marker information
			// icon and so on..
			const markerIcon = getIconForNode(element);
			markerList.push(L.marker(latLng, { icon: markerIcon }));
		}
	} catch (e) {
		// ignore error for now
	}

	return markerList;
}
