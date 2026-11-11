import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeMvt } from '@/testing/mvt';
import { createTileFetchers } from '@/offline/tileFetchers';
import { tileToBounds } from '@/offline/tileMath';
import {
	configureRoutingIO,
	invalidateRoutingContext,
	routePath,
	type HoseRoute
} from '@/mapHandler/hoseRoutingCore';
import { invalidateObstacleCache } from '@/mapHandler/obstacleTiles';
import {
	ARRIVAL_COALESCE_MS,
	RouteFreshness,
	isRouteDataComplete,
	lastRoutingDataArrivalAt,
	notifyRoutingDataArrived,
	onRoutingDataArrived,
	resetRoutingData
} from '@/mapHandler/routingData';
import { ROUTING_DATA_BUDGET_MS } from '@/helper/routingBudget';

// Synthetic z15 tiles: one road across the middle of each tile.
const TILE = encodeMvt([
	{
		name: 'roads',
		features: [
			{
				type: 2,
				geometry: [
					[
						[0, 2048],
						[4096, 2048]
					]
				],
				properties: { kind: 'minor_road', kind_detail: 'residential' }
			}
		]
	}
]);
const X = 17772;
const Y = 11371;
const corner = tileToBounds(15, X, Y); // origin and target straddle its south-east corner
const origin = { lat: corner.south + 0.0009, lng: corner.east - 0.0013 };
const target = { lat: corner.south - 0.0009, lng: corner.east + 0.0013 };
const SLOW = `protomaps/15/${X + 1}/${Y + 1}`;

function setUpFetchers(slowMs: number) {
	const landed = new Set<string>();
	const fetchers = createTileFetchers({
		areaStore: { get: async () => null, has: async () => false, put: async () => undefined },
		routingCache: {
			// Every basemap tile is local except the slow one until it landed.
			get: async (s, z, x, y) => {
				const k = `${s}/${z}/${x}/${y}`;
				return s === 'protomaps' && (k !== SLOW || landed.has(k)) ? TILE.slice(0) : null;
			},
			has: (s, z, x, y) => landed.has(`${s}/${z}/${x}/${y}`),
			put: async (s, z, x, y) => void landed.add(`${s}/${z}/${x}/${y}`),
			whenReady: async () => undefined
		},
		network: (source) =>
			source === 'protomaps'
				? new Promise((resolve) => setTimeout(() => resolve(TILE.slice(0)), slowMs))
				: Promise.reject(new Error('no DEM here')),
		insideDownloadedArea: async () => false,
		isOnline: () => true,
		onArrived: () => notifyRoutingDataArrived('tile')
	});
	configureRoutingIO({
		fetchTile: fetchers.fetchRoutingTile,
		decodeDem: async () => {
			throw new Error('no DEM in this spec');
		}
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	resetRoutingData();
	invalidateObstacleCache();
	invalidateRoutingContext();
});
afterEach(() => vi.useRealTimers());

describe('never block on remote data (plan section 6.9)', () => {
	it('with a tile that answers after 5 s the route returns within 1.5 s, partial; routingDataArrived fires when it lands', async () => {
		setUpFetchers(5000);
		const events: number[] = [];
		const stop = onRoutingDataArrived((detail) => events.push(detail.tiles));
		const freshness = new RouteFreshness();

		const startedAt = freshness.begin();
		let route: HoseRoute | undefined;
		void routePath(origin, target, { mode: 'optimized', profile: false }).then((r) => (route = r));
		await vi.advanceTimersByTimeAsync(ROUTING_DATA_BUDGET_MS);
		expect(route).toBeDefined();
		expect(route!.routed).toBe(true);
		expect(route!.coverage.basemap).toBe('partial');
		expect(isRouteDataComplete(route!)).toBe(false);
		freshness.finish(startedAt, isRouteDataComplete(route!));
		expect(freshness.needsRecompute()).toBe(false);
		expect(events).toEqual([]);

		await vi.advanceTimersByTimeAsync(5000 - ROUTING_DATA_BUDGET_MS + ARRIVAL_COALESCE_MS);
		expect(events).toEqual([1]);
		expect(freshness.needsRecompute()).toBe(true);

		// The silent recompute finds the tile in the cache at once.
		let again: HoseRoute | undefined;
		void routePath(origin, target, { mode: 'optimized', profile: false }).then((r) => (again = r));
		await vi.advanceTimersByTimeAsync(0);
		expect(again?.coverage.basemap).toBe('full');
		stop();
	});

	it('a complete result never asks for a recompute, an incomplete one only after an arrival', () => {
		const freshness = new RouteFreshness();
		const t = freshness.begin(1000);
		freshness.finish(t, true);
		notifyRoutingDataArrived('tile');
		expect(freshness.needsRecompute()).toBe(false);
		const u = freshness.begin(lastRoutingDataArrivalAt() + 1);
		freshness.finish(u, false);
		expect(freshness.needsRecompute()).toBe(false);
		expect(freshness.needsRecompute(u)).toBe(true);
	});

	it('arrivals within the coalescing window give one event', async () => {
		const counts: [number, number][] = [];
		const stop = onRoutingDataArrived((d) => counts.push([d.tiles, d.outlines]));
		notifyRoutingDataArrived('tile');
		notifyRoutingDataArrived('tile');
		notifyRoutingDataArrived('outline');
		await vi.advanceTimersByTimeAsync(ARRIVAL_COALESCE_MS);
		expect(counts).toEqual([[2, 1]]);
		stop();
	});
});

describe('route data completeness', () => {
	const base = { routed: true } as HoseRoute;
	const with_ = (coverage: Partial<HoseRoute['coverage']>) =>
		({
			...base,
			coverage: { basemap: 'full', dem: 'z14', slope: 'z14', barriers: 'unknown', ...coverage }
		}) as HoseRoute;

	it('needs the full basemap, the z14 slope raster (on the grid) and a z14 profile (when asked)', () => {
		expect(isRouteDataComplete(with_({}))).toBe(true);
		expect(isRouteDataComplete(with_({ slope: null, dem: 'off' }))).toBe(true);
		expect(isRouteDataComplete(with_({ basemap: 'partial' }))).toBe(false);
		expect(isRouteDataComplete(with_({ slope: 'none' }))).toBe(false);
		expect(isRouteDataComplete(with_({ slope: 'z12' }))).toBe(false);
		expect(isRouteDataComplete(with_({ dem: 'none' }))).toBe(false);
		expect(isRouteDataComplete(null)).toBe(true);
	});
});
