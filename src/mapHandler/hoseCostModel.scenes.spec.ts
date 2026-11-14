import { beforeAll, describe, expect, it } from 'vitest';
import {
	CELL_CLASS,
	CELL_CLASS_NAME,
	THIN_BUILDINGS,
	isThinBuildingTile,
	WATER_LINE_CLASS,
	classifyRoad,
	isKnownLanduseKind,
	type FeatureEffect
} from '@/mapHandler/hoseCostModel';
import { classSummary } from '@/mapHandler/routingDebug';
import {
	SCENE_IDS,
	decodeSceneObstacles,
	fixturesPresent,
	loadScene
} from '@/testing/routingFixtures';

/**
 * Every `kind/kind_detail` of the `roads` layer seen in plan section 4.1 and in the five
 * fixture scenes, with the class a plain (no bridge, no tunnel, no access) way gets.
 * A pair missing here fails the spec below: look at it, then add it with a class.
 */
const ROAD_KINDS: Record<string, string> = {
	'highway/motorway': 'BLOCKED',
	'highway/motorway_link': 'BLOCKED',
	'major_road/primary': 'ROAD',
	'major_road/primary_link': 'ROAD',
	'major_road/secondary': 'ROAD',
	'major_road/secondary_link': 'ROAD',
	'major_road/tertiary': 'ROAD',
	'major_road/tertiary_link': 'ROAD',
	'minor_road/raceway': 'ROAD',
	'minor_road/residential': 'ROAD',
	'minor_road/service': 'ROAD',
	'minor_road/unclassified': 'ROAD',
	'other/busway': 'ROAD',
	'other/living_street': 'ROAD',
	'other/platform': 'ROAD',
	'path/bridleway': 'PATH',
	'path/corridor': 'excluded',
	'path/crossing': 'PATH',
	'path/cycleway': 'PATH',
	'path/footway': 'PATH',
	'path/path': 'PATH',
	'path/pedestrian': 'PATH',
	'path/pier': 'PATH',
	'path/sidewalk': 'PATH',
	'path/steps': 'STEPS',
	'path/track': 'PATH'
};

/** Rail `kind_detail`s seen: heavy rail blocks on the surface, the others never. */
const RAIL_KINDS: Record<string, 'heavy' | 'light'> = {
	rail: 'heavy',
	light_rail: 'heavy',
	disused: 'light',
	subway: 'light',
	tram: 'light'
};

/** Polygon kinds of the `water` layer seen. */
const WATER_AREA_KINDS = ['basin', 'fountain', 'lake', 'swimming_pool', 'water'];

/** `access` values seen on roads; every one except `military` is ignored by routing. */
const ACCESS_VALUES = [
	'agricultural',
	'customers',
	'designated',
	'destination',
	'discouraged',
	'emergency',
	'military',
	'no',
	'permissive',
	'permit',
	'private',
	'yes'
];

const name = (effect: FeatureEffect) =>
	typeof effect === 'number' ? CELL_CLASS_NAME[effect] : effect;

describe.skipIf(!fixturesPresent)('cost-model classes over the fixture scenes', () => {
	// Decode in beforeAll, not in the describe body: vitest still runs the body
	// of a skipped describe to collect its tests, which would read the missing
	// tiles in a fresh checkout (CI) and fail the whole file.
	let scenes: ({ id: string } & ReturnType<typeof decodeSceneObstacles>)[] = [];
	beforeAll(() => {
		scenes = SCENE_IDS.map((id) => ({ id, ...decodeSceneObstacles(loadScene(id)) }));
	});

	it('has the five scenes', () => {
		expect(scenes.map((s) => s.id)).toHaveLength(5);
	});

	it('every road kind/kind_detail is listed and gets its class (flags aside)', () => {
		const unlisted = new Set<string>();
		for (const { data } of scenes) {
			for (const road of data.roads) {
				const key = `${road.kind}/${road.kindDetail}`;
				if (!(key in ROAD_KINDS)) {
					unlisted.add(key);
					continue;
				}
				const plain = { ...road, isBridge: false, isTunnel: false, access: undefined };
				expect(name(classifyRoad(plain)), key).toBe(ROAD_KINDS[key]);
			}
		}
		expect([...unlisted]).toEqual([]);
	});

	it('flags move a road only to the classes the owner decisions allow', () => {
		for (const { data } of scenes) {
			for (const road of data.roads) {
				const base = ROAD_KINDS[`${road.kind}/${road.kindDetail}`];
				const actual = name(classifyRoad(road));
				const allowed = new Set([base]);
				if (road.access === 'military') allowed.add('excluded');
				if (road.isBridge && base !== 'excluded') allowed.add('BRIDGE');
				if (road.isBridge && base === 'BLOCKED') allowed.add('none');
				if (road.isTunnel && base === 'BLOCKED') allowed.add('none');
				if (road.isTunnel && road.kind === 'path') allowed.add('excluded');
				expect(allowed.has(actual), `${road.kind}/${road.kindDetail} -> ${actual}`).toBe(true);
				if (road.isTunnel && road.kind === 'path') expect(actual).toBe('excluded');
				if (road.access === 'military') expect(actual).toBe('excluded');
			}
		}
	});

	it('every access value is known', () => {
		const unknown = new Set<string>();
		for (const { data } of scenes) {
			for (const road of data.roads) {
				if (road.access !== undefined && !ACCESS_VALUES.includes(road.access))
					unknown.add(road.access);
			}
		}
		expect([...unknown]).toEqual([]);
	});

	it('every rail kind_detail is listed, heavy rail blocks only on the surface', () => {
		for (const { data } of scenes) {
			for (const rail of data.rails) {
				expect(RAIL_KINDS[rail.kindDetail], rail.kindDetail).toBeDefined();
				const effect = name(classifyRoad(rail));
				const blocks = RAIL_KINDS[rail.kindDetail] === 'heavy' && !rail.isTunnel && !rail.isBridge;
				expect(effect, `${rail.kindDetail} tunnel=${rail.isTunnel} bridge=${rail.isBridge}`).toBe(
					blocks ? 'BLOCKED' : 'none'
				);
			}
		}
	});

	it('every landuse kind has a class or is on the untuned list', () => {
		const unlisted = new Set<string>();
		for (const { data } of scenes) {
			for (const area of data.landuse) if (!isKnownLanduseKind(area.kind)) unlisted.add(area.kind);
		}
		expect([...unlisted]).toEqual([]);
	});

	it('every water polygon kind and water line kind is listed', () => {
		for (const { data } of scenes) {
			for (const area of data.waterAreas) expect(WATER_AREA_KINDS, area.kind).toContain(area.kind);
			for (const line of data.waterLines) {
				expect(Object.keys(WATER_LINE_CLASS), line.kind).toContain(line.kindDetail || line.kind);
			}
			for (const cliff of data.cliffs) expect(cliff.kind).toBe('cliff');
		}
	});

	it('military ground and military access are excluded or blocked where present (scene 2)', () => {
		const { data } = scenes.find((s) => s.id === '2-melk')!;
		expect(data.landuse.some((l) => l.kind === 'military')).toBe(true);
		const summary = classSummary(data);
		expect(summary.areaM2['BLOCKED']).toBeGreaterThan(0);
		const military = data.roads.filter((r) => r.access === 'military');
		expect(military.length).toBeGreaterThan(0);
		expect(military.every((r) => classifyRoad(r) === 'excluded')).toBe(true);
	});

	it('the class summary of every scene is plausible', () => {
		for (const { id, data } of scenes) {
			const summary = classSummary(data);
			expect(summary.lengthM['ROAD'], id).toBeGreaterThan(500);
			expect(CELL_CLASS_NAME[CELL_CLASS.ROAD]).toBe('ROAD');
			for (const value of [...Object.values(summary.areaM2), ...Object.values(summary.lengthM)]) {
				expect(Number.isFinite(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
			}
		}
	});

	// Plan section 6.11: the thresholds are estimates; all five scenes must stay unflagged.
	it('no tile of any scene is flagged by the thin-buildings safeguard', () => {
		for (const scene of scenes) {
			expect(scene.thinBuildingTiles, scene.id).toBe(0);
			for (const tile of scene.tiles) {
				expect(isThinBuildingTile(tile.stats), scene.id).toBe(false);
				const share = tile.stats.residentialM2 / tile.stats.tileM2;
				if (share > THIN_BUILDINGS.minResidentialShare) {
					// Residential tiles carry plenty of buildings (ratio well above 5 %).
					expect(tile.stats.buildingM2 / tile.stats.residentialM2, scene.id).toBeGreaterThan(0.1);
				}
			}
		}
	});
});
