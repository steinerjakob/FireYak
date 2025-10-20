import { LatLng } from 'leaflet';

function toRadians(deg: number): number {
	return (deg * Math.PI) / 180;
}

export function distanceBetween2Points(start: LatLng, end: LatLng): number {
	const R = 6371; // earth radius in km
	const lat1 = start.lat;
	const lat2 = end.lat;
	const lon1 = start.lng;
	const lon2 = end.lng;

	const dLat = toRadians(lat2 - lat1);
	const dLon = toRadians(lon2 - lon1);

	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

	const c = 2 * Math.asin(Math.sqrt(a));
	const distanceKm = R * c;

	const kmRounded = Math.round(distanceKm);
	const meters = Math.round((distanceKm - Math.floor(distanceKm)) * 1000);

	console.info(`Distance: ${distanceKm} km  | ${kmRounded} km  ${meters} m`);

	return distanceKm;
}

export function distanceBetweenMultiplePoints(points: LatLng[]): number {
	let totalDistance = 0;
	for (let i = 0; i < points.length - 1; i++) {
		totalDistance += distanceBetween2Points(points[i], points[i + 1]);
	}
	return totalDistance;
}
