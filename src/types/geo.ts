export interface GeoPoint {
	lat: number;
	lng: number;
}

export interface GeoBounds {
	south: number;
	west: number;
	north: number;
	east: number;
}

const R = 6371000; // Earth radius in meters

export function distanceTo(from: GeoPoint, to: GeoPoint): number {
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(to.lat - from.lat);
	const dLng = toRad(to.lng - from.lng);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function boundsContains(bounds: GeoBounds, point: GeoPoint): boolean {
	return (
		point.lat >= bounds.south &&
		point.lat <= bounds.north &&
		point.lng >= bounds.west &&
		point.lng <= bounds.east
	);
}
