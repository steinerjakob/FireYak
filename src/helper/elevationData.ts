import { LatLng } from 'leaflet';

const MAX_ELEVATION_POINTS_PER_REQUEST = 100;
export const ELEVATION_RASTER = 90; // in meters

export interface ElevationPoint {
	latLng: LatLng;
	elevation: number;
}

export async function getElevationDataForPoints(points: LatLng[]) {
	// Beispiel-Implementierung, die eine fiktive API aufruft
	const elevations: ElevationPoint[] = [];

	for (let i = 0; i < points.length; i += MAX_ELEVATION_POINTS_PER_REQUEST) {
		const batch = points.slice(i, i + MAX_ELEVATION_POINTS_PER_REQUEST);
		const batchElevations = await fetchElevationForPoints(batch);
		elevations.push(...batchElevations);
	}

	return elevations;
}

async function fetchElevationForPoints(points: LatLng[]): Promise<ElevationPoint[]> {
	try {
		// https://api.open-meteo.com/v1/elevation?latitude=52.52,48.85&longitude=13.41,2.35
		const latitudePoints = points.map((p) => p.lat).join(',');
		const longitudePoints = points.map((p) => p.lng).join(',');
		const response = await fetch(
			`https://api.open-meteo.com/v1/elevation?latitude=${latitudePoints}&longitude=${longitudePoints}`
		);
		if (!response.ok) {
			console.error('HTTP error! status:', response.status);
			return [];
		} else {
			const data = await response.json();
			return data.elevation.map((elevation: number, index: number) => ({
				latLng: points[index],
				elevation
			}));
		}
	} catch (e) {
		console.error('Error fetching elevation data for points:', e);
		return [];
	}
}
