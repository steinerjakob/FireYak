import { beforeEach, describe, expect, it, vi } from 'vitest';
import { distanceTo } from '@/types/geo';
import type { BasemapCoverage, ObstacleData, RoadLine } from '@/types/obstacles';
import { emptyObstacleData } from '@/mapHandler/obstacleDecode';

// A synthetic window instead of tiles: one straight road, no DEM. The coverage
// is set per test (the thin-buildings flag is what this file is about).
let coverage: BasemapCoverage;
let obstacles: ObstacleData;
// No `Worker` in Node: the facade routes on the main thread (the same solve).
vi.mock('@/offline/offlineProtocol', () => ({
	fetchTileCacheFirst: async () => null,
	fetchRoutingTile: async () => null
}));
vi.mock('@/mapHandler/obstacleTiles', () => ({
	getObstaclesForBounds: async () => ({ ...obstacles, coverage })
}));
vi.mock('@/helper/demTiles', () => ({
	loadRoutingHeights: async () => null,
	isCompleteRoutingRaster: () => true,
	sampleRouteElevations: async () => null,
	slopeCoverageOf: () => 'none',
	setDemTileFetcher: () => {},
	setDemTileDecoder: () => {},
	decodeTerrariumImage: async () => {
		throw new Error('no DEM in this spec');
	}
}));

const { computeNearbyDistances, getRoutedPath, invalidateRoutingContext, isRoutingCancelled } =
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

describe('adaptive cell size and the cell cap (plan section 6.10)', () => {
	it('a single path in a small window runs on 4 m cells, the list on 8 m', async () => {
		coverage = fullCoverage(0);
		const line = await getRoutedPath(origin, target, { mode: 'optimized', profile: false });
		expect(line.cellM).toBe(4);
		invalidateRoutingContext();
		const [listed] = await computeNearbyDistances(origin, [target], [distanceTo(origin, target)], {
			mode: 'optimized',
			profile: false
		});
		expect(listed.route!.cellM).toBe(8);
	});

	it('the line after the list stays on the list field: one number for list and line', async () => {
		coverage = fullCoverage(0);
		const options = { mode: 'optimized' as const, profile: false };
		const [listed] = await computeNearbyDistances(
			origin,
			[target],
			[distanceTo(origin, target)],
			options
		);
		const line = await getRoutedPath(origin, target, options);
		expect(line.cellM).toBe(8);
		expect(line.meters).toBe(listed.routedDistance);
	});

	it('a grid over the cell cap routes on the road graph and says so', async () => {
		coverage = fullCoverage(0);
		// 0.5 m cells over a ~500 m window: about a million cells, over the 400k cap.
		const route = await getRoutedPath(origin, target, {
			mode: 'optimized',
			profile: false,
			cellM: 0.5
		});
		expect(route.routed).toBe(true);
		expect(route.fallback).toBe('cellCap');
		expect(route.cellM).toBeNull();
		expect(route.meters).toBeGreaterThan(380);
	});
});

describe('supersession on the main thread (no worker in Node)', () => {
	it('a newer request on the same channel cancels the older one', async () => {
		coverage = fullCoverage(0);
		const options = { mode: 'optimized' as const, profile: false };
		const first = computeNearbyDistances(origin, [target], [283], options, { channel: 'list' });
		const second = computeNearbyDistances(origin, [target], [283], options, { channel: 'list' });
		const [a, b] = await Promise.allSettled([first, second]);
		expect(a.status).toBe('rejected');
		expect(isRoutingCancelled((a as PromiseRejectedResult).reason)).toBe(true);
		expect(b.status).toBe('fulfilled');
		// Other channels and requests without one are left alone.
		const [c, d] = await Promise.allSettled([
			getRoutedPath(origin, target, options, { channel: 'path' }),
			computeNearbyDistances(origin, [target], [283], options, { channel: 'list' })
		]);
		expect(c.status).toBe('fulfilled');
		expect(d.status).toBe('fulfilled');
	});
});
