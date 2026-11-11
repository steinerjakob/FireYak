import { describe, expect, it } from 'vitest';
import { MAX_GRID_CELLS } from '@/mapHandler/gridRouting';
import {
	FINE_WINDOW_MAX_M,
	MEDIUM_WINDOW_MAX_M,
	chooseCellSize,
	configureRoutingIO,
	isRoutingCancelled,
	routeNearby,
	routePath,
	windowSizeOf,
	type HoseRoute,
	type NearbyDistanceResult
} from '@/mapHandler/hoseRoutingCore';
import {
	transferablesOf,
	type ToWorkerMessage,
	type FromWorkerMessage
} from '@/mapHandler/hoseRoutingProtocol';
import type { AccessTarget } from '@/mapHandler/waterSourceAccess';

const square = (side: number) => ({ widthM: side, heightM: side });

describe('chooseCellSize (plan section 6.10)', () => {
	it('single paths: 4 m up to 1.2 km, 6 m up to 2.5 km, 8 m beyond', () => {
		expect(chooseCellSize(square(400), 'path')).toBe(4);
		expect(chooseCellSize(square(FINE_WINDOW_MAX_M), 'path')).toBe(4);
		expect(chooseCellSize(square(FINE_WINDOW_MAX_M + 0.1), 'path')).toBe(6);
		expect(chooseCellSize(square(MEDIUM_WINDOW_MAX_M), 'path')).toBe(6);
		expect(chooseCellSize(square(MEDIUM_WINDOW_MAX_M + 0.1), 'path')).toBe(8);
	});

	it('the longer side decides', () => {
		expect(chooseCellSize({ widthM: 300, heightM: 1300 }, 'path')).toBe(6);
		expect(chooseCellSize({ widthM: 2600, heightM: 200 }, 'path')).toBe(8);
	});

	it('the nearby list always uses 8 m', () => {
		expect(chooseCellSize(square(300), 'list')).toBe(8);
		expect(chooseCellSize(square(2000), 'list')).toBe(8);
	});

	it(`above ${MAX_GRID_CELLS} cells it returns cellCap`, () => {
		expect(MAX_GRID_CELLS).toBe(400_000);
		// 5,000 m / 8 m = 625 -> 390,625 cells; 5,064 m -> 633 x 633 = 400,689.
		expect(chooseCellSize(square(5000), 'list')).toBe(8);
		expect(chooseCellSize(square(5000), 'path')).toBe(8);
		expect(chooseCellSize(square(5064), 'list')).toBe('cellCap');
		expect(chooseCellSize(square(5064), 'path')).toBe('cellCap');
		// The finer sizes stay far below the cap at their largest windows.
		expect(Math.ceil(MEDIUM_WINDOW_MAX_M / 6) ** 2).toBeLessThan(MAX_GRID_CELLS / 2);
		expect(Math.ceil(FINE_WINDOW_MAX_M / 4) ** 2).toBeLessThan(MAX_GRID_CELLS / 2);
	});

	it('windowSizeOf measures a window like the grid does', () => {
		const lat = 48;
		const mPerDegLng = Math.cos((lat * Math.PI) / 180) * 111_320;
		const size = windowSizeOf({
			south: lat,
			north: lat + 1000 / 110_540,
			west: 15,
			east: 15 + 500 / mPerDegLng
		});
		expect(size.widthM).toBeCloseTo(500, 0);
		expect(size.heightM).toBeCloseTo(1000, 6);
	});
});

const pond: AccessTarget = {
	kind: 'shore',
	outline: {
		type: 'Polygon',
		coordinates: [
			[
				[15, 48],
				[15.001, 48],
				[15.001, 48.001],
				[15, 48]
			]
		]
	},
	fallback: { lat: 48.0005, lng: 15.0005 }
};

const route: HoseRoute = {
	points: [
		{ lat: 48, lng: 15 },
		{ lat: 48.001, lng: 15.002 }
	],
	meters: 182.4,
	planMeters: 181.9,
	segments: [{ from: 0, to: 181.9, offRoad: true, steep: 1 }],
	climbM: -4.5,
	metersOver25: 12,
	metersOver50: 0,
	maxGradePct: 31,
	offRoadMeters: 181.9,
	staticPressureMaxBar: null,
	pressureLevel: 'ok',
	notRecommended: false,
	roadOnlyMeters: 240,
	demZoom: 14,
	fallback: null,
	coverage: { basemap: 'partial', dem: 'z14', barriers: 'unknown' },
	routed: true,
	profile: { s: [0, 5, 181.9], heights: [300, 299.5, 295.5] },
	cellM: 4
};

describe('message protocol: structured clone round-trip', () => {
	it('requests survive structuredClone unchanged', () => {
		const messages: ToWorkerMessage[] = [
			{
				type: 'nearby',
				id: 7,
				origin: { lat: 48.01, lng: 15.02 },
				targets: [{ lat: 48, lng: 15 }, pond, { kind: 'point', point: { lat: 1, lng: 2 } }],
				straightDistances: [12.5, 300, 1600],
				options: { mode: 'optimized', maxHosePressureBar: 16, sourcePressureBars: [6, 8, 0] }
			},
			{
				type: 'path',
				id: 8,
				origin: { lat: 48.01, lng: 15.02 },
				target: pond,
				options: { mode: 'roads', profile: false, compareRoads: false, cellM: 6 }
			},
			{ type: 'cancel', id: 7 },
			{ type: 'invalidate' }
		];
		for (const message of messages) {
			expect(structuredClone(message)).toEqual(message);
			expect(transferablesOf(message)).toEqual([]);
		}
	});

	it('results (routes, list rows, failures) survive structuredClone unchanged', () => {
		const rows: NearbyDistanceResult[] = [
			{ routedDistance: 182.4, sortDistance: 182.4, route, fallback: null },
			{ routedDistance: null, sortDistance: 1600, route: null, fallback: 'tooFar' }
		];
		const messages: FromWorkerMessage[] = [
			{ type: 'ready', demDecode: false },
			{ type: 'result', id: 1, ok: true, value: rows },
			{ type: 'result', id: 2, ok: true, value: route },
			{ type: 'result', id: 3, ok: false, cancelled: true, error: 'Routing request cancelled' },
			{ type: 'fetchTile', reqId: 4, source: 'protomaps', z: 15, x: 17772, y: 11372 }
		];
		for (const message of messages) expect(structuredClone(message)).toEqual(message);
	});

	it('tile bytes and DEM elevations are transferred, not copied', () => {
		const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
		const tile: ToWorkerMessage = { type: 'tile', reqId: 1, bytes };
		const copy = structuredClone(tile, { transfer: transferablesOf(tile) });
		expect(bytes.byteLength).toBe(0); // detached in the sender
		expect(new Uint8Array((copy as { bytes: ArrayBuffer }).bytes)).toEqual(
			new Uint8Array([1, 2, 3, 4])
		);

		const image = new Uint8Array([9, 9]).buffer;
		const decode: FromWorkerMessage = { type: 'decodeDem', reqId: 2, bytes: image };
		structuredClone(decode, { transfer: transferablesOf(decode) });
		expect(image.byteLength).toBe(0);

		const elevations = new Float32Array([100, 101, 102, 103]);
		const decoded: ToWorkerMessage = {
			type: 'demDecoded',
			reqId: 3,
			tile: { size: 2, elevations }
		};
		const back = structuredClone(decoded, { transfer: transferablesOf(decoded) }) as {
			tile: { elevations: Float32Array };
		};
		expect(elevations.length).toBe(0);
		expect([...back.tile.elevations]).toEqual([100, 101, 102, 103]);

		// A missing tile or a failed decode transfers nothing.
		expect(transferablesOf({ type: 'tile', reqId: 4, bytes: null })).toEqual([]);
		expect(transferablesOf({ type: 'demDecoded', reqId: 5, tile: null })).toEqual([]);
	});
});

describe('cancellation', () => {
	it('an aborted request rejects with RoutingCancelledError, never a straight fallback', async () => {
		configureRoutingIO({ fetchTile: async () => null });
		const controller = new AbortController();
		controller.abort();
		const origin = { lat: 48, lng: 15 };
		const target = { lat: 48.001, lng: 15.001 };
		await expect(
			routePath(origin, target, { mode: 'optimized' }, controller.signal)
		).rejects.toSatisfy(isRoutingCancelled);
		await expect(
			routeNearby(origin, [target], [130], { mode: 'optimized' }, controller.signal)
		).rejects.toSatisfy(isRoutingCancelled);
		// Without a signal the same request answers (no tiles: open ground, map data 'none').
		const line = await routePath(origin, target, { mode: 'optimized', profile: false });
		expect(line.coverage.basemap).toBe('none');
	});
});
