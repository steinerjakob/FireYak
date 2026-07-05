import { GeoPoint } from '@/types/geo';
import { useNetworkStatus } from '@/composable/networkStatus';

const MAX_ELEVATION_POINTS_PER_REQUEST = 100;
export const ELEVATION_RASTER = 20; // in meters should be the tube length eg B = 20m

export interface ElevationPoint {
	latLng: GeoPoint;
	elevation: number;
	pressure?: number;
	distance?: number;
}

export interface ElevationResult {
	points: ElevationPoint[];
	/** True when a flat-terrain fallback (elevation 0 everywhere) was used instead of real data. */
	elevationIgnored: boolean;
}

/** Flat-terrain fallback: same points, elevation 0 everywhere. */
function flatElevations(points: GeoPoint[]): ElevationPoint[] {
	return points.map((latLng) => ({ latLng, elevation: 0 }));
}

/**
 * Fetches elevation data for the given points from Open-Meteo. Skips the
 * network call entirely when offline, and falls back to a flat-terrain
 * estimate (elevation 0 everywhere) if the fetch fails mid-flight (e.g. the
 * connection drops between batches) — the caller can still complete the
 * calculation, it just shouldn't trust the elevation numbers.
 */
export async function getElevationDataForPoints(points: GeoPoint[]): Promise<ElevationResult> {
	const { isOnline } = useNetworkStatus();
	if (!isOnline.value) {
		return { points: flatElevations(points), elevationIgnored: true };
	}

	const elevations: ElevationPoint[] = [];

	for (let i = 0; i < points.length; i += MAX_ELEVATION_POINTS_PER_REQUEST) {
		const batch = points.slice(i, i + MAX_ELEVATION_POINTS_PER_REQUEST);
		const batchElevations = await fetchElevationForPoints(batch);
		// A short batch means the request failed (see catch below) — bail out
		// to the flat-terrain fallback for the whole path rather than mixing
		// real and missing elevations.
		if (batchElevations.length !== batch.length) {
			return { points: flatElevations(points), elevationIgnored: true };
		}
		elevations.push(...batchElevations);
	}

	return { points: elevations, elevationIgnored: false };
}

async function fetchElevationForPoints(points: GeoPoint[]): Promise<ElevationPoint[]> {
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
