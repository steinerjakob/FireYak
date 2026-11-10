import { beforeAll, describe, expect, it, vi } from 'vitest';
import { distanceTo, type GeoPoint } from '@/types/geo';
import {
	computeNearbyDistances,
	getRoutedPath,
	invalidateRoutingContext,
	type HoseRoute,
	type RouteTargetInput
} from '@/mapHandler/nearbyRouting';
import { getObstaclesForBounds, invalidateObstacleCache } from '@/mapHandler/obstacleGeometry';
import { setDemTileDecoder } from '@/helper/demElevation';
import { distanceToOutline } from '@/helper/areaShore';
import { segmentIntersectsPolygon } from '@/helper/polygonGeometry';
import type { AccessTarget } from '@/mapHandler/waterSourceAccess';
import {
	decodeDemWebp,
	fixturesPresent,
	loadScene,
	useFixtureScene,
	type RoutingScene,
	type SceneRing
} from '@/testing/routingFixtures';

// Serve the fixture tiles instead of the network/tile store, so maplibre-gl and
// the Capacitor-backed tile store are never loaded.
vi.mock('@/offline/offlineProtocol', async () => {
	const { activeSceneFetcher: fetcher } = await import('@/testing/routingFixtures');
	return { fetchTileCacheFirst: fetcher };
});

type Mode = 'road' | 'terrain';

/** Routed length in meters from `from` to `to` in one of today's two modes. */
async function routedMeters(
	from: GeoPoint,
	to: RouteTargetInput,
	mode: Mode
): Promise<number | null> {
	invalidateRoutingContext();
	const point = 'kind' in to ? (to.kind === 'point' ? to.point : to.fallback) : to;
	const [result] = await computeNearbyDistances(from, [to], [distanceTo(from, point)], {
		clampToRoads: mode === 'road'
	});
	return result.routedDistance;
}

/** The pond of scene 1 as a shore target (routing picks the shore point). */
function pondShore(scene: RoutingScene): AccessTarget {
	return { kind: 'shore', outline: scene.pond!, fallback: scene.cases!.pond.to };
}

const runMeters = (route: HoseRoute, pick: (s: HoseRoute['segments'][number]) => boolean) =>
	route.segments.filter(pick).reduce((sum, s) => sum + s.to - s.from, 0);

function useScene(id: string): RoutingScene {
	setDemTileDecoder(decodeDemWebp);
	const scene = loadScene(id);
	useFixtureScene(scene);
	invalidateObstacleCache();
	invalidateRoutingContext();
	return scene;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/** Road-mode length / straight line for every ring position of one radius. */
async function ringRatios(scene: RoutingScene, radius: number): Promise<number[]> {
	const ratios: number[] = [];
	for (const ring of (scene.rings ?? []).filter((r: SceneRing) => r.radius === radius)) {
		const meters = await routedMeters(ring.vehicle, scene.anchor, 'road');
		if (meters !== null) ratios.push(meters / distanceTo(ring.vehicle, scene.anchor));
	}
	return ratios;
}

// Scene checks. Phase 0 pinned today's values (research vehicle 48.1300,
// 15.2725, 645 m from the pond shore); phase 1 changed some on purpose:
// - pond, road mode: the shore is now a goal set with 250 m final legs, so the
//   route attaches via the farm track (research: about 842 m) instead of the
//   1.75 km cycleway detour;
// - pond, terrain mode: the shore point is chosen by routing and the length is
//   the smoothed polyline (was the cell chain, 708 m);
// - hydrant, terrain mode: the length is the smoothed polyline and the line no
//   longer squeezes past walls (was the cell chain, 381 m). The plan's
//   232-295 m came from an unrecorded vehicle position; with this one the
//   straight line alone is 300 m.
describe.skipIf(!fixturesPresent)('nearbyRouting over the fixture scenes', () => {
	describe('scene 1: rural pond', () => {
		let scene: RoutingScene;
		beforeAll(() => {
			scene = useScene('1-rural-pond');
		});

		it('pond, road mode: attaches via the farm track and ends on the shore', async () => {
			const { from } = scene.cases!.pond;
			const meters = await routedMeters(from, pondShore(scene), 'road');
			expect(meters).toBeGreaterThanOrEqual(750);
			expect(meters).toBeLessThanOrEqual(900);
			const route = await getRoutedPath(from, pondShore(scene), { clampToRoads: true });
			expect(route.routed).toBe(true);
			expect(distanceToOutline(scene.pond, route.points[route.points.length - 1])!).toBeLessThan(1);
		});

		it('pond, terrain mode: across the farmland to the shore point routing picks', async () => {
			const { from, straightM } = scene.cases!.pond;
			const meters = await routedMeters(from, pondShore(scene), 'terrain');
			expect(straightM).toBeGreaterThan(640);
			// The owner's screenshot showed 528 m, which this vehicle position cannot
			// reproduce (the shore is 645 m away); see the README of the fixtures.
			expect(meters).toBeGreaterThanOrEqual(645);
			expect(meters).toBeLessThanOrEqual(720);
			const route = await getRoutedPath(from, pondShore(scene), { clampToRoads: false });
			expect(distanceToOutline(scene.pond, route.points[route.points.length - 1])!).toBeLessThan(1);
		});

		it('hydrant node 4477703437 (300 m), road mode', async () => {
			const { from, to } = scene.cases!.hydrantEast;
			const meters = await routedMeters(from, to, 'road');
			expect(meters).toBeGreaterThanOrEqual(430);
			expect(meters).toBeLessThanOrEqual(490);
		});

		it('hydrant node 4477703437 (300 m), terrain mode: no building-edge intersection', async () => {
			const { from, to } = scene.cases!.hydrantEast;
			const meters = await routedMeters(from, to, 'terrain');
			expect(meters).toBeGreaterThanOrEqual(300);
			expect(meters).toBeLessThanOrEqual(430);
			const route = await getRoutedPath(from, to, { clampToRoads: false });
			const { buildings } = await getObstaclesForBounds({
				south: Math.min(from.lat, to.lat) - 0.002,
				north: Math.max(from.lat, to.lat) + 0.002,
				west: Math.min(from.lng, to.lng) - 0.003,
				east: Math.max(from.lng, to.lng) + 0.003
			});
			let hits = 0;
			for (let i = 0; i < route.points.length - 1; i++) {
				const a: [number, number] = [route.points[i].lng, route.points[i].lat];
				const b: [number, number] = [route.points[i + 1].lng, route.points[i + 1].lat];
				for (const building of buildings) if (segmentIntersectsPolygon(a, b, building)) hits++;
			}
			expect(hits).toBe(0);
		});
	});

	describe('scene 5: Innsbruck, "500 m north" (vehicle about 190 m below the hydrant)', () => {
		let scene: RoutingScene;
		let vehicle: GeoPoint;
		beforeAll(() => {
			scene = useScene('5-innsbruck');
			vehicle = scene.rings!.find((r) => r.radius === 500 && r.bearing === 0)!.vehicle;
		});

		it('terrain mode goes straight down the scarp: a red run and "not recommended"', async () => {
			invalidateRoutingContext();
			const route = await getRoutedPath(vehicle, scene.anchor, { clampToRoads: false });
			expect(route.demZoom).toBe(14);
			expect(runMeters(route, (s) => s.steep === 2)).toBeGreaterThanOrEqual(10);
			expect(route.metersOver50).toBeGreaterThanOrEqual(10);
			expect(route.notRecommended).toBe(true);
		});

		it('terrain mode: the downhill pressure rule warns (drop 177-220 m)', async () => {
			invalidateRoutingContext();
			const route = await getRoutedPath(vehicle, scene.anchor, {
				clampToRoads: false,
				maxHosePressureBar: 16,
				sourcePressureBar: 0
			});
			// The water source is the route's end, so the drop is the climb to it.
			expect(route.climbM).toBeGreaterThanOrEqual(177);
			expect(route.climbM).toBeLessThanOrEqual(220);
			expect(route.pressureLevel).toBe('warning');
			expect(route.staticPressureMaxBar).toBeGreaterThanOrEqual(17.7);
		});
	});

	describe.each(['2-melk', '4-vienna'])('%s: no false red on roads', (id) => {
		beforeAll(() => {
			useScene(id);
		});

		it('road mode: no very steep run on a road at any ring position', async () => {
			const scene = loadScene(id);
			for (const ring of scene.rings ?? []) {
				invalidateRoutingContext();
				const route = await getRoutedPath(ring.vehicle, scene.anchor, { clampToRoads: true });
				expect(runMeters(route, (s) => !s.offRoad && s.steep === 2)).toBe(0);
			}
		});
	});

	describe.each(['2-melk', '3-persenbeug', '4-vienna', '5-innsbruck'])(
		'%s: one length for list and line',
		(id) => {
			beforeAll(() => {
				useScene(id);
			});

			it.each(['road', 'terrain'] as Mode[])(
				'%s mode: list metres equal the polyline metres at every ring target',
				async (mode) => {
					const scene = loadScene(id);
					let compared = 0;
					for (const ring of scene.rings ?? []) {
						invalidateRoutingContext();
						const options = { clampToRoads: mode === 'road', profile: false };
						const [listed] = await computeNearbyDistances(
							ring.vehicle,
							[scene.anchor],
							[distanceTo(ring.vehicle, scene.anchor)],
							options
						);
						// Same context: the path after the list search reuses it.
						const route = await getRoutedPath(ring.vehicle, scene.anchor, options);
						let length = 0;
						for (let i = 0; i < route.points.length - 1; i++) {
							length += distanceTo(route.points[i], route.points[i + 1]);
						}
						expect(Math.abs(route.meters - length)).toBeLessThan(0.01);
						if (listed.routedDistance === null) {
							expect(route.routed).toBe(false);
							continue;
						}
						expect(Math.abs(listed.routedDistance - length)).toBeLessThanOrEqual(0.5);
						compared++;
					}
					expect(compared).toBeGreaterThanOrEqual(5);
				}
			);
		}
	);

	describe.each([
		['2-melk', 'Melk', 3.06, 1.89],
		['3-persenbeug', 'Persenbeug', 2.77, 1.79],
		['4-vienna', 'Vienna centre (rings cropped to 150 and 300 m)', 1.46, 1.4]
	])('%s: %s, road-mode ring medians (plan section 5)', (id, _name, median150, median300) => {
		let scene: RoutingScene;
		beforeAll(() => {
			scene = useScene(id);
		});

		it.each([
			[150, median150],
			[300, median300]
		])('%i m ring: median ratio within 10 %% of %f', async (radius, expected) => {
			const ratios = await ringRatios(scene, radius);
			expect(ratios.length).toBeGreaterThanOrEqual(8);
			expect(median(ratios)).toBeGreaterThanOrEqual(expected * 0.9);
			expect(median(ratios)).toBeLessThanOrEqual(expected * 1.1);
		});
	});
});
