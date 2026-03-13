export interface GeoPoint {
	lat: number;
	lng: number;
}

export interface GeoBounds {
	north: number;
	south: number;
	east: number;
	west: number;
}

const EARTH_RADIUS_METERS = 6371000;

function toRadians(value: number): number {
	return (value * Math.PI) / 180;
}

export function distanceTo(from: GeoPoint, to: GeoPoint): number {
	const lat1 = toRadians(from.lat);
	const lat2 = toRadians(to.lat);
	const deltaLat = toRadians(to.lat - from.lat);
	const deltaLng = toRadians(to.lng - from.lng);

	const a =
		Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
		Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);

	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

	return EARTH_RADIUS_METERS * c;
}

export function boundsContains(bounds: GeoBounds, point: GeoPoint): boolean {
	const isWithinLatitude = point.lat >= bounds.south && point.lat <= bounds.north;

	const crossesAntimeridian = bounds.west > bounds.east;
	const isWithinLongitude = crossesAntimeridian
		? point.lng >= bounds.west || point.lng <= bounds.east
		: point.lng >= bounds.west && point.lng <= bounds.east;

	return isWithinLatitude && isWithinLongitude;
}
