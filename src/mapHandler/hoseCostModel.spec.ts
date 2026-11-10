import { describe, expect, it } from 'vitest';
import {
	CELL_CLASS,
	CELL_CLASS_NAME,
	CLASS_FACTOR,
	CLIFF_CLASS,
	LANDUSE_CLASS,
	ROAD_SLOPE_CAP,
	SLOPE_CURVE,
	UNTUNED_LANDUSE_KINDS,
	WARNING_THRESHOLDS,
	WATER_LINE_CLASS,
	classifyLanduse,
	classifyRail,
	classifyRoad,
	classifyWaterArea,
	classifyWaterLine,
	isKnownLanduseKind,
	isOnRoadClass,
	isPassable,
	slopeFactor,
	type CellClass,
	type FeatureEffect,
	type RoadFeatureInput
} from '@/mapHandler/hoseCostModel';

const road = (
	kind: string,
	kindDetail = '',
	flags: Partial<RoadFeatureInput> = {}
): RoadFeatureInput => ({ kind, kindDetail, isBridge: false, isTunnel: false, ...flags });

const name = (effect: FeatureEffect) =>
	typeof effect === 'number' ? CELL_CLASS_NAME[effect] : effect;

describe('class factors', () => {
	const classes = Object.values(CELL_CLASS) as CellClass[];

	it('every class has a factor and a name', () => {
		for (const cell of classes) {
			expect(CLASS_FACTOR[cell], CELL_CLASS_NAME[cell]).toBeDefined();
			expect(CELL_CLASS_NAME[cell]).toBeTruthy();
		}
		expect(Object.keys(CLASS_FACTOR)).toHaveLength(classes.length);
		expect(new Set(classes).size).toBe(classes.length);
	});

	it('every factor is at least 1.0 (A* stays admissible)', () => {
		for (const cell of classes)
			expect(CLASS_FACTOR[cell], CELL_CLASS_NAME[cell]).toBeGreaterThanOrEqual(1);
	});

	it('has the plan values', () => {
		expect(CLASS_FACTOR[CELL_CLASS.ROAD]).toBe(1.0);
		expect(CLASS_FACTOR[CELL_CLASS.PATH]).toBe(1.05);
		expect(CLASS_FACTOR[CELL_CLASS.STEPS]).toBe(1.5);
		expect(CLASS_FACTOR[CELL_CLASS.BRIDGE]).toBe(1.0);
		expect(CLASS_FACTOR[CELL_CLASS.OPEN]).toBe(1.25);
		expect(CLASS_FACTOR[CELL_CLASS.UNKNOWN_OPEN]).toBe(1.3);
		expect(CLASS_FACTOR[CELL_CLASS.FOREST]).toBe(1.6);
		expect(CLASS_FACTOR[CELL_CLASS.YARD]).toBe(3.0);
		expect(CLASS_FACTOR[CELL_CLASS.RAIL_LANDUSE]).toBe(4);
		expect(CLASS_FACTOR[CELL_CLASS.STREAM]).toBe(4);
		expect(CLASS_FACTOR[CELL_CLASS.BUILDING_FRINGE]).toBe(6);
		expect(CLASS_FACTOR[CELL_CLASS.BUILDING_CORE]).toBe(Infinity);
		expect(CLASS_FACTOR[CELL_CLASS.BLOCKED]).toBe(Infinity);
	});

	it('only the walls are impassable', () => {
		expect(classes.filter((c) => !isPassable(c)).map((c) => CELL_CLASS_NAME[c])).toEqual([
			'BUILDING_CORE',
			'BLOCKED'
		]);
		expect(classes.filter(isOnRoadClass).map((c) => CELL_CLASS_NAME[c])).toEqual([
			'ROAD',
			'PATH',
			'STEPS',
			'BRIDGE'
		]);
	});
});

describe('classifyRoad: one case per row of the class table', () => {
	it.each<[string, RoadFeatureInput, string]>([
		['motorway is not a ROAD but a wall', road('highway', 'motorway'), 'BLOCKED'],
		['motorway_link', road('highway', 'motorway_link'), 'BLOCKED'],
		['primary', road('major_road', 'primary'), 'ROAD'],
		['secondary_link', road('major_road', 'secondary_link'), 'ROAD'],
		['medium_road', road('medium_road', 'secondary'), 'ROAD'],
		['residential', road('minor_road', 'residential'), 'ROAD'],
		['service', road('minor_road', 'service'), 'ROAD'],
		['raceway', road('minor_road', 'raceway'), 'ROAD'],
		['living_street (kind other)', road('other', 'living_street'), 'ROAD'],
		['busway', road('other', 'busway'), 'ROAD'],
		['platform', road('other', 'platform'), 'ROAD'],
		['path/path', road('path', 'path'), 'PATH'],
		['path/footway', road('path', 'footway'), 'PATH'],
		['path/cycleway', road('path', 'cycleway'), 'PATH'],
		['path/track', road('path', 'track'), 'PATH'],
		['path/pedestrian', road('path', 'pedestrian'), 'PATH'],
		['path/sidewalk', road('path', 'sidewalk'), 'PATH'],
		['path/crossing', road('path', 'crossing'), 'PATH'],
		['path/bridleway', road('path', 'bridleway'), 'PATH'],
		['path/pier', road('path', 'pier'), 'PATH'],
		['kind_detail=track under another kind', road('minor_road', 'track'), 'PATH'],
		['steps', road('path', 'steps'), 'STEPS'],
		['bridge: road', road('major_road', 'primary', { isBridge: true }), 'BRIDGE'],
		['bridge: path', road('path', 'footway', { isBridge: true }), 'BRIDGE'],
		['bridge: steps', road('path', 'steps', { isBridge: true }), 'BRIDGE'],
		['bridge: track', road('path', 'track', { isBridge: true }), 'BRIDGE']
	])('%s', (_label, input, expected) => {
		expect(name(classifyRoad(input))).toBe(expected);
	});

	it('assigns the factor of the class', () => {
		const factorOf = (input: RoadFeatureInput) => CLASS_FACTOR[classifyRoad(input) as CellClass];
		expect(factorOf(road('minor_road', 'residential'))).toBe(1.0);
		expect(factorOf(road('path', 'footway'))).toBe(1.05);
		expect(factorOf(road('path', 'steps'))).toBe(1.5);
		expect(factorOf(road('path', 'footway', { isBridge: true }))).toBe(1.0);
	});

	describe('owner decisions', () => {
		it('excludes ferry and path/corridor', () => {
			expect(classifyRoad(road('ferry', ''))).toBe('excluded');
			expect(classifyRoad(road('path', 'corridor'))).toBe('excluded');
			expect(classifyRoad(road('path', 'corridor', { access: 'private' }))).toBe('excluded');
		});

		it('excludes every tunnelled kind=path, keeps tunnelled roads passable', () => {
			for (const detail of ['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'sidewalk']) {
				expect(classifyRoad(road('path', detail, { isTunnel: true })), detail).toBe('excluded');
			}
			expect(name(classifyRoad(road('major_road', 'primary', { isTunnel: true })))).toBe('ROAD');
			expect(name(classifyRoad(road('minor_road', 'service', { isTunnel: true })))).toBe('ROAD');
			expect(name(classifyRoad(road('other', 'living_street', { isTunnel: true })))).toBe('ROAD');
		});

		it('excludes access=military on roads and paths, ignores every other access value', () => {
			expect(classifyRoad(road('minor_road', 'service', { access: 'military' }))).toBe('excluded');
			expect(classifyRoad(road('path', 'track', { access: 'military' }))).toBe('excluded');
			for (const access of [
				'private',
				'no',
				'customers',
				'permit',
				'destination',
				'emergency',
				'permissive',
				'designated',
				'agricultural',
				'discouraged',
				'yes'
			]) {
				expect(name(classifyRoad(road('minor_road', 'service', { access }))), access).toBe('ROAD');
				expect(name(classifyRoad(road('path', 'footway', { access }))), access).toBe('PATH');
			}
		});

		it('a motorway on a bridge or in a tunnel neither blocks nor is walkable', () => {
			expect(classifyRoad(road('highway', 'motorway', { isBridge: true }))).toBe('none');
			expect(classifyRoad(road('highway', 'motorway', { isTunnel: true }))).toBe('none');
			expect(classifyRoad(road('highway', 'motorway_link', { isBridge: true }))).toBe('none');
		});
	});
});

describe('classifyRail', () => {
	it.each(['rail', 'light_rail', 'narrow_gauge'])('%s on the surface blocks', (detail) => {
		expect(classifyRail({ kindDetail: detail, isBridge: false, isTunnel: false })).toBe(
			CELL_CLASS.BLOCKED
		);
		expect(classifyRoad(road('rail', detail))).toBe(CELL_CLASS.BLOCKED);
	});

	it.each(['tram', 'subway', 'disused', 'funicular', 'abandoned', ''])(
		'%s does not block',
		(detail) => {
			expect(classifyRail({ kindDetail: detail, isBridge: false, isTunnel: false })).toBe('none');
		}
	);

	it.each([
		['bridged', { isBridge: true, isTunnel: false }],
		['tunnelled', { isBridge: false, isTunnel: true }]
	])('heavy rail that is %s does not block', (_label, flags) => {
		for (const detail of ['rail', 'light_rail', 'narrow_gauge']) {
			expect(classifyRail({ kindDetail: detail, ...flags })).toBe('none');
		}
	});
});

describe('classifyLanduse', () => {
	it.each([
		['farmland', 'OPEN'],
		['meadow', 'OPEN'],
		['grass', 'OPEN'],
		['park', 'OPEN'],
		['pitch', 'OPEN'],
		['pedestrian', 'OPEN'],
		['cemetery', 'OPEN'],
		['recreation_ground', 'OPEN'],
		['forest', 'FOREST'],
		['wood', 'FOREST'],
		['scrub', 'FOREST'],
		['orchard', 'FOREST'],
		['residential', 'YARD'],
		['commercial', 'YARD'],
		['industrial', 'YARD'],
		['garden', 'YARD'],
		['allotments', 'YARD'],
		['railway', 'RAIL_LANDUSE'],
		['military', 'BLOCKED']
	])('%s is %s', (kind, expected) => {
		expect(CELL_CLASS_NAME[classifyLanduse(kind)]).toBe(expected);
	});

	it('maps an unknown or untuned kind to UNKNOWN_OPEN', () => {
		for (const kind of ['sand', 'hospital', 'kindergarten', 'zoo', 'something_new', '']) {
			expect(classifyLanduse(kind), kind).toBe(CELL_CLASS.UNKNOWN_OPEN);
		}
	});

	it('keeps the known and the untuned lists disjoint', () => {
		for (const kind of UNTUNED_LANDUSE_KINDS) expect(LANDUSE_CLASS[kind], kind).toBeUndefined();
		expect(isKnownLanduseKind('farmland')).toBe(true);
		expect(isKnownLanduseKind('sand')).toBe(true);
		expect(isKnownLanduseKind('zoo')).toBe(false);
	});
});

describe('water and cliffs', () => {
	it.each([
		['stream', '', 'STREAM'],
		['ditch', '', 'STREAM'],
		['drain', '', 'STREAM'],
		['river', '', 'BLOCKED'],
		['canal', '', 'BLOCKED'],
		// the plan expected the kind in kind_detail; the tiles carry it in kind
		['water', 'stream', 'STREAM'],
		['water', 'canal', 'BLOCKED'],
		['stream', 'river', 'BLOCKED']
	])('line kind %s / detail "%s" is %s', (kind, detail, expected) => {
		expect(CELL_CLASS_NAME[classifyWaterLine(kind, detail)]).toBe(expected);
	});

	it('an unlisted water line is crossable at the stream price, never a wall', () => {
		expect(classifyWaterLine('weir')).toBe(CELL_CLASS.STREAM);
		expect(Object.keys(WATER_LINE_CLASS).sort()).toEqual([
			'canal',
			'ditch',
			'drain',
			'river',
			'stream'
		]);
	});

	it('every water polygon and every cliff blocks', () => {
		for (const kind of ['water', 'lake', 'basin', 'swimming_pool', 'fountain', 'river', 'x']) {
			expect(classifyWaterArea(kind), kind).toBe(CELL_CLASS.BLOCKED);
		}
		expect(CLIFF_CLASS).toBe(CELL_CLASS.BLOCKED);
	});
});

describe('slopeFactor', () => {
	it.each([
		[0, 1.0],
		[0.08, 1.0],
		[0.25, 1.7],
		[0.5, 4.0],
		[0.8, 8.0],
		[1.0, 12],
		[1.5, 12],
		[10, 12]
	])('grade %f gives %f', (grade, expected) => {
		expect(slopeFactor(grade)).toBeCloseTo(expected, 10);
	});

	it('interpolates linearly between the points', () => {
		expect(slopeFactor(0.165)).toBeCloseTo(1.35, 10); // halfway 8 % .. 25 %
		expect(slopeFactor(0.375)).toBeCloseTo(2.85, 10); // halfway 25 % .. 50 %
		expect(slopeFactor(0.65)).toBeCloseTo(6.0, 10); // halfway 50 % .. 80 %
		expect(slopeFactor(0.9)).toBeCloseTo(10, 10); // halfway 80 % .. 100 %
	});

	it('is monotonic, never below 1 and symmetric in the sign of the grade', () => {
		let previous = 1;
		for (let g = 0; g <= 2; g += 0.005) {
			const f = slopeFactor(g);
			expect(f).toBeGreaterThanOrEqual(previous - 1e-12);
			expect(f).toBeGreaterThanOrEqual(1);
			expect(slopeFactor(-g)).toBe(f);
			previous = f;
		}
	});

	it('curve points are increasing in grade and factor', () => {
		for (let i = 1; i < SLOPE_CURVE.length; i++) {
			expect(SLOPE_CURVE[i][0]).toBeGreaterThan(SLOPE_CURVE[i - 1][0]);
			expect(SLOPE_CURVE[i][1]).toBeGreaterThan(SLOPE_CURVE[i - 1][1]);
		}
	});

	it('caps ROAD, PATH and STEPS at 1.3 at any grade', () => {
		for (const cell of [CELL_CLASS.ROAD, CELL_CLASS.PATH, CELL_CLASS.STEPS]) {
			expect(slopeFactor(0, cell)).toBe(1.0);
			expect(slopeFactor(0.08, cell)).toBe(1.0);
			expect(slopeFactor(0.5, cell)).toBe(ROAD_SLOPE_CAP);
			expect(slopeFactor(-1.5, cell)).toBe(ROAD_SLOPE_CAP);
		}
		expect(ROAD_SLOPE_CAP).toBe(1.3);
		// below the cap the curve applies unchanged
		expect(slopeFactor(0.12, CELL_CLASS.ROAD)).toBeCloseTo(slopeFactor(0.12), 10);
	});

	it('ignores slope on a BRIDGE', () => {
		for (const g of [0, 0.3, 1, -2]) expect(slopeFactor(g, CELL_CLASS.BRIDGE)).toBe(1.0);
	});

	it('does not cap open ground classes', () => {
		expect(slopeFactor(1, CELL_CLASS.OPEN)).toBe(12);
		expect(slopeFactor(0.5, CELL_CLASS.FOREST)).toBe(4);
	});
});

describe('warning thresholds', () => {
	it('match what the UI uses', () => {
		expect(WARNING_THRESHOLDS.steepGrade).toBe(0.25);
		expect(WARNING_THRESHOLDS.verySteepGrade).toBe(0.5);
		expect(WARNING_THRESHOLDS.minRunM).toBe(10);
		expect(WARNING_THRESHOLDS.steepTotalLimitM).toBe(50);
		expect(WARNING_THRESHOLDS.cautionShare).toBe(0.75);
		expect(WARNING_THRESHOLDS.warningShare).toBe(1);
		expect(WARNING_THRESHOLDS.barPerMetre).toBe(0.1);
		expect(WARNING_THRESHOLDS.defaultMaxHosePressureBar).toBe(16);
	});
});
