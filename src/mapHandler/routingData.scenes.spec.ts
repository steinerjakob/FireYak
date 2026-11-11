import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { distanceTo, type GeoPoint } from '@/types/geo';
import { createTileFetchers } from '@/offline/tileFetchers';
import {
	configureRoutingIO,
	invalidateRoutingContext,
	routeNearby,
	routePath,
	type HoseRoute,
	type NearbyDistanceResult
} from '@/mapHandler/hoseRoutingCore';
import { invalidateObstacleCache } from '@/mapHandler/obstacleTiles';
import { invalidateDemCache } from '@/helper/demTiles';
import {
	ARRIVAL_COALESCE_MS,
	RouteFreshness,
	isRouteDataComplete,
	notifyRoutingDataArrived,
	onRoutingDataArrived,
	resetRoutingData
} from '@/mapHandler/routingData';
import { ROUTING_DATA_BUDGET_MS } from '@/helper/routingBudget';
import {
	decodeDemWebp,
	fixtureFetcher,
	fixturesPresent,
	loadScene,
	type RoutingScene
} from '@/testing/routingFixtures';

/**
 * The cold start seen in the browser after phase 5 (plan §6.9, phase 7): the
 * nearby list is solved before the z14 routing DEM arrives (1.5 s budget), so
 * at Innsbruck "500 m north" it showed ~526 m straight down the scarp while
 * the line drawn moments later (DEM there by then) showed ~1,352 m. With the
 * routing cache and `routingDataArrived` the list recomputes silently and
 * list = line again. The basemap answers at once, the DEM after 5 s.
 */

const DEM_DELAY_MS = 5000;

describe.skipIf(!fixturesPresent)(
	'cold start: the list converges with the line once the DEM lands',
	() => {
		let scene: RoutingScene;
		let vehicle: GeoPoint;
		let target: GeoPoint;
		let straight: number;
		const options = { mode: 'optimized' as const };
		let stopEvents: () => void = () => undefined;
		const events: number[] = [];

		beforeAll(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
			resetRoutingData();
			scene = loadScene('5-innsbruck');
			vehicle = scene.rings!.find((r) => r.radius === 500 && r.bearing === 0)!.vehicle;
			target = scene.anchor;
			straight = distanceTo(vehicle, target);
			const fixtures = fixtureFetcher(scene);
			const cache = new Map<string, ArrayBuffer>();
			const key = (s: string, z: number, x: number, y: number) => `${s}/${z}/${x}/${y}`;
			const fetchers = createTileFetchers({
				areaStore: { get: async () => null, has: async () => false, put: async () => undefined },
				routingCache: {
					get: async (s, z, x, y) => cache.get(key(s, z, x, y))?.slice(0) ?? null,
					has: (s, z, x, y) => cache.has(key(s, z, x, y)),
					put: async (s, z, x, y, b) => void cache.set(key(s, z, x, y), b.slice(0)),
					whenReady: async () => undefined
				},
				network: async (s, z, x, y) => {
					const bytes = await fixtures(s, z, x, y);
					if (!bytes) throw new Error('404');
					if (s === 'terrain') await new Promise((r) => setTimeout(r, DEM_DELAY_MS));
					return bytes;
				},
				insideDownloadedArea: async () => false,
				isOnline: () => true,
				onArrived: () => notifyRoutingDataArrived('tile')
			});
			configureRoutingIO({ fetchTile: fetchers.fetchRoutingTile, decodeDem: decodeDemWebp });
			invalidateObstacleCache();
			invalidateDemCache();
			invalidateRoutingContext();
			stopEvents = onRoutingDataArrived((d) => events.push(d.tiles));
		});

		afterAll(() => {
			stopEvents();
			vi.useRealTimers();
		});

		/** Runs `work` while advancing fake time in small steps until it settles. */
		async function settle<T>(work: Promise<T>, maxMs = 10_000): Promise<T> {
			let done = false;
			let value!: T;
			void work.then((v) => {
				done = true;
				value = v;
			});
			for (let t = 0; t < maxMs && !done; t += 50) await vi.advanceTimersByTimeAsync(50);
			expect(done).toBe(true);
			return value;
		}

		it('reproduces the mismatch, then converges after the silent recompute', async () => {
			const freshness = new RouteFreshness();

			// 1. Cold list: returns within the budget, without the slope raster.
			const t0 = Date.now();
			const listStart = freshness.begin();
			const [cold] = await settle<NearbyDistanceResult[]>(
				routeNearby(vehicle, [target], [straight], options)
			);
			expect(Date.now() - t0).toBeLessThanOrEqual(ROUTING_DATA_BUDGET_MS + 100);
			expect(cold.route).not.toBeNull();
			expect(cold.route!.coverage.slope).not.toBe('z14');
			expect(isRouteDataComplete(cold.route)).toBe(false);
			// Straight down the scarp (the browser showed 526 m).
			expect(cold.routedDistance!).toBeLessThan(1000);
			freshness.finish(listStart, isRouteDataComplete(cold.route));

			// 2. The DEM lands: routingDataArrived, and the list asks for a recompute.
			await vi.advanceTimersByTimeAsync(DEM_DELAY_MS + ARRIVAL_COALESCE_MS);
			expect(events.length).toBeGreaterThan(0);
			expect(freshness.needsRecompute()).toBe(true);

			// 3. The line drawn now sees the DEM: the old mismatch.
			const line = await settle<HoseRoute>(routePath(vehicle, target, options));
			expect(line.coverage.slope).toBe('z14');
			expect(Math.abs(line.meters - cold.routedDistance!)).toBeGreaterThan(300);

			// 4. The silent recompute: list, label (line) and pump line show one number.
			const recomputeStart = freshness.begin();
			const [warm] = await settle<NearbyDistanceResult[]>(
				routeNearby(vehicle, [target], [straight], options)
			);
			freshness.finish(recomputeStart, isRouteDataComplete(warm.route));
			expect(isRouteDataComplete(warm.route)).toBe(true);
			expect(freshness.needsRecompute()).toBe(false);
			expect(warm.routedDistance!).toBeGreaterThanOrEqual(1250);
			expect(warm.routedDistance!).toBeLessThanOrEqual(1450);
			// The line of step 3 was an A* on the reloaded grid (the list's field was
			// dropped with the new heights): the same route up to the field's escape zones.
			expect(Math.abs(warm.routedDistance! - line.meters)).toBeLessThanOrEqual(0.02 * line.meters);
			// What the app shows after the recompute: the line redrawn from the list's field.
			const redrawn = await settle<HoseRoute>(routePath(vehicle, target, options));
			expect(Math.abs(redrawn.meters - warm.routedDistance!)).toBeLessThanOrEqual(0.5);
			const pump = await settle<HoseRoute>(
				routePath(vehicle, target, { ...options, compareRoads: false })
			);
			expect(Math.abs(pump.meters - warm.routedDistance!)).toBeLessThanOrEqual(0.5);
		});
	}
);
