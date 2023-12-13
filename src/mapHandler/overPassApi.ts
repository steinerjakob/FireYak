import L, { LatLngBounds } from 'leaflet';

const OverpassBaseURL = `https://overpass-api.de/api/interpreter?data=`;

export interface OverPassElement {
	id: number;
	type: string;
	lat?: number;
	lon?: number;
	center?: {
		lat: number;
		lon: number;
	};
	tags: {
		// emergency: 'fire_hydrant' | 'water_tank' | 'suction_point' | 'fire_water_pond' | undefined;
		// 'firehydrant:type': 'pillar' | 'underground' | 'wall' | undefined;
		[key: string]: string;
	};
}
export async function fetchMarkerData(mapBounds: LatLngBounds): Promise<OverPassElement[]> {
	let fetchData = '[out:json][timeout:15];(';

	const osmDataKeys = [
		'node[emergency=fire_hydrant]',
		'way[amenity=fire_station]',
		'node[emergency=water_tank]',
		'node[emergency=suction_point]',
		'node[emergency=fire_water_pond]'
	];
	const boundString =
		'(' +
		mapBounds.getSouth() +
		',' +
		mapBounds.getWest() +
		',' +
		mapBounds.getNorth() +
		',' +
		mapBounds.getEast() +
		')';

	osmDataKeys.forEach((key) => {
		fetchData += key + boundString + ';';
	});

	fetchData += ');out qt center 1000 tags;';

	const response = await fetch(OverpassBaseURL + encodeURI(fetchData));
	const data = await response.json();
	return data?.elements as OverPassElement[];
}
