import { beforeAll, describe, expect, it, vi } from 'vitest';
import { distanceTo, type GeoPoint } from '@/types/geo';
import { computeNearbyDistances, invalidateRoutingContext } from '@/mapHandler/nearbyRouting';
import { invalidateObstacleCache } from '@/mapHandler/obstacleGeometry';
import {
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
async function routedMeters(from: GeoPoint, to: GeoPoint, mode: Mode): Promise<number | null> {
	invalidateRoutingContext();
	const [result] = await computeNearbyDistances(from, [to], [distanceTo(from, to)], {
		clampToRoads: mode === 'road'
	});
	return result.routedDistance;
}

function useScene(id: string): RoutingScene {
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

// Characterisation of today's code (baseline, phase 0). Expected values are
// tolerant ranges from the plan (sections 2 and 5); later phases change them
// on purpose and update the ranges in the same commit.
describe.skipIf(!fixturesPresent)('nearbyRouting baseline over the fixture scenes', () => {
	describe('scene 1: rural pond', () => {
		let scene: RoutingScene;
		beforeAll(() => {
			scene = useScene('1-rural-pond');
		});

		it('pond, road mode: the 1.7 km detour of the screenshot', async () => {
			const { from, to } = scene.cases!.pond;
			const meters = await routedMeters(from, to, 'road');
			expect(meters).toBeGreaterThanOrEqual(1600);
			expect(meters).toBeLessThanOrEqual(1850);
		});

		it('pond, terrain mode: across the farmland, within about 10 % of the straight line', async () => {
			const { from, to, straightM } = scene.cases!.pond;
			const meters = await routedMeters(from, to, 'terrain');
			expect(straightM).toBeGreaterThan(640);
			// The owner's screenshot showed 528 m, which this vehicle position cannot
			// reproduce (the shore is 645 m away); see the README of the fixtures.
			expect(meters).toBeGreaterThanOrEqual(680);
			expect(meters).toBeLessThanOrEqual(740);
		});

		// The screenshots (295 m road, 232 m terrain) used a vehicle position that was
		// not recorded; with the research vehicle the 300 m hydrant gives these values.
		it('hydrant node 4477703437 (300 m), road mode', async () => {
			const { from, to } = scene.cases!.hydrantEast;
			const meters = await routedMeters(from, to, 'road');
			expect(meters).toBeGreaterThanOrEqual(430);
			expect(meters).toBeLessThanOrEqual(490);
		});

		it('hydrant node 4477703437 (300 m), terrain mode', async () => {
			const { from, to } = scene.cases!.hydrantEast;
			const meters = await routedMeters(from, to, 'terrain');
			expect(meters).toBeGreaterThanOrEqual(350);
			expect(meters).toBeLessThanOrEqual(410);
		});
	});

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
