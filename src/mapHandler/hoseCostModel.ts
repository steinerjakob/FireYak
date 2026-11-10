import {
	MIN_RUN_M,
	STEEP_GRADE,
	STEEP_TOTAL_LIMIT_M,
	VERY_STEEP_GRADE
} from '@/helper/routeProfile';
import { BAR_PER_METRE, CAUTION_SHARE, DEFAULT_MAX_HOSE_PRESSURE_BAR } from '@/helper/hosePressure';
import type { RoadLine } from '@/types/obstacles';

/**
 * The hose cost model (plan §6.3, §6.4): cell classes, their cost factors, the
 * classifiers that map Protomaps features to a class, the slope factor and the
 * thresholds the UI warns at. One shared module, so the grid builder, the road
 * graph, the debug view and the specs agree on what a feature is.
 *
 * Pure module: no store, map, network or Capacitor imports; safe in a worker.
 * It is not used for routing yet (phase 3). All numbers are starting values to
 * tune on the validation scenes. Every factor is at least 1.0, which keeps the
 * A* heuristic (straight line x 1.0) admissible.
 */

/** Terrain classes of a grid cell. The numeric values are stable (grid arrays hold them). */
export const CELL_CLASS = {
	/** No landuse polygon, or a kind that is not tuned yet. */
	UNKNOWN_OPEN: 0,
	/** Farmland, meadow, grass, park, pitch, ... */
	OPEN: 1,
	FOREST: 2,
	/** Residential, commercial, industrial, garden, allotments: fences and hedges likely. */
	YARD: 3,
	/** `landuse=railway` ground. */
	RAIL_LANDUSE: 4,
	/** Stream, ditch or drain, buffered to one cell. */
	STREAM: 5,
	/** A footprint touches the cell, its centre is outside. */
	BUILDING_FRINGE: 6,
	/** The cell centre is inside a footprint. */
	BUILDING_CORE: 7,
	ROAD: 8,
	/** Path, footway, cycleway, track, pedestrian way, sidewalk, crossing. */
	PATH: 9,
	STEPS: 10,
	/** A passable road, path or steps on a bridge. */
	BRIDGE: 11,
	/** Water, heavy rail and motorway on the surface, cliffs, military ground. */
	BLOCKED: 12
} as const;

export type CellClass = (typeof CELL_CLASS)[keyof typeof CELL_CLASS];

/** Class names for the debug view and spec messages, indexed by class. */
export const CELL_CLASS_NAME: Record<CellClass, string> = {
	[CELL_CLASS.UNKNOWN_OPEN]: 'UNKNOWN_OPEN',
	[CELL_CLASS.OPEN]: 'OPEN',
	[CELL_CLASS.FOREST]: 'FOREST',
	[CELL_CLASS.YARD]: 'YARD',
	[CELL_CLASS.RAIL_LANDUSE]: 'RAIL_LANDUSE',
	[CELL_CLASS.STREAM]: 'STREAM',
	[CELL_CLASS.BUILDING_FRINGE]: 'BUILDING_FRINGE',
	[CELL_CLASS.BUILDING_CORE]: 'BUILDING_CORE',
	[CELL_CLASS.ROAD]: 'ROAD',
	[CELL_CLASS.PATH]: 'PATH',
	[CELL_CLASS.STEPS]: 'STEPS',
	[CELL_CLASS.BRIDGE]: 'BRIDGE',
	[CELL_CLASS.BLOCKED]: 'BLOCKED'
};

/**
 * Cost factor per class (multiplies the step length). `Infinity` = impassable.
 * `BUILDING_CORE` is impassable except inside the escape radius, where it costs
 * {@link BUILDING_CORE_ESCAPE_FACTOR}.
 */
export const CLASS_FACTOR: Record<CellClass, number> = {
	[CELL_CLASS.UNKNOWN_OPEN]: 1.3,
	[CELL_CLASS.OPEN]: 1.25,
	[CELL_CLASS.FOREST]: 1.6,
	[CELL_CLASS.YARD]: 3.0,
	[CELL_CLASS.RAIL_LANDUSE]: 4,
	[CELL_CLASS.STREAM]: 4,
	[CELL_CLASS.BUILDING_FRINGE]: 6,
	[CELL_CLASS.BUILDING_CORE]: Infinity,
	[CELL_CLASS.ROAD]: 1.0,
	[CELL_CLASS.PATH]: 1.05,
	[CELL_CLASS.STEPS]: 1.5,
	[CELL_CLASS.BRIDGE]: 1.0,
	[CELL_CLASS.BLOCKED]: Infinity
};

/** Factor of a building core cell within the escape radius of the origin or target. */
export const BUILDING_CORE_ESCAPE_FACTOR = 30;
/** Radius around the origin and the target within which building cores are passable (m). */
export const ESCAPE_RADIUS_M = 12;

/** True for classes a route may enter (finite factor, core escape aside). */
export function isPassable(cell: CellClass): boolean {
	return Number.isFinite(CLASS_FACTOR[cell]);
}

/** Classes that count as "on a road" for the off-road display and the slope cap. */
export function isOnRoadClass(cell: CellClass): boolean {
	return (
		cell === CELL_CLASS.ROAD ||
		cell === CELL_CLASS.PATH ||
		cell === CELL_CLASS.STEPS ||
		cell === CELL_CLASS.BRIDGE
	);
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

/**
 * What a linear feature does to the grid and the road graph:
 * - a {@link CellClass}: it paints cells of that class (`BLOCKED` = a wall);
 * - `'excluded'`: removed from graph and grid (ferries, indoor corridors,
 *   tunnelled paths, military access);
 * - `'none'`: drawn nowhere and blocks nothing (tram, subway, bridged or
 *   tunnelled motorway, bridged or tunnelled rail).
 */
export type FeatureEffect = CellClass | 'excluded' | 'none';

/** The `roads`/`rails` fields {@link classifyRoad} reads. */
export type RoadFeatureInput = Pick<RoadLine, 'kind' | 'kindDetail' | 'isBridge' | 'isTunnel'> &
	Partial<Pick<RoadLine, 'access'>>;

/** `kind_detail` values of `kind=rail` that block the ground when on the surface. */
export const HEAVY_RAIL_DETAILS: ReadonlySet<string> = new Set([
	'rail',
	'light_rail',
	'narrow_gauge'
]);

/** `kind_detail` values of `kind=path` priced as {@link CELL_CLASS.PATH} (others under `path` too). */
export const PATH_DETAILS: ReadonlySet<string> = new Set([
	'path',
	'footway',
	'cycleway',
	'track',
	'pedestrian',
	'sidewalk',
	'crossing',
	'bridleway',
	'pier'
]);

/** Rail: heavy rail on the surface blocks; tram, subway, disused, tunnelled, bridged do not. */
export function classifyRail(
	rail: Pick<RoadFeatureInput, 'kindDetail' | 'isBridge' | 'isTunnel'>
): FeatureEffect {
	if (rail.isBridge || rail.isTunnel) return 'none';
	return HEAVY_RAIL_DETAILS.has(rail.kindDetail) ? CELL_CLASS.BLOCKED : 'none';
}

/**
 * Class of a `roads` feature. `access` and `oneway` are ignored (the fire
 * service may enter private ground) except `access=military`, which is excluded.
 * Passable ways on a bridge are `BRIDGE`; tunnelled roads stay passable, tunnelled
 * paths are excluded (most are underground passages).
 */
export function classifyRoad(road: RoadFeatureInput): FeatureEffect {
	const { kind, kindDetail, isBridge, isTunnel } = road;
	if (kind === 'ferry') return 'excluded';
	if (kind === 'rail') return classifyRail(road);
	if (road.access === 'military') return 'excluded';
	if (kind === 'path') {
		if (kindDetail === 'corridor') return 'excluded';
		if (isTunnel) return 'excluded';
	}
	if (kind === 'highway') {
		// Motorway and motorway_link: a wall on the surface, not drawn when bridged or tunnelled.
		return isBridge || isTunnel ? 'none' : CELL_CLASS.BLOCKED;
	}
	if (isBridge) return CELL_CLASS.BRIDGE;
	if (kindDetail === 'steps') return CELL_CLASS.STEPS;
	if (kind === 'path' || kindDetail === 'track') return CELL_CLASS.PATH;
	return CELL_CLASS.ROAD;
}

/** `landuse` kinds by class (plan §6.3). Anything else is {@link CELL_CLASS.UNKNOWN_OPEN}. */
export const LANDUSE_CLASS: Readonly<Record<string, CellClass>> = {
	farmland: CELL_CLASS.OPEN,
	meadow: CELL_CLASS.OPEN,
	grass: CELL_CLASS.OPEN,
	park: CELL_CLASS.OPEN,
	pitch: CELL_CLASS.OPEN,
	pedestrian: CELL_CLASS.OPEN,
	cemetery: CELL_CLASS.OPEN,
	recreation_ground: CELL_CLASS.OPEN,
	forest: CELL_CLASS.FOREST,
	wood: CELL_CLASS.FOREST,
	scrub: CELL_CLASS.FOREST,
	orchard: CELL_CLASS.FOREST,
	residential: CELL_CLASS.YARD,
	commercial: CELL_CLASS.YARD,
	industrial: CELL_CLASS.YARD,
	garden: CELL_CLASS.YARD,
	allotments: CELL_CLASS.YARD,
	railway: CELL_CLASS.RAIL_LANDUSE,
	military: CELL_CLASS.BLOCKED
};

/**
 * Landuse kinds seen in the validation scenes (and plan §4.1) that are priced as
 * {@link CELL_CLASS.UNKNOWN_OPEN} until they are tuned. Listed so the fixture
 * spec can tell a known gap from a kind nobody has looked at.
 */
export const UNTUNED_LANDUSE_KINDS: readonly string[] = [
	'dam',
	'dog_park',
	'grassland',
	'hospital',
	'kindergarten',
	'pier',
	'platform',
	'playground',
	'sand',
	'school',
	'university'
];

export function classifyLanduse(kind: string): CellClass {
	return LANDUSE_CLASS[kind] ?? CELL_CLASS.UNKNOWN_OPEN;
}

/** True when the landuse kind has a class or is on the untuned list. */
export function isKnownLanduseKind(kind: string): boolean {
	return kind in LANDUSE_CLASS || UNTUNED_LANDUSE_KINDS.includes(kind);
}

/** Water line kinds by class: small channels are crossable at a cost, rivers and canals are not. */
export const WATER_LINE_CLASS: Readonly<Record<string, CellClass>> = {
	stream: CELL_CLASS.STREAM,
	ditch: CELL_CLASS.STREAM,
	drain: CELL_CLASS.STREAM,
	river: CELL_CLASS.BLOCKED,
	canal: CELL_CLASS.BLOCKED
};

/**
 * Class of a `water` line. The Protomaps tiles carry the water kind in `kind`
 * (river, stream, drain); the plan expected it in `kind_detail`, so both are
 * read, `kind_detail` first. An unlisted kind is crossable at the stream price,
 * never a wall.
 */
export function classifyWaterLine(kind: string, kindDetail = ''): CellClass {
	return WATER_LINE_CLASS[kindDetail] ?? WATER_LINE_CLASS[kind] ?? CELL_CLASS.STREAM;
}

/** Every water polygon (water, lake, basin, swimming pool, fountain) blocks. */
export function classifyWaterArea(_kind: string): CellClass {
	return CELL_CLASS.BLOCKED;
}

/** Cliff lines are walls. */
export const CLIFF_CLASS: CellClass = CELL_CLASS.BLOCKED;

// ---------------------------------------------------------------------------
// Slope
// ---------------------------------------------------------------------------

/** Grade (|dh| / horizontal) to factor points; linear in between, capped after the last. */
export const SLOPE_CURVE: readonly (readonly [grade: number, factor: number])[] = [
	[0.08, 1.0],
	[0.25, 1.7],
	[0.5, 4.0],
	[0.8, 8.0],
	[1.0, 12.0]
];

/** Largest slope factor on road, path and steps cells (roads are built for slopes). */
export const ROAD_SLOPE_CAP = 1.3;

/**
 * Cost factor for a step of grade `grade` (signed; up and down cost the same).
 * `cellClass` is the class that governs the step: on `ROAD`, `PATH` and `STEPS`
 * the factor is capped at {@link ROAD_SLOPE_CAP}; on `BRIDGE` slope is ignored.
 * Never below 1.0.
 */
export function slopeFactor(grade: number, cellClass?: CellClass): number {
	if (cellClass === CELL_CLASS.BRIDGE) return 1.0;
	const g = Math.abs(grade);
	let factor: number;
	if (!(g > SLOPE_CURVE[0][0])) {
		factor = 1.0;
	} else if (g >= SLOPE_CURVE[SLOPE_CURVE.length - 1][0]) {
		factor = SLOPE_CURVE[SLOPE_CURVE.length - 1][1];
	} else {
		let i = 1;
		while (g > SLOPE_CURVE[i][0]) i++;
		const [g0, f0] = SLOPE_CURVE[i - 1];
		const [g1, f1] = SLOPE_CURVE[i];
		factor = f0 + ((f1 - f0) * (g - g0)) / (g1 - g0);
	}
	if (
		cellClass === CELL_CLASS.ROAD ||
		cellClass === CELL_CLASS.PATH ||
		cellClass === CELL_CLASS.STEPS
	) {
		return Math.min(factor, ROAD_SLOPE_CAP);
	}
	return factor;
}

// ---------------------------------------------------------------------------
// Warning thresholds (plan §6.8, §6.13): one place, the values live with their users
// ---------------------------------------------------------------------------

/** Thresholds the UI warns at; the numbers are defined in `routeProfile.ts` and `hosePressure.ts`. */
export const WARNING_THRESHOLDS = {
	/** Grade above which a stretch is steep (amber). */
	steepGrade: STEEP_GRADE,
	/** Grade above which a stretch is very steep (red). */
	verySteepGrade: VERY_STEEP_GRADE,
	/** Steep runs shorter than this are not shown and do not count (m). */
	minRunM: MIN_RUN_M,
	/** More than this many metres above the steep grade make a route "not recommended". */
	steepTotalLimitM: STEEP_TOTAL_LIMIT_M,
	/** Share of the maximum working pressure from which "check pressure" shows. */
	cautionShare: CAUTION_SHARE,
	/** Share from which the route is "not recommended". */
	warningShare: 1,
	/** Static pressure per metre of drop (bar/m). */
	barPerMetre: BAR_PER_METRE,
	/** Default maximum hose working pressure (bar). */
	defaultMaxHosePressureBar: DEFAULT_MAX_HOSE_PRESSURE_BAR
} as const;
