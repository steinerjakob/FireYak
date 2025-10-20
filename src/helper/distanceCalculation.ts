import { LatLng } from 'leaflet';

function toRadians(deg: number): number {
	return (deg * Math.PI) / 180;
}

function toDegrees(rad: number): number {
	return (rad * 180) / Math.PI;
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

/**
 * Interpolates a point on the great circle path between two geographical locations.
 * The interpolation is determined by a fraction parameter.
 *
 * @param {LatLng} start - The starting geographical coordinates with latitude and longitude.
 * @param {LatLng} end - The ending geographical coordinates with latitude and longitude.
 * @param {number} fraction - The fraction along the great circle path, where 0 is the start
 *                            and 1 is the end.
 * @return {LatLng} The interpolated geographical coordinates as a LatLng object.
 */
function interpolateGreatCircle(start: LatLng, end: LatLng, fraction: number): LatLng {
	const φ1 = toRadians(start.lat);
	const λ1 = toRadians(start.lng);
	const φ2 = toRadians(end.lat);
	const λ2 = toRadians(end.lng);

	// zentraler Winkel (delta)
	const sinφ1 = Math.sin(φ1),
		cosφ1 = Math.cos(φ1);
	const sinφ2 = Math.sin(φ2),
		cosφ2 = Math.cos(φ2);
	const Δλ = λ2 - λ1;

	const cosΔλ = Math.cos(Δλ);
	const sinΔλ = Math.sin(Δλ);

	// Winkel zwischen Punkten
	const δ = Math.acos(Math.max(-1, Math.min(1, sinφ1 * sinφ2 + cosφ1 * cosφ2 * cosΔλ)));

	if (δ === 0) {
		return new LatLng(start.lat, start.lng);
	}

	const A = Math.sin((1 - fraction) * δ) / Math.sin(δ);
	const B = Math.sin(fraction * δ) / Math.sin(δ);

	const x = A * cosφ1 * Math.cos(λ1) + B * cosφ2 * Math.cos(λ2);
	const y = A * cosφ1 * Math.sin(λ1) + B * cosφ2 * Math.sin(λ2);
	const z = A * sinφ1 + B * sinφ2;

	const φi = Math.atan2(z, Math.sqrt(x * x + y * y));
	const λi = Math.atan2(y, x);

	return new LatLng(toDegrees(φi), toDegrees(λi));
}

/**
 * Berechnet Punkte (inkl. Start und Ende) entlang der Verbindung start->end
 * im Abstand `stepMeters` (Standard 90).
 */
export function pointsEveryMetersBetween(
	start: LatLng,
	end: LatLng,
	stepMeters = 90
): { distance: number; points: LatLng[] } {
	const totalKm = distanceBetween2Points(start, end);
	const totalMeters = totalKm * 1000;

	// wenn sehr kurz, einfach Start und Ende zurückgeben
	if (totalMeters <= stepMeters) {
		return {
			distance: totalKm,
			points: [new LatLng(start.lat, start.lng), new LatLng(end.lat, end.lng)]
		};
	}

	const points: LatLng[] = [];
	const steps = Math.floor(totalMeters / stepMeters);

	// generiere Punkte bei Abständen 0, step, 2*step, ..., steps*step
	for (let i = 0; i <= steps; i++) {
		const dist = Math.min(i * stepMeters, totalMeters);
		const fraction = dist / totalMeters;
		points.push(interpolateGreatCircle(start, end, fraction));
	}

	// falls letzter Punkt nicht exakt das Ende ist, stelle Ende sicher
	const last = points[points.length - 1];
	if (Math.abs(last.lat - end.lat) > 1e-8 || Math.abs(last.lng - end.lng) > 1e-8) {
		points.push(new LatLng(end.lat, end.lng));
	}

	return { distance: totalKm, points };
}

export function distanceBetweenMultiplePoints(wayPoints: LatLng[]) {
	let totalDistance = 0;
	const allPoints: LatLng[] = [];
	for (let i = 0; i < wayPoints.length - 1; i++) {
		const { points, distance } = pointsEveryMetersBetween(wayPoints[i], wayPoints[i + 1]);
		totalDistance += distance;
		allPoints.push(...points);
	}
	return { distance: totalDistance, points: allPoints };
}
