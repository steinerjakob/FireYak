import { beforeEach, describe, expect, it, vi } from 'vitest';
import { distanceTo } from '@/types/geo';
import type { BasemapCoverage, ObstacleData, RoadLine } from '@/types/obstacles';
import { emptyObstacleData } from '@/mapHandler/obstacleDecode';

// A synthetic window instead of tiles: one straight road, no DEM. The coverage
// is set per test (the thin-buildings flag is what this file is about).
let coverage: BasemapCoverage;
let obstacles: ObstacleData;
vi.mock('@/mapHandler/obstacleGeometry', () => ({
	getObstaclesForBounds: async () => ({ ...obstacles, coverage })
}));
vi.mock('@/helper/demElevation', () => ({
	loadRoutingHeights: async () => null,
	isCompleteRoutingRaster: () => true,
	sampleRouteElevations: async () => null
}));

const { computeNearbyDistances, getRoutedPath, invalidateRoutingContext } =
	await import('@/mapHandler/nearbyRouting');
const { routeChips } = await import('@/helper/routeLabel');

const LAT = 48;
const LNG = 15;
const M_PER_DEG_LAT = 110_540;
const mPerDegLng = Math.cos((LAT * Math.PI) / 180) * 111_320;
const at = (xM: number, yM: number) => ({
	lng: LNG + xM / mPerDegLng,
	lat: LAT + yM / M_PER_DEG_LAT
});

function road(...points: [number, number][]): RoadLine {
	const pts = points.map(([x, y]) => [at(x, y).lng, at(x, y).lat] as [number, number]);
	return {
		bbox: [
			Math.min(...pts.map((p) => p[0])),
			Math.min(...pts.map((p) => p[1])),
			Math.max(...pts.map((p) => p[0])),
			Math.max(...pts.map((p) => p[1]))
		],
		points: pts,
		kind: 'minor_road',
		kindDetail: 'residential',
		isBridge: false,
		isTunnel: false
	};
}

function fullCoverage(thinBuildingTiles = 0): BasemapCoverage {
	const layer = { tiles: 1, features: 1 };
	return {
		basemap: 'full',
		truncated: false,
		missingTiles: 0,
		totalTiles: 1,
		layers: { buildings: layer, roads: layer, landuse: layer, water: layer, earth: layer },
		thinBuildingTiles
	};
}

// An L-shaped road: origin and target sit next to its two ends, so the road
// route is the long way round and the optimized route cuts across.
const origin = at(0, 10);
const target = at(200, 200);

beforeEach(() => {
	obstacles = { ...emptyObstacleData(), roads: [road([0, 0], [200, 0], [200, 210])] };
	invalidateRoutingContext();
});

describe('thin building data safeguard (plan section 6.11)', () => {
	it('optimized over a flagged tile routes on roads, says why and marks the map data partial', async () => {
		coverage = fullCoverage(1);
		const route = await getRoutedPath(origin, target, { mode: 'optimized', profile: false });
		expect(route.routed).toBe(true);
		expect(route.fallback).toBe('thinBuildings');
		expect(route.coverage.basemap).toBe('partial');
		// Along the road (about 200 + 200 m), not the 283 m diagonal.
		expect(route.meters).toBeGreaterThan(380);
		const chips = routeChips(route, null, { coverage: true }).map((c) => c.key);
		expect(chips).toContain('route.fallback.thinBuildings');
		expect(chips).toContain('route.incomplete');
	});

	it('the list falls back the same way, with the same metres as the line', async () => {
		coverage = fullCoverage(1);
		const [listed] = await computeNearbyDistances(origin, [target], [distanceTo(origin, target)], {
			mode: 'optimized',
			profile: false
		});
		const line = await getRoutedPath(origin, target, { mode: 'optimized', profile: false });
		expect(listed.fallback).toBe('thinBuildings');
		expect(Math.abs(listed.routedDistance! - line.meters)).toBeLessThanOrEqual(0.5);
	});

	it('without the flag optimized cuts across and reports the road-only length', async () => {
		coverage = fullCoverage(0);
		const route = await getRoutedPath(origin, target, { mode: 'optimized', profile: false });
		expect(route.fallback).toBeNull();
		expect(route.coverage.basemap).toBe('full');
		expect(route.meters).toBeLessThan(320);
		expect(route.offRoadMeters).toBeGreaterThan(200);
		expect(route.roadOnlyMeters).toBeGreaterThan(380);
		expect(route.coverage.barriers).toBe('unknown');
	});

	it('roads mode is unaffected by the flag', async () => {
		coverage = fullCoverage(1);
		const route = await getRoutedPath(origin, target, { mode: 'roads', profile: false });
		expect(route.fallback).toBeNull();
		expect(route.roadOnlyMeters).toBeNull();
	});
});

describe('defaults', () => {
	it('the default options route in optimized mode', async () => {
		coverage = fullCoverage(0);
		const route = await getRoutedPath(origin, target);
		expect(route.meters).toBeLessThan(320);
	});
});
