import { describe, expect, it } from 'vitest';
import {
	SCENE_IDS,
	decodeDemWebp,
	fixtureBytes,
	fixtureFetcher,
	fixturesPresent,
	loadScene,
	mvtLayerNames,
	sceneTileFiles,
	tilesOfRange
} from '@/testing/routingFixtures';

/** Upper bound for the whole fixture folder (plan 6.14: about 2.6-2.8 MB expected). */
const MAX_FIXTURE_BYTES = 3.5 * 1024 * 1024;

describe('scene.json files (always committed)', () => {
	it('lists the five scenes', () => {
		expect(SCENE_IDS).toEqual([
			'1-rural-pond',
			'2-melk',
			'3-persenbeug',
			'4-vienna',
			'5-innsbruck'
		]);
	});

	it('keeps every case, ring and tile range well formed', () => {
		for (const id of SCENE_IDS) {
			const scene = loadScene(id);
			expect(scene.id).toBe(id);
			expect(scene.anchor.lat).toBeGreaterThan(47);
			expect(scene.tiles.basemap.z).toBe(15);
			expect(scene.tiles.dem.some((range) => range.z === 14)).toBe(true);
			for (const ring of [...(scene.rings ?? []), ...(scene.ringsRelaxed ?? [])]) {
				expect([150, 300, 500]).toContain(ring.radius);
				expect(Number.isFinite(ring.vehicle.lat + ring.vehicle.lng)).toBe(true);
			}
			for (const c of Object.values(scene.cases ?? {})) {
				expect(Number.isFinite(c.from.lat + c.to.lng)).toBe(true);
			}
		}
	});

	it('crops Vienna to four z15 tiles and keeps only the 150 m and 300 m rings', () => {
		const vienna = loadScene('4-vienna');
		expect(tilesOfRange(vienna.tiles.basemap)).toHaveLength(4);
		expect(vienna.rings?.every((ring) => ring.radius <= 300)).toBe(true);
	});

	it('has the pond outline (scene 1) as a closed polygon with an island', () => {
		const pond = loadScene('1-rural-pond').pond;
		expect(pond?.type).toBe('Polygon');
		expect(pond?.coordinates).toHaveLength(2);
		for (const ring of pond?.coordinates ?? []) expect(ring[0]).toEqual(ring[ring.length - 1]);
	});
});

describe.skipIf(!fixturesPresent)('fixture tiles (fetched locally)', () => {
	it('has every listed tile, decodable: MVT layers present, DEM 512x512', async () => {
		for (const id of SCENE_IDS) {
			const scene = loadScene(id);
			const fetcher = fixtureFetcher(scene);
			const layerNames = new Set<string>();
			for (const t of tilesOfRange(scene.tiles.basemap)) {
				const buffer = await fetcher('protomaps', t.z, t.x, t.y);
				expect(buffer, `${id} basemap ${t.z}/${t.x}/${t.y}`).not.toBeNull();
				mvtLayerNames(buffer as ArrayBuffer).forEach((name) => layerNames.add(name));
			}
			// Single tiles can lack a layer (no water in a field); the scene as a whole has them.
			expect([...layerNames]).toEqual(expect.arrayContaining(['roads', 'buildings']));
			for (const range of scene.tiles.dem) {
				for (const t of tilesOfRange(range)) {
					const buffer = await fetcher('terrain', t.z, t.x, t.y);
					expect(buffer, `${id} dem ${t.z}/${t.x}/${t.y}`).not.toBeNull();
					const dem = await decodeDemWebp(buffer as ArrayBuffer);
					expect(dem.size).toBe(512);
					expect(dem.elevations).toHaveLength(512 * 512);
				}
			}
		}
	});

	it('decodes plausible elevations (Innsbruck rim is about 835 m, Melk far below 400 m)', async () => {
		const read = async (id: string) => {
			const scene = loadScene(id);
			const range = scene.tiles.dem.find((r) => r.z === 14)!;
			const t = tilesOfRange(range)[0];
			const buffer = await fixtureFetcher(scene)('terrain', t.z, t.x, t.y);
			return (await decodeDemWebp(buffer as ArrayBuffer)).elevations;
		};
		const range = (values: Float32Array) =>
			values.reduce((r, v) => ({ min: Math.min(r.min, v), max: Math.max(r.max, v) }), {
				min: Infinity,
				max: -Infinity
			});
		const innsbruck = range(await read('5-innsbruck'));
		const melk = range(await read('2-melk'));
		expect(innsbruck.max).toBeGreaterThan(700);
		expect(melk.max).toBeLessThan(400);
		expect(melk.min).toBeGreaterThan(150);
	});

	it('returns null for a tile that is not in the scene', async () => {
		const fetcher = fixtureFetcher(loadScene('2-melk'));
		expect(await fetcher('protomaps', 15, 1, 1)).toBeNull();
	});

	it('keeps the whole fixture folder within the size budget', () => {
		expect(fixtureBytes()).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);
		for (const id of SCENE_IDS) {
			expect(sceneTileFiles(loadScene(id)).length).toBeGreaterThan(0);
		}
	});
});
