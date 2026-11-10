import { describe, expect, it, vi } from 'vitest';
import type { GeoPoint } from '@/types/geo';
import type { RoadLine } from '@/types/obstacles';
import {
	OFF_ROAD_NEAR_M,
	classifyRoute,
	resampleForProfile,
	slopeNotRecommended,
	splitByRuns,
	type RouteProfile
} from '@/helper/routeProfile';
import { isNearAnyRoad } from '@/helper/weightedDistance';

// weightedDistance pulls in the elevation helpers, whose DEM module imports the
// MapLibre-backed tile protocol; specs never fetch tiles here.
vi.mock('@/offline/offlineProtocol', () => ({ fetchTileCacheFirst: async () => null }));

const LAT = 48;
const LNG = 15;
// Haversine metres per degree, so `distanceTo` agrees with the local frame.
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const mPerDegLng = Math.cos((LAT * Math.PI) / 180) * M_PER_DEG_LAT;
const at = (xM: number, yM: number): GeoPoint => ({
	lng: LNG + xM / mPerDegLng,
	lat: LAT + yM / M_PER_DEG_LAT
});

const onRoad = () => false;

/**
 * A straight 200 m route due north; heights flat at 100 m except a ramp of
 * `rampM` metres at `grade` starting 50 m in.
 */
function rampProfile(rampM: number, grade: number, demZoom: number | null = 14): RouteProfile {
	const stations = resampleForProfile([at(0, 0), at(0, 200)]);
	const heights = stations.s.map((s) => 100 + Math.min(Math.max(s - 50, 0), rampM) * grade);
	return classifyRoute(stations, heights, { demZoom, isOffRoad: onRoad });
}

const steepRuns = (p: RouteProfile, cls: number) => p.segments.filter((r) => r.steep === cls);

describe('resampleForProfile', () => {
	it('places stations every 5 m and at every vertex', () => {
		const stations = resampleForProfile([at(0, 0), at(0, 12), at(0, 20)]);
		expect(stations.s.map((s) => Math.round(s * 100) / 100)).toEqual([0, 5, 10, 12, 17, 20]);
		expect(stations.seg).toEqual([0, 0, 0, 1, 1]);
		expect(stations.total).toBeCloseTo(20, 1);
	});
});

describe('classifyRoute: steep classes and warning triggers (plan section 6.8)', () => {
	it('40 m at 30 %: one amber run', () => {
		const p = rampProfile(40, 0.3);
		expect(steepRuns(p, 1)).toHaveLength(1);
		expect(steepRuns(p, 2)).toHaveLength(0);
		const run = steepRuns(p, 1)[0];
		expect(run.to - run.from).toBeCloseTo(40, 0);
		expect(slopeNotRecommended(p)).toBe(false);
	});

	it('8 m at 55 %: no red (below the 10 m minimum)', () => {
		const p = rampProfile(8, 0.55);
		expect(steepRuns(p, 2)).toHaveLength(0);
		expect(p.metersOver50).toBe(0);
	});

	it('12 m at 55 %: a red run and "not recommended"', () => {
		const p = rampProfile(12, 0.55);
		expect(steepRuns(p, 2)).toHaveLength(1);
		expect(p.metersOver50).toBeGreaterThanOrEqual(10);
		expect(slopeNotRecommended(p)).toBe(true);
	});

	it('60 m at 26 %: "not recommended" (more than 50 m above 25 %)', () => {
		const p = rampProfile(60, 0.26);
		expect(p.metersOver25).toBeCloseTo(60, 0);
		expect(steepRuns(p, 2)).toHaveLength(0);
		expect(slopeNotRecommended(p)).toBe(true);
	});

	it('45 m at 26 %: no chip', () => {
		const p = rampProfile(45, 0.26);
		expect(p.metersOver25).toBeCloseTo(45, 0);
		expect(slopeNotRecommended(p)).toBe(false);
	});

	it('z12-only input at 70 %: amber, never red', () => {
		const p = rampProfile(100, 0.7, 12);
		expect(steepRuns(p, 2)).toHaveLength(0);
		expect(steepRuns(p, 1).length).toBeGreaterThan(0);
		expect(p.metersOver50).toBe(0);
	});

	it('reports the signed climb and the steepest grade', () => {
		const p = rampProfile(40, 0.3);
		expect(p.climbM).toBeCloseTo(12, 6);
		expect(p.maxGradePct).toBeCloseTo(30, 6);
	});

	it('without heights: no steep runs, no climb', () => {
		const stations = resampleForProfile([at(0, 0), at(0, 100)]);
		const p = classifyRoute(stations, null, { demZoom: null, isOffRoad: onRoad });
		expect(p.segments).toHaveLength(1);
		expect(p.segments[0].steep).toBe(0);
		expect(p.climbM).toBeNull();
		expect(p.maxGradePct).toBeNull();
	});
});

describe('classifyRoute: off-road runs', () => {
	it('derives off-road runs from the 6 m road proximity', () => {
		// The road runs along the first 100 m of a 200 m route, then the route leaves it.
		const road: RoadLine = {
			bbox: [LNG, LAT, LNG + 1 / mPerDegLng, LAT + 100 / M_PER_DEG_LAT],
			points: [
				[at(0, 0).lng, at(0, 0).lat],
				[at(0, 100).lng, at(0, 100).lat]
			],
			kind: 'minor_road'
		};
		const stations = resampleForProfile([at(0, 0), at(0, 200)]);
		const p = classifyRoute(stations, null, {
			demZoom: null,
			isOffRoad: (mid) => !isNearAnyRoad(mid, [road], OFF_ROAD_NEAR_M)
		});
		expect(p.segments.map((r) => r.offRoad)).toEqual([false, true]);
		expect(p.segments[0].to).toBeCloseTo(105, 0);
		expect(p.offRoadMeters).toBeCloseTo(95, 0);
	});

	it('merges adjacent pieces of the same class into one run', () => {
		const stations = resampleForProfile([at(0, 0), at(0, 30), at(30, 30), at(30, 60)]);
		const p = classifyRoute(stations, null, { demZoom: null, isOffRoad: onRoad });
		expect(p.segments).toHaveLength(1);
		expect(p.segments[0].from).toBe(0);
		expect(p.segments[0].to).toBeCloseTo(90, 0);
	});

	it('splits the polyline into one line per run', () => {
		const points = [at(0, 0), at(0, 100), at(0, 200)];
		const lines = splitByRuns(points, [
			{ from: 0, to: 50, offRoad: false, steep: 0 },
			{ from: 50, to: 150, offRoad: true, steep: 1 },
			{ from: 150, to: 200, offRoad: false, steep: 0 }
		]);
		expect(lines).toHaveLength(3);
		expect(lines[1].coordinates).toHaveLength(3); // passes the vertex at 100 m
		expect(lines[1].offRoad).toBe(true);
	});
});
