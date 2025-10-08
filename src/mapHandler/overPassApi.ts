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

	fetchData += ');out qt center 2000 tags;';

	const response = await fetch(OverpassBaseURL + encodeURI(fetchData));
	const data = await response.json();
	return data?.elements as OverPassElement[];
}

export async function fetchNodeById(nodeId: number): Promise<OverPassElement | null> {
	const fetchData = `[out:json][timeout:15];(node(${nodeId});way(${nodeId}););out center tags;`;

	try {
		const response = await fetch(OverpassBaseURL + encodeURI(fetchData));
		const data = await response.json();
		const elements = data?.elements as OverPassElement[];
		return elements && elements.length > 0 ? elements[0] : null;
	} catch (e) {
		console.error('Error fetching node by ID:', e);
		return null;
	}
}
