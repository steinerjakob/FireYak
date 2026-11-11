import { describe, expect, it } from 'vitest';
import type { GeoPoint } from '@/types/geo';
import type { RoadLine } from '@/types/obstacles';
import {
	BRIDGE_APPROACH_M,
	OFF_ROAD_NEAR_M,
	classifyRoute,
	deckHeights,
	isAlongBridge,
	isNearAnyRoad,
	length3d,
	resampleForProfile,
	slopeNotRecommended,
	splitByRuns,
	type RouteProfile
} from '@/helper/routeProfile';

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

describe('length3d (plan section 6.4: the reported metres)', () => {
	it('the 3D length of a known inclined line is correct to 0.1 %', () => {
		// 300 m due east with a bend, climbing 45 m evenly: sqrt(300^2 + 45^2) = 303.36 m.
		const stations = resampleForProfile([at(0, 0), at(120, 0), at(120, 180)]);
		const heights = stations.s.map((s) => 200 + 0.15 * s);
		const expected = Math.hypot(stations.total, 45 * (stations.total / 300));
		expect(Math.abs(length3d(stations.s, heights) / expected - 1)).toBeLessThan(0.001);
		expect(Math.abs(stations.total - 300)).toBeLessThan(0.5);
	});

	it('equals the plan length on flat ground', () => {
		const stations = resampleForProfile([at(0, 0), at(0, 77)]);
		expect(
			length3d(
				stations.s,
				stations.s.map(() => 5)
			)
		).toBeCloseTo(stations.total, 9);
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
			kind: 'minor_road',
			kindDetail: 'residential',
			isBridge: false,
			isTunnel: false
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
		// The metres along the line go with each line (map highlight of a stretch).
		expect([lines[1].from, lines[1].to]).toEqual([50, 150]);
	});
});

describe('isNearAnyRoad (off-road test without cost-grid classes)', () => {
	const road: RoadLine = {
		bbox: [at(0, 0).lng, at(0, 0).lat, at(100, 0).lng, at(100, 0).lat],
		points: [
			[at(0, 0).lng, at(0, 0).lat],
			[at(100, 0).lng, at(100, 0).lat]
		],
		kind: 'minor_road',
		kindDetail: 'residential',
		isBridge: false,
		isTunnel: false
	};

	it('is near within 6 m of the centreline, also past the ends, and not beyond', () => {
		expect(isNearAnyRoad(at(50, 5.9), [road])).toBe(true);
		expect(isNearAnyRoad(at(50, 6.2), [road])).toBe(false);
		expect(isNearAnyRoad(at(104, 3), [road])).toBe(true);
		expect(isNearAnyRoad(at(108, 0), [road])).toBe(false);
		expect(isNearAnyRoad(at(50, 7.5), [road], 8)).toBe(true);
		expect(isNearAnyRoad(at(50, 0), [])).toBe(false);
	});
});

describe('classifyRoute: signed steepest grade per run (details card)', () => {
	it('uphill along the line is positive, downhill negative', () => {
		const up = steepRuns(rampProfile(40, 0.3), 1)[0];
		expect(up.gradePct).toBeCloseTo(30, 6);
		const down = steepRuns(rampProfile(40, -0.6), 2)[0];
		expect(down.gradePct).toBeCloseTo(-60, 6);
	});

	it('no grade without heights', () => {
		const stations = resampleForProfile([at(0, 0), at(0, 100)]);
		const p = classifyRoute(stations, null, { demZoom: null, isOffRoad: onRoad });
		expect(p.segments[0].gradePct).toBeUndefined();
	});
});

/** A bridge way along the y axis from `y0` to `y1` metres. */
function bridgeLine(y0: number, y1: number, x = 0): RoadLine {
	const a = at(x, y0);
	const b = at(x, y1);
	return {
		bbox: [
			Math.min(a.lng, b.lng),
			Math.min(a.lat, b.lat),
			Math.max(a.lng, b.lng),
			Math.max(a.lat, b.lat)
		],
		points: [
			[a.lng, a.lat],
			[b.lng, b.lat]
		],
		kind: 'major_road',
		kindDetail: 'secondary',
		isBridge: true,
		isTunnel: false
	};
}

/**
 * 200 m due north, flat at 240 m, with the DEM dipping 4.4 m into a river bed
 * between 85 and 120 m (the Melk under the Hauptstraße bridge, 100-105 m).
 */
function riverDip(s: number): number {
	if (s <= 85 || s >= 120) return 240;
	return 240 - 4.4 * Math.sin(((s - 85) / 35) * Math.PI);
}

describe('classifyRoute on a bridge (plan section 6.8: cost and display agree)', () => {
	const stations = resampleForProfile([at(0, 0), at(0, 200)]);
	const heights = stations.s.map(riverDip);

	it('without the bridge test the DEM dip under the deck shows amber', () => {
		const p = classifyRoute(stations, heights, { demZoom: 14, isOffRoad: onRoad });
		expect(steepRuns(p, 1).length).toBeGreaterThan(0);
	});

	it('on the bridge (deck 88-117 m) no amber or red, and no "not recommended"', () => {
		const bridges = [bridgeLine(88, 117)];
		const p = classifyRoute(stations, heights, {
			demZoom: 14,
			isOffRoad: onRoad,
			isOnBridge: (a, b) => isAlongBridge(a, b, bridges)
		});
		expect(p.segments.filter((r) => r.steep > 0)).toEqual([]);
		expect(p.metersOver25).toBe(0);
		expect(slopeNotRecommended(p)).toBe(false);
		// Climb and 3D length still come from the raw DEM.
		expect(p.heights).toEqual(heights);
	});

	it('a line passing under a bridge keeps its steepness', () => {
		// The bridge crosses the route at right angles at 100 m.
		const across: RoadLine = {
			...bridgeLine(0, 0),
			points: [
				[at(-20, 100).lng, at(-20, 100).lat],
				[at(20, 100).lng, at(20, 100).lat]
			],
			bbox: [at(-20, 100).lng, at(-20, 100).lat, at(20, 100).lng, at(20, 100).lat]
		};
		const p = classifyRoute(stations, heights, {
			demZoom: 14,
			isOffRoad: onRoad,
			isOnBridge: (a, b) => isAlongBridge(a, b, [across])
		});
		expect(steepRuns(p, 1).length).toBeGreaterThan(0);
	});

	it('a real slope beyond the approach margin still shows', () => {
		// Bridge 20-40 m; a 30 % ramp from 100 m on is far outside its margin.
		const ramp = stations.s.map((s) => 100 + Math.min(Math.max(s - 100, 0), 40) * 0.3);
		const bridges = [bridgeLine(20, 40)];
		const p = classifyRoute(stations, ramp, {
			demZoom: 14,
			isOffRoad: onRoad,
			isOnBridge: (a, b) => isAlongBridge(a, b, bridges)
		});
		expect(steepRuns(p, 1)).toHaveLength(1);
	});
});

describe('deckHeights', () => {
	it('interpolates across the bridge and its approach margin, leaves the rest', () => {
		const s = [0, 10, 20, 30, 40, 50, 60, 70, 80];
		const h = [5, 5, 5, 1, 0, 1, 9, 9, 9];
		// Piece 3-4 (30-40 m) on the bridge; margin 10 m: stations 20..50 are bridged.
		const onBridge = [false, false, false, true, false, false, false, false];
		expect(BRIDGE_APPROACH_M).toBe(10);
		const out = deckHeights(s, h, onBridge);
		expect(out.slice(0, 2)).toEqual([5, 5]);
		expect(out.slice(6)).toEqual([9, 9, 9]);
		// Between h(10 m) = 5 and h(60 m) = 9.
		expect(out[2]).toBeCloseTo(5.8, 9);
		expect(out[3]).toBeCloseTo(6.6, 9);
		expect(out[4]).toBeCloseTo(7.4, 9);
		expect(out[5]).toBeCloseTo(8.2, 9);
	});

	it('holds the one outside height when the bridge reaches a route end', () => {
		expect(deckHeights([0, 5, 10, 30], [3, 1, 2, 7], [true, false, false])).toEqual([7, 7, 7, 7]);
		expect(deckHeights([0, 20, 25, 30], [4, 1, 2, 9], [false, false, true])).toEqual([4, 4, 4, 4]);
	});

	it('returns the input without a bridge', () => {
		const h = [1, 2, 3];
		expect(deckHeights([0, 5, 10], h, [false, false])).toBe(h);
	});
});

describe('isAlongBridge', () => {
	const bridge = bridgeLine(0, 35);
	it('a piece on the deck, within 6 m and parallel, is on the bridge', () => {
		expect(isAlongBridge(at(0, 10), at(0, 15), [bridge])).toBe(true);
		expect(isAlongBridge(at(4, 10), at(5, 15), [bridge])).toBe(true);
	});
	it('beside it (> 6 m), crossing it or past its end is not', () => {
		expect(isAlongBridge(at(7, 10), at(7, 15), [bridge])).toBe(false);
		expect(isAlongBridge(at(-3, 17), at(3, 18), [bridge])).toBe(false);
		expect(isAlongBridge(at(0, 45), at(0, 50), [bridge])).toBe(false);
		expect(isAlongBridge(at(0, 10), at(0, 15), [])).toBe(false);
	});
});
