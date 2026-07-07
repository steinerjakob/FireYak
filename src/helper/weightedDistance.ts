import { GeoPoint, distanceTo } from '@/types/geo';
import { BuildingPolygon, RoadLine, ObstacleData } from '@/types/obstacles';
import { pointsEveryMetersBetween } from '@/helper/distanceCalculation';

/**
 * Tuning surface for the road-aware weighted distance heuristic. Adjust these
 * to change how strongly crossing a building is penalized, how strongly
 * following a road is rewarded, and how the sampling/proximity granularity
 * behaves.
 */
export const SAMPLE_STEP_M = 10;
export const BUILDING_WEIGHT = 4;
export const ROAD_WEIGHT = 0.75;
export const ROAD_HALF_WIDTH_M = 6;

/** Meters per degree of latitude, used for a local equirectangular projection. */
const METERS_PER_DEG_LAT = 110540;
/** Meters per degree of longitude at the equator; scaled by cos(latitude) elsewhere. */
const METERS_PER_DEG_LNG_AT_EQUATOR = 111320;

function toRadians(deg: number): number {
	return (deg * Math.PI) / 180;
}

/**
 * Checks whether a point falls within a bounding box, using cheap lng/lat
 * comparisons. Used as a prefilter before more expensive ring/segment tests.
 *
 * @param {FeatureBBox} bbox - Bounding box as [west, south, east, north].
 * @param {GeoPoint} point - The point to test.
 * @return {boolean} True if the point lies within (inclusive) the bbox.
 */
function bboxContains(bbox: [number, number, number, number], point: GeoPoint): boolean {
	const [west, south, east, north] = bbox;
	return point.lng >= west && point.lng <= east && point.lat >= south && point.lat <= north;
}

/**
 * Ray-casting point-in-ring test. Works whether the ring repeats its first
 * point at the end (closed) or not, since a degenerate closing edge
 * contributes zero crossings either way.
 *
 * @param {GeoPoint} point - The point to test.
 * @param {[number, number][]} ring - Ring vertices as [lng, lat].
 * @return {boolean} True if the point is inside the ring.
 */
function pointInRing(point: GeoPoint, ring: [number, number][]): boolean {
	let inside = false;
	const n = ring.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = ring[i][0];
		const yi = ring[i][1];
		const xj = ring[j][0];
		const yj = ring[j][1];
		const intersects =
			yi > point.lat !== yj > point.lat &&
			point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
		if (intersects) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * Tests whether a point is inside any of the given building polygons. A
 * point counts as inside a polygon when it falls within its outer ring and
 * not within any of its holes. Each building's bbox is checked first as a
 * cheap prefilter.
 *
 * @param {GeoPoint} point - The point to test.
 * @param {BuildingPolygon[]} buildings - Candidate building footprints.
 * @return {boolean} True if the point is inside any building.
 */
export function isInsideAnyBuilding(point: GeoPoint, buildings: BuildingPolygon[]): boolean {
	for (const building of buildings) {
		if (!bboxContains(building.bbox, point)) {
			continue;
		}
		const [outerRing, ...holes] = building.rings;
		if (!outerRing || !pointInRing(point, outerRing)) {
			continue;
		}
		const inHole = holes.some((hole) => pointInRing(point, hole));
		if (!inHole) {
			return true;
		}
	}
	return false;
}

/**
 * Distance in meters from a point to a line segment, computed in a local
 * equirectangular projection centered on the query point (so the point
 * itself is the origin). Longitude is scaled by cos(latitude) of the query
 * point to approximate meters.
 *
 * @param {GeoPoint} point - The query point (used as the projection origin).
 * @param {[number, number]} a - Segment start as [lng, lat].
 * @param {[number, number]} b - Segment end as [lng, lat].
 * @return {number} Distance in meters from the point to the segment.
 */
function distanceToSegmentMeters(
	point: GeoPoint,
	a: [number, number],
	b: [number, number]
): number {
	const cosLat = Math.cos(toRadians(point.lat));
	const toLocal = (p: [number, number]) => ({
		x: (p[0] - point.lng) * cosLat * METERS_PER_DEG_LNG_AT_EQUATOR,
		y: (p[1] - point.lat) * METERS_PER_DEG_LAT
	});
	const ax = toLocal(a);
	const bx = toLocal(b);
	const dx = bx.x - ax.x;
	const dy = bx.y - ax.y;
	const lengthSq = dx * dx + dy * dy;
	const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (-ax.x * dx + -ax.y * dy) / lengthSq));
	const closestX = ax.x + t * dx;
	const closestY = ax.y + t * dy;
	return Math.sqrt(closestX * closestX + closestY * closestY);
}

/**
 * Tests whether a point lies within `maxDistanceM` meters of any of the
 * given road polylines. Each road's bbox is expanded by the threshold
 * distance (converted to degrees at the query latitude) as a cheap
 * prefilter, and the search short-circuits as soon as any road segment is
 * within range.
 *
 * @param {GeoPoint} point - The point to test.
 * @param {RoadLine[]} roads - Candidate road centerlines.
 * @param {number} [maxDistanceM] - Proximity threshold in meters.
 * @return {boolean} True if the point is near any road.
 */
export function isNearAnyRoad(
	point: GeoPoint,
	roads: RoadLine[],
	maxDistanceM: number = ROAD_HALF_WIDTH_M
): boolean {
	const cosLat = Math.cos(toRadians(point.lat));
	const latExpansion = maxDistanceM / METERS_PER_DEG_LAT;
	const lngExpansion = maxDistanceM / (METERS_PER_DEG_LNG_AT_EQUATOR * cosLat);

	for (const road of roads) {
		const [west, south, east, north] = road.bbox;
		const expandedBbox: [number, number, number, number] = [
			west - lngExpansion,
			south - latExpansion,
			east + lngExpansion,
			north + latExpansion
		];
		if (!bboxContains(expandedBbox, point)) {
			continue;
		}
		for (let i = 0; i < road.points.length - 1; i++) {
			const distance = distanceToSegmentMeters(point, road.points[i], road.points[i + 1]);
			if (distance <= maxDistanceM) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Computes a straight-line distance between two points, weighted by what the
 * line crosses: segments that cross a building are penalized
 * (`BUILDING_WEIGHT`), segments that run alongside a road are rewarded
 * (`ROAD_WEIGHT`), and everything else counts at face value. The line is
 * sampled every `SAMPLE_STEP_M` meters and each resulting segment is
 * classified by its midpoint.
 *
 * Pure function: no store, map, or network dependencies.
 *
 * @param {GeoPoint} from - Line start.
 * @param {GeoPoint} to - Line end.
 * @param {ObstacleData} obstacles - Buildings and roads to weigh the line against.
 * @return {number} Weighted distance in meters.
 */
export function effectiveDistanceMeters(
	from: GeoPoint,
	to: GeoPoint,
	obstacles: ObstacleData
): number {
	const { points } = pointsEveryMetersBetween(from, to, SAMPLE_STEP_M);
	let total = 0;

	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		const segmentLength = distanceTo(a, b);
		if (segmentLength === 0) {
			continue;
		}

		const midpoint: GeoPoint = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };

		let weight = 1;
		if (isInsideAnyBuilding(midpoint, obstacles.buildings)) {
			weight = BUILDING_WEIGHT;
		} else if (isNearAnyRoad(midpoint, obstacles.roads, ROAD_HALF_WIDTH_M)) {
			weight = ROAD_WEIGHT;
		}

		total += segmentLength * weight;
	}

	return total;
}
