import { describe, expect, it } from 'vitest';
import {
	OBSTACLE_LAYERS,
	decodeObstacleTile,
	emptyTileObstacles,
	mergeTileObstacles
} from '@/mapHandler/obstacleDecode';
import { tileToBounds } from '@/offline/tileMath';
import { pointInPolygon } from '@/helper/polygonGeometry';
import { encodeMvt, type MvtFeature } from '@/testing/mvt';
import {
	decodeSceneObstacles,
	fixturesPresent,
	loadScene,
	type RoutingScene
} from '@/testing/routingFixtures';

const Z = 15;
const X = 17772;
const Y = 11372;

const line = (...pts: [number, number][]): MvtFeature['geometry'] => [pts];
const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
	[x0, y0],
	[x1, y0],
	[x1, y1],
	[x0, y1],
	[x0, y0]
];

const decode = (...layers: Parameters<typeof encodeMvt>[0]) =>
	decodeObstacleTile(encodeMvt(layers), X, Y, Z);

describe('decodeObstacleTile: roads', () => {
	const roadFeature = (properties: MvtFeature['properties']): MvtFeature => ({
		type: 2,
		geometry: line([100, 100], [900, 100]),
		properties
	});

	it('keeps kind_detail, is_bridge, is_tunnel and access as typed values', () => {
		const tile = decode({
			name: 'roads',
			features: [
				roadFeature({ kind: 'path', kind_detail: 'footway', is_bridge: true, access: 'private' }),
				roadFeature({ kind: 'minor_road', kind_detail: 'service', is_tunnel: true }),
				roadFeature({ kind: 'major_road', kind_detail: 'primary' })
			]
		});
		expect(tile.roads).toHaveLength(3);
		const [bridge, tunnel, plain] = tile.roads;
		expect(bridge).toMatchObject({
			kind: 'path',
			kindDetail: 'footway',
			isBridge: true,
			isTunnel: false,
			access: 'private'
		});
		expect(tunnel).toMatchObject({ kindDetail: 'service', isBridge: false, isTunnel: true });
		expect(tunnel).not.toHaveProperty('access');
		expect(plain).toMatchObject({ isBridge: false, isTunnel: false, kindDetail: 'primary' });
		for (const road of tile.roads) {
			expect(typeof road.isBridge).toBe('boolean');
			expect(typeof road.isTunnel).toBe('boolean');
		}
	});

	it('only a boolean true counts as a flag (a string "true" does not)', () => {
		const tile = decode({
			name: 'roads',
			features: [roadFeature({ kind: 'path', kind_detail: 'path', is_bridge: 'true' })]
		});
		expect(tile.roads[0].isBridge).toBe(false);
	});

	it('moves rail to rails (every kind_detail), drops ferry, keeps the rest', () => {
		const tile = decode({
			name: 'roads',
			features: [
				roadFeature({ kind: 'rail', kind_detail: 'rail' }),
				roadFeature({ kind: 'rail', kind_detail: 'tram', is_tunnel: true }),
				roadFeature({ kind: 'rail', kind_detail: 'disused' }),
				roadFeature({ kind: 'ferry', kind_detail: 'ferry' }),
				roadFeature({ kind: 'highway', kind_detail: 'motorway' }),
				roadFeature({ kind: 'path', kind_detail: 'corridor' }),
				roadFeature({ kind: 'other', kind_detail: 'living_street' })
			]
		});
		expect(tile.rails.map((r) => [r.kind, r.kindDetail, r.isTunnel])).toEqual([
			['rail', 'rail', false],
			['rail', 'tram', true],
			['rail', 'disused', false]
		]);
		// corridor stays in `roads` in phase 2 (classifyRoad excludes it; see obstacleDecode.ts)
		expect(tile.roads.map((r) => r.kindDetail)).toEqual(['motorway', 'corridor', 'living_street']);
		expect(tile.featureCounts.roads).toBe(7);
	});

	it('splits a MultiLineString into one road per line and computes bboxes', () => {
		const tile = decode({
			name: 'roads',
			features: [
				{
					type: 2,
					geometry: [
						[
							[100, 100],
							[200, 100]
						],
						[
							[500, 500],
							[600, 700]
						]
					],
					properties: { kind: 'minor_road', kind_detail: 'residential' }
				}
			]
		});
		expect(tile.roads).toHaveLength(2);
		for (const road of tile.roads) {
			expect(road.bbox[0]).toBeLessThan(road.bbox[2]);
			expect(road.bbox[1]).toBeLessThanOrEqual(road.bbox[3]);
		}
	});

	it('defaults a missing kind to unknown and a missing kind_detail to an empty string', () => {
		const tile = decode({ name: 'roads', features: [roadFeature({})] });
		expect(tile.roads[0]).toMatchObject({ kind: 'unknown', kindDetail: '' });
	});
});

describe('decodeObstacleTile: landuse, water, earth, buildings', () => {
	it('decodes landuse polygons with their area; ignores non-polygons', () => {
		const bounds = tileToBounds(Z, X, Y);
		const tileWidthM =
			(bounds.east - bounds.west) *
			111_320 *
			Math.cos(((bounds.north + bounds.south) / 2) * (Math.PI / 180));
		const tile = decode({
			name: 'landuse',
			features: [
				{ type: 3, geometry: [square(0, 0, 2048, 2048)], properties: { kind: 'farmland' } },
				{
					type: 3,
					geometry: [square(0, 0, 4096, 4096), square(1000, 1000, 3000, 3000).reverse()],
					properties: { kind: 'forest' }
				},
				{ type: 2, geometry: line([0, 0], [10, 10]), properties: { kind: 'farmland' } }
			]
		});
		expect(tile.landuse.map((l) => l.kind)).toEqual(['farmland', 'forest']);
		const quarter = (tileWidthM * tileWidthM) / 4;
		expect(tile.landuse[0].areaM2).toBeGreaterThan(quarter * 0.97);
		expect(tile.landuse[0].areaM2).toBeLessThan(quarter * 1.03);
		// the forest has a hole of a quarter of the tile
		const forestExpected = (tileWidthM * tileWidthM * 3) / 4;
		expect(tile.landuse[1].areaM2).toBeGreaterThan(forestExpected * 0.97);
		expect(tile.landuse[1].areaM2).toBeLessThan(forestExpected * 1.03);
		expect(tile.featureCounts.landuse).toBe(3);
	});

	it('splits water into polygons (with tile id) and lines; drops water points', () => {
		const tile = decode({
			name: 'water',
			features: [
				{ type: 3, geometry: [square(2000, 2000, 2600, 2400)], properties: { kind: 'water' } },
				{
					type: 2,
					geometry: line([0, 3000], [4000, 3100]),
					properties: { kind: 'stream' }
				},
				{
					type: 2,
					geometry: line([0, 3500], [4000, 3600]),
					properties: { kind: 'water', kind_detail: 'canal' }
				},
				{ type: 1, geometry: [[[100, 100]]], properties: { kind: 'fountain' } }
			]
		});
		expect(tile.waterAreas).toHaveLength(1);
		expect(tile.waterAreas[0]).toMatchObject({ kind: 'water', tile: `${Z}/${X}/${Y}` });
		expect(tile.waterAreas[0].areaM2).toBeGreaterThan(0);
		expect(tile.waterLines.map((l) => [l.kind, l.kindDetail])).toEqual([
			['stream', ''],
			['water', 'canal']
		]);
		expect(tile.featureCounts.water).toBe(4);
	});

	it('reads only cliff lines from earth', () => {
		const tile = decode({
			name: 'earth',
			features: [
				{ type: 3, geometry: [square(0, 0, 4096, 4096)], properties: { kind: 'earth' } },
				{
					type: 2,
					geometry: line([100, 100], [300, 400], [500, 450]),
					properties: { kind: 'cliff' }
				},
				{ type: 2, geometry: line([100, 900], [300, 900]), properties: { kind: 'ridge' } }
			]
		});
		expect(tile.cliffs).toHaveLength(1);
		expect(tile.cliffs[0]).toMatchObject({ kind: 'cliff', isBridge: false, isTunnel: false });
		expect(tile.cliffs[0].points).toHaveLength(3);
		expect(tile.featureCounts.earth).toBe(3);
	});

	it('still decodes buildings', () => {
		const tile = decode({
			name: 'buildings',
			features: [
				{ type: 3, geometry: [square(1000, 1000, 1200, 1200)], properties: { kind: 'building' } }
			]
		});
		expect(tile.buildings).toHaveLength(1);
		expect(tile.featureCounts.buildings).toBe(1);
	});

	it('a tile without layers decodes to nothing', () => {
		const tile = decodeObstacleTile(encodeMvt([{ name: 'pois', features: [] }]), X, Y, Z);
		expect(tile).toEqual(emptyTileObstacles());
	});
});

describe('mergeTileObstacles: per-layer coverage', () => {
	it('counts tiles that had the layer and the features read', () => {
		const withRoads = decode({
			name: 'roads',
			features: [
				{ type: 2, geometry: line([0, 0], [10, 10]), properties: { kind: 'minor_road' } },
				{ type: 2, geometry: line([0, 0], [10, 10]), properties: { kind: 'rail' } }
			]
		});
		const withWater = decode({
			name: 'water',
			features: [{ type: 3, geometry: [square(0, 0, 100, 100)], properties: { kind: 'water' } }]
		});
		const { data, layers } = mergeTileObstacles([withRoads, withWater, emptyTileObstacles()]);
		expect(data.roads).toHaveLength(1);
		expect(data.rails).toHaveLength(1);
		expect(data.waterAreas).toHaveLength(1);
		expect(layers.roads).toEqual({ tiles: 1, features: 2 });
		expect(layers.water).toEqual({ tiles: 1, features: 1 });
		expect(layers.landuse).toEqual({ tiles: 0, features: 0 });
		expect(Object.keys(layers).sort()).toEqual([...OBSTACLE_LAYERS].sort());
	});
});

describe.skipIf(!fixturesPresent)('decodeObstacleTile over the fixture scenes', () => {
	const decodeScene = (id: string) => decodeSceneObstacles(loadScene(id));

	it('scene 4: every rail is tram, subway or disused', () => {
		const { data } = decodeScene('4-vienna');
		expect(data.rails.length).toBeGreaterThan(0);
		for (const rail of data.rails) {
			expect(rail.kind).toBe('rail');
			expect(['tram', 'subway', 'disused']).toContain(rail.kindDetail);
		}
	});

	it('scene 2: surface heavy rail exists and the tunnel pieces carry isTunnel', () => {
		const { data } = decodeScene('2-melk');
		const surface = data.rails.filter((r) => r.kindDetail === 'rail' && !r.isTunnel && !r.isBridge);
		expect(surface.length).toBeGreaterThan(0);
		expect(data.rails.filter((r) => r.isTunnel).length).toBeGreaterThan(0);
		expect(data.rails.filter((r) => r.isBridge).length).toBeGreaterThan(0);
		expect(data.rails.every((r) => r.kindDetail === 'rail')).toBe(true);
	});

	it('scene 3: a water polygon contains a point in the Danube', () => {
		const { data } = decodeScene('3-persenbeug');
		const inDanube = data.waterAreas.filter((w) => pointInPolygon(15.0786, 48.1845, w));
		expect(inDanube.length).toBeGreaterThan(0);
		expect(Math.max(...inDanube.map((w) => w.areaM2))).toBeGreaterThan(200_000);
	});

	it('scene 1: farmland is the largest landuse class in the window', () => {
		const { data } = decodeScene('1-rural-pond');
		const byKind = new Map<string, number>();
		for (const l of data.landuse) byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + l.areaM2);
		const [largest] = [...byKind.entries()].sort((a, b) => b[1] - a[1])[0];
		expect(largest).toBe('farmland');
	});

	it('cliff lines decode where the tiles have them (scenes 2 and 5)', () => {
		expect(decodeScene('2-melk').data.cliffs.length).toBeGreaterThanOrEqual(1);
		expect(decodeScene('5-innsbruck').data.cliffs.length).toBeGreaterThanOrEqual(2);
		expect(decodeScene('1-rural-pond').data.cliffs).toHaveLength(0);
	});

	it('is_bridge and is_tunnel are booleans on every road, rail and line', () => {
		for (const id of ['2-melk', '4-vienna', '5-innsbruck']) {
			const { data } = decodeScene(id);
			for (const f of [...data.roads, ...data.rails, ...data.waterLines, ...data.cliffs]) {
				expect(typeof f.isBridge).toBe('boolean');
				expect(typeof f.isTunnel).toBe('boolean');
			}
		}
		expect(decodeScene('2-melk').data.roads.some((r) => r.isBridge)).toBe(true);
		expect(decodeScene('4-vienna').data.roads.some((r) => r.isTunnel)).toBe(true);
	});

	it('water lines (streams, rivers) decode in scenes 1 and 3', () => {
		for (const id of ['1-rural-pond', '3-persenbeug']) {
			expect(decodeScene(id).data.waterLines.length, id).toBeGreaterThan(0);
		}
	});

	it('reports per-layer coverage', () => {
		const scene: RoutingScene = loadScene('1-rural-pond');
		const { layers, tiles } = decodeSceneObstacles(scene);
		expect(tiles).toHaveLength(9);
		expect(layers.roads.tiles).toBeGreaterThan(0);
		expect(layers.landuse.features).toBeGreaterThan(0);
		for (const layer of OBSTACLE_LAYERS) expect(layers[layer].tiles).toBeLessThanOrEqual(9);
	});
});
