import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { distanceTo, type GeoPoint } from '@/types/geo';
import { lngLatToTile, tileToBounds } from '@/offline/tileMath';
import { encodeMvt } from '@/testing/mvt';
import type { DecodedDemTile } from '@/helper/demRaster';
import { invalidateObstacleCache } from '@/mapHandler/obstacleTiles';
import {
	configureRoutingIO,
	invalidateRoutingContext,
	isRoutingCancelled,
	routeNearby,
	routePath
} from '@/mapHandler/hoseRoutingCore';
import {
	HoseRoutingClient,
	serveHoseRouting,
	type FromWorkerMessage,
	type RoutingPort
} from '@/mapHandler/hoseRoutingProtocol';

/**
 * The worker protocol over a real `MessageChannel` (structured clone and
 * transfer as between threads; Node has no `Worker` for the Vite worker, so
 * the worker side runs in this thread). Worker execution on a device is a
 * manual check (plan section 7, phase 6).
 */

const Z = 15;
const ORIGIN: GeoPoint = { lat: 48.13, lng: 15.27 };
const { x: TX, y: TY } = lngLatToTile(ORIGIN.lng, ORIGIN.lat, Z);
const TILE = tileToBounds(Z, TX, TY);
/** Tile coordinates (extent 4096) of a point in tile TX/TY. */
const tc = (p: GeoPoint): [number, number] => [
	Math.round(((p.lng - TILE.west) / (TILE.east - TILE.west)) * 4096),
	Math.round(((TILE.north - p.lat) / (TILE.north - TILE.south)) * 4096)
];
const at = (dxM: number, dyM: number): GeoPoint => ({
	lat: ORIGIN.lat + dyM / 110_540,
	lng: ORIGIN.lng + dxM / (Math.cos((ORIGIN.lat * Math.PI) / 180) * 111_320)
});
const TARGETS = [at(150, 120), at(-100, 160)];

/** One basemap tile: an L-shaped road and a house between origin and the first target. */
function basemapTile(): ArrayBuffer {
	const house = [at(60, 40), at(90, 40), at(90, 70), at(60, 70), at(60, 40)].map(tc);
	return encodeMvt([
		{
			name: 'roads',
			features: [
				{
					type: 2,
					geometry: [[at(0, -5), at(160, -5), at(160, 200)].map(tc)],
					properties: { kind: 'minor_road', kind_detail: 'residential' }
				}
			]
		},
		{
			name: 'buildings',
			features: [{ type: 3, geometry: [house], properties: { kind: 'building' } }]
		}
	]);
}

/** A flat DEM tile rising 1 m per pixel row (512 px). */
function demTile(): DecodedDemTile {
	const size = 512;
	const elevations = new Float32Array(size * size);
	for (let r = 0; r < size; r++) elevations.fill(300 + r * 0.2, r * size, (r + 1) * size);
	return { size, elevations };
}

/** Tile source: the basemap tile and a fake DEM image for every terrain tile. */
function makeIO() {
	const handedOut: ArrayBuffer[] = [];
	const fetchTile = vi.fn(async (source: string, z: number, x: number, y: number) => {
		let bytes: ArrayBuffer | null = null;
		if (source === 'protomaps' && z === Z && x === TX && y === TY) bytes = basemapTile();
		if (source === 'terrain') bytes = new Uint8Array([z, x & 255, y & 255]).buffer;
		if (bytes) handedOut.push(bytes);
		return bytes;
	});
	const decodeDem = vi.fn(async () => demTile());
	return { fetchTile, decodeDem, handedOut };
}

const open: MessageChannel[] = [];

/** A client wired to a worker-side server over a fresh channel; `seen` taps the replies. */
function connect(io = makeIO()) {
	const channel = new MessageChannel();
	open.push(channel);
	serveHoseRouting(channel.port2 as unknown as RoutingPort);
	const seen: FromWorkerMessage[] = [];
	const port1 = channel.port1 as unknown as RoutingPort;
	const tapped: RoutingPort = {
		postMessage: (message, transfer) => port1.postMessage(message, transfer),
		get onmessage() {
			return port1.onmessage;
		},
		set onmessage(handler) {
			port1.onmessage = (event) => {
				seen.push(event.data as FromWorkerMessage);
				handler?.(event);
			};
		}
	};
	const client = new HoseRoutingClient(tapped, io);
	return { client, io, seen };
}

function resetRealm(): void {
	invalidateObstacleCache();
	invalidateRoutingContext();
}

afterEach(() => {
	for (const channel of open.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
	resetRealm();
});

const straight = TARGETS.map((t) => distanceTo(ORIGIN, t));

describe('worker protocol over a MessageChannel', () => {
	it('answers ready, and without OffscreenCanvas asks the main thread to decode the DEM', async () => {
		const { client, io } = connect();
		await expect(client.ready).resolves.toEqual({ demDecode: false });
		const route = await client.path(ORIGIN, TARGETS[0], { mode: 'optimized' });
		expect(route.routed).toBe(true);
		expect(route.demZoom).toBe(14);
		expect(io.decodeDem).toHaveBeenCalled();
	});

	it('transfers the tile bytes: the main thread keeps no copy', async () => {
		const { client, io } = connect();
		await client.nearby(ORIGIN, TARGETS, straight, { mode: 'optimized' });
		expect(io.handedOut.length).toBeGreaterThan(0);
		for (const bytes of io.handedOut) expect(bytes.byteLength).toBe(0);
	});

	it('gives the same list and line as the main-thread solve (one code path)', async () => {
		const { client } = connect();
		const options = {
			mode: 'optimized' as const,
			maxHosePressureBar: 16,
			sourcePressureBars: [6, 6]
		};
		const viaWorker = await client.nearby(ORIGIN, TARGETS, straight, options);
		const lineViaWorker = await client.path(ORIGIN, TARGETS[1], {
			mode: 'optimized',
			sourcePressureBar: 6
		});

		resetRealm();
		const io = makeIO();
		configureRoutingIO({ fetchTile: io.fetchTile, decodeDem: io.decodeDem });
		const inline = await routeNearby(ORIGIN, TARGETS, straight, options);
		const lineInline = await routePath(ORIGIN, TARGETS[1], {
			mode: 'optimized',
			sourcePressureBar: 6
		});

		expect(viaWorker).toEqual(inline);
		expect(lineViaWorker).toEqual(lineInline);
		expect(viaWorker[0].route!.cellM).toBe(8);
		// list = line: the line after the list stays on the list field.
		expect(lineViaWorker.meters).toBe(viaWorker[1].routedDistance);
	});

	it('a newer request on the same channel supersedes the running one', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const io = makeIO();
		const slowFetch = io.fetchTile.getMockImplementation()!;
		io.fetchTile.mockImplementation(async (...args) => {
			await gate;
			return slowFetch(...args);
		});
		const { client, seen } = connect(io);
		await client.ready;
		const options = { mode: 'optimized' as const, profile: false };
		const first = client.nearby(ORIGIN, TARGETS, straight, options, 'list');
		const other = client.path(ORIGIN, TARGETS[0], options, 'path');
		const second = client.nearby(ORIGIN, TARGETS, straight, options, 'list');
		// The superseded request rejects at once, before any tile arrived.
		await expect(first).rejects.toSatisfy(isRoutingCancelled);
		release();
		await expect(second).resolves.toHaveLength(2);
		await expect(other).resolves.toMatchObject({ routed: true });
		// The worker stopped the first one at its next await and said so.
		await vi.waitFor(() =>
			expect(seen).toContainEqual(
				expect.objectContaining({ type: 'result', id: 1, ok: false, cancelled: true })
			)
		);
		expect(client.pendingCount).toBe(0);
	});

	it('a worker failure rejects every pending request', async () => {
		const io = makeIO();
		io.fetchTile.mockImplementation(() => new Promise(() => {}));
		const { client } = connect(io);
		const pending = client.path(ORIGIN, TARGETS[0], { mode: 'optimized' });
		client.failAll(new Error('worker died'));
		await expect(pending).rejects.toThrow('worker died');
		expect(client.pendingCount).toBe(0);
	});
});
