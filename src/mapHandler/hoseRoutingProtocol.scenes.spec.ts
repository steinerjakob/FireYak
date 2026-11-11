import { MessageChannel } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { distanceTo, type GeoPoint } from '@/types/geo';
import { invalidateObstacleCache } from '@/mapHandler/obstacleTiles';
import {
	configureRoutingIO,
	invalidateRoutingContext,
	routeNearby,
	routePath,
	type HoseRoute,
	type NearbyDistanceResult
} from '@/mapHandler/hoseRoutingCore';
import {
	HoseRoutingClient,
	serveHoseRouting,
	type RoutingPort
} from '@/mapHandler/hoseRoutingProtocol';
import {
	decodeDemWebp,
	fixtureFetcher,
	fixturesPresent,
	loadScene,
	type RoutingScene
} from '@/testing/routingFixtures';

/**
 * Worker against main thread on the fixture scenes (plan section 7, phase 6): the
 * same requests through the worker protocol (a real `MessageChannel`: structured
 * clone, transferred tile bytes, DEM images decoded on request) and straight into
 * `hoseRoutingCore.ts` give the same numbers, because both run the same pure code.
 */

interface Run {
	lists: NearbyDistanceResult[][];
	lines: HoseRoute[];
}

/** Three vehicle positions per scene, each with a list over the anchor and other positions and a profiled line. */
function requests(scene: RoutingScene) {
	const rings = scene.rings ?? [];
	const vehicles: GeoPoint[] = rings.length
		? [0, Math.floor(rings.length / 2), rings.length - 1].map((k) => rings[k].vehicle)
		: Object.values(scene.cases ?? {}).map((c) => c.from);
	return vehicles.map((origin) => {
		const targets = [scene.anchor as GeoPoint, ...rings.slice(0, 8).map((r) => r.vehicle)].filter(
			(t) => distanceTo(origin, t) > 20
		);
		return { origin, targets, straight: targets.map((t) => distanceTo(origin, t)) };
	});
}

const options = { mode: 'optimized' as const, maxHosePressureBar: 16, sourcePressureBars: [] };

async function viaWorker(scene: RoutingScene): Promise<Run> {
	invalidateObstacleCache();
	invalidateRoutingContext();
	const channel = new MessageChannel();
	try {
		serveHoseRouting(channel.port2 as unknown as RoutingPort);
		const client = new HoseRoutingClient(channel.port1 as unknown as RoutingPort, {
			fetchTile: fixtureFetcher(scene),
			decodeDem: decodeDemWebp
		});
		const run: Run = { lists: [], lines: [] };
		for (const { origin, targets, straight } of requests(scene)) {
			run.lists.push(await client.nearby(origin, targets, straight, options));
			run.lines.push(await client.path(origin, scene.anchor, { mode: 'optimized' }));
		}
		return run;
	} finally {
		channel.port1.close();
		channel.port2.close();
	}
}

async function inline(scene: RoutingScene): Promise<Run> {
	invalidateObstacleCache();
	configureRoutingIO({ fetchTile: fixtureFetcher(scene), decodeDem: decodeDemWebp });
	const run: Run = { lists: [], lines: [] };
	for (const { origin, targets, straight } of requests(scene)) {
		run.lists.push(await routeNearby(origin, targets, straight, options));
		run.lines.push(await routePath(origin, scene.anchor, { mode: 'optimized' }));
	}
	return run;
}

describe.skipIf(!fixturesPresent)('worker protocol = main thread on the fixture scenes', () => {
	afterAll(() => {
		invalidateObstacleCache();
		invalidateRoutingContext();
	});

	it.each(['1-rural-pond', '2-melk', '3-persenbeug', '4-vienna', '5-innsbruck'])(
		'%s: the same lists and lines, number for number',
		async (id) => {
			const scene = loadScene(id);
			const worker = await viaWorker(scene);
			const main = await inline(scene);
			expect(worker.lists.flat().some((r) => r.route?.routed)).toBe(true);
			expect(worker).toEqual(main);
		},
		120_000
	);
});
