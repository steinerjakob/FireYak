import { describe, expect, it, vi } from 'vitest';
import { distanceTo } from '@/types/geo';
import { emptyObstacleData } from '@/mapHandler/obstacleDecode';
import type { BuildingPolygon, ObstacleData, RoadLine } from '@/types/obstacles';
import { segmentIntersectsPolygon } from '@/helper/polygonGeometry';
import { distanceToOutline, nearestPointOnOutline } from '@/helper/areaShore';
import {
	GRID_CELL_M,
	SMOOTH_COST_TOLERANCE,
	SMOOTH_SLACK_M,
	astarRoute,
	buildOptimizedGrid,
	escapeZone,
	gridFrameOf,
	gridRouteFromOrigin,
	gridRoutePath,
	gridRouteSingle,
	lineCost,
	setGridHeights,
	shoreGoalCells,
	simplifyGated,
	solveTerrain,
	terrainSolveStats,
	type GridGoal,
	type TerrainGrid
} from '@/mapHandler/gridRouting';
import { accessTargetFor } from '@/mapHandler/waterSourceAccess';
import { heightAtGrid, type HeightRaster } from '@/helper/demRaster';
import { gridX, gridY } from '@/mapHandler/costGrid';
import type { OverPassElement } from '@/mapHandler/overPassApi';
import type { AreaPolygon, LinearFeature, WaterPolygon } from '@/types/obstacles';

// waterSourceAccess reads IndexedDB, Overpass and the tile protocol; only its pure
// `accessTargetFor` is used here.
vi.mock('@/mapHandler/areaOutline', () => ({
	cachedOutline: () => undefined,
	getAreaOutline: async () => null
}));
vi.mock('@/mapHandler/databaseHandler', () => ({ getMapNodesForView: async () => [] }));
vi.mock('@/mapHandler/obstacleGeometry', () => ({ waterOutlineAt: async () => null }));

// Synthetic scene in a local metre frame: a 200 m x 200 m window at (48, 15).
const LAT = 48;
const LNG = 15;
const M_PER_DEG_LAT = 110_540;
const mPerDegLng = Math.cos(((LAT + 100 / M_PER_DEG_LAT) * Math.PI) / 180) * 111_320;
const at = (xM: number, yM: number) => ({
	lng: LNG + xM / mPerDegLng,
	lat: LAT + yM / M_PER_DEG_LAT
});
const BOUNDS = {
	south: LAT,
	west: LNG,
	north: LAT + 200 / M_PER_DEG_LAT,
	east: LNG + 200 / mPerDegLng
};

function polygon(corners: [number, number][]): BuildingPolygon {
	const ring = corners.map(([x, y]) => {
		const p = at(x, y);
		return [p.lng, p.lat] as [number, number];
	});
	ring.push(ring[0]);
	const lngs = ring.map((p) => p[0]);
	const lats = ring.map((p) => p[1]);
	return {
		bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
		rings: [ring]
	};
}

function roadLine(...points: [number, number][]): RoadLine {
	const pts = points.map(([x, y]) => {
		const p = at(x, y);
		return [p.lng, p.lat] as [number, number];
	});
	return {
		bbox: [
			Math.min(...pts.map((p) => p[0])),
			Math.min(...pts.map((p) => p[1])),
			Math.max(...pts.map((p) => p[0])),
			Math.max(...pts.map((p) => p[1]))
		],
		points: pts,
		kind: 'minor_road',
		kindDetail: 'residential',
		isBridge: false,
		isTunnel: false
	};
}

/** Centre of grid cell (col, row). */
function centreOf(grid: TerrainGrid, col: number, row: number) {
	return {
		lng: grid.west + ((col + 0.5) * GRID_CELL_M) / grid.mPerDegLng,
		lat: grid.south + ((row + 0.5) * GRID_CELL_M) / M_PER_DEG_LAT
	};
}

function build(obstacles: Partial<ObstacleData>): TerrainGrid {
	const grid = buildOptimizedGrid({ ...emptyObstacleData(), ...obstacles }, BOUNDS);
	if (!grid) throw new Error('grid not built');
	return grid;
}

describe('open ground', () => {
	it('returns null when the origin lies outside the window', () => {
		const grid = build({});
		expect(solveTerrain(grid, at(-500, -500))).toBeNull();
	});

	it('routes straight across empty ground: path is the two endpoints', () => {
		const grid = build({});
		const from = at(20, 20);
		const to = at(180, 160);
		const path = gridRoutePath(grid, from, to)!;
		expect(path).toEqual([from, to]);
		const result = solveTerrain(grid, from)!.distanceTo(to)!;
		// 8-connected cells overshoot a little; the route is never shorter than the line.
		const straight = distanceTo(from, to);
		expect(result.meters).toBeGreaterThanOrEqual(straight);
		expect(result.meters).toBeLessThan(straight * 1.1);
	});

	it('goes around a building rather than through it', () => {
		const wall = polygon([
			[90, 40],
			[110, 40],
			[110, 160],
			[90, 160]
		]);
		const grid = build({ buildings: [wall] });
		const from = at(30, 100);
		const to = at(170, 100);
		const result = solveTerrain(grid, from)!.distanceTo(to)!;
		expect(result.meters).toBeGreaterThan(distanceTo(from, to) * 1.3);
	});
});

describe('smoothing', () => {
	/** True when any segment of `path` enters `building` (sampled every 0.25 m). */
	function crossesBuilding(
		path: { lng: number; lat: number }[],
		building: BuildingPolygon
	): boolean {
		const ring = building.rings[0];
		const inside = (lng: number, lat: number) => {
			let c = false;
			for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
				const [xi, yi] = ring[i];
				const [xj, yj] = ring[j];
				if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
			}
			return c;
		};
		for (let i = 0; i < path.length - 1; i++) {
			const steps = Math.ceil(distanceTo(path[i], path[i + 1]) * 4);
			for (let s = 0; s <= steps; s++) {
				const f = s / steps;
				const lng = path[i].lng + (path[i + 1].lng - path[i].lng) * f;
				const lat = path[i].lat + (path[i + 1].lat - path[i].lat) * f;
				if (inside(lng, lat)) return true;
			}
		}
		return false;
	}

	// L-shaped building: a bar along y 90..96 and a bar up x 60..66. The origin
	// stands in the pocket of the L.
	const lShape = polygon([
		[60, 90],
		[140, 90],
		[140, 96],
		[66, 96],
		[66, 140],
		[60, 140]
	]);
	const origin = at(75.65, 107.65);
	const target = at(130.07, 74.46);

	it('finds a path between the pocket and the far side', () => {
		const grid = build({ buildings: [lShape] });
		expect(gridRoutePath(grid, origin, target)).not.toBeNull();
	});

	// Fixed in phase 1 (plan section 3.3): smoothing now starts at the true
	// origin and tests every segment exactly against the footprint edges.
	it('keeps the smoothed line out of the building', () => {
		const grid = build({ buildings: [lShape] });
		const path = gridRoutePath(grid, origin, target)!;
		expect(crossesBuilding(path, lShape)).toBe(false);
	});
});

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const polylineLength = (path: { lng: number; lat: number }[]) => {
	let total = 0;
	for (let i = 0; i < path.length - 1; i++) total += distanceTo(path[i], path[i + 1]);
	return total;
};

describe('exact building test (property)', () => {
	interface Rect {
		x0: number;
		y0: number;
		x1: number;
		y1: number;
	}
	const gap = (a: Rect, b: Rect) =>
		Math.max(a.x0 - b.x1, b.x0 - a.x1, 0) + Math.max(a.y0 - b.y1, b.y0 - a.y1, 0);
	const clearance = (x: number, y: number, r: Rect) =>
		Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));

	/** Random layout: 3-8 rectangles of 10-30 m, at least 24 m apart. */
	function layout(next: () => number): Rect[] {
		const rects: Rect[] = [];
		const count = 3 + Math.floor(next() * 6);
		for (let tries = 0; rects.length < count && tries < 200; tries++) {
			const w = 10 + next() * 20;
			const h = 10 + next() * 20;
			const x0 = 10 + next() * (180 - w);
			const y0 = 10 + next() * (180 - h);
			const r = { x0, y0, x1: x0 + w, y1: y0 + h };
			if (rects.every((o) => gap(o, r) >= 24)) rects.push(r);
		}
		return rects;
	}

	function freePoint(next: () => number, rects: Rect[]): [number, number] {
		for (;;) {
			const x = 5 + next() * 190;
			const y = 5 + next() * 190;
			if (rects.every((r) => clearance(x, y, r) >= 12)) return [x, y];
		}
	}

	it('200 seeded layouts: no output segment touches a building', () => {
		const next = rng(20261110);
		let checked = 0;
		for (let n = 0; n < 200; n++) {
			const rects = layout(next);
			const buildings = rects.map((r) =>
				polygon([
					[r.x0, r.y0],
					[r.x1, r.y0],
					[r.x1, r.y1],
					[r.x0, r.y1]
				])
			);
			const grid = build({ buildings });
			const from = at(...freePoint(next, rects));
			const to = at(...freePoint(next, rects));
			const path = gridRoutePath(grid, from, to);
			expect(path).not.toBeNull();
			expect(path![0]).toEqual(from);
			expect(path![path!.length - 1]).toEqual(to);
			for (let i = 0; i < path!.length - 1; i++) {
				const a: [number, number] = [path![i].lng, path![i].lat];
				const b: [number, number] = [path![i + 1].lng, path![i + 1].lat];
				for (const building of buildings) {
					expect(segmentIntersectsPolygon(a, b, building), `layout ${n}, segment ${i}`).toBe(false);
				}
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(200);
	});
});

describe('early exit and memoisation (plan section 6.5)', () => {
	const obstacles = {
		buildings: [
			polygon([
				[60, 60],
				[140, 60],
				[140, 80],
				[60, 80]
			]),
			polygon([
				[30, 120],
				[90, 120],
				[90, 170],
				[30, 170]
			])
		],
		roads: [roadLine([0, 100], [200, 100])]
	};
	const origin = at(100, 20);
	const targets = [at(100, 150), at(20, 190), at(180, 40), at(150, 180), at(10, 10)];

	it('the early-exit solve equals the full solve for the queried targets', () => {
		const lazy = solveTerrain(build(obstacles), origin)!;
		const lazyResults = targets.map((t) => lazy.distanceTo(t));
		const full = solveTerrain(build(obstacles), origin)!;
		full.solveAll();
		const fullResults = targets.map((t) => full.distanceTo(t));
		expect(lazyResults).toEqual(fullResults);
		expect(lazyResults.every((r) => r !== null)).toBe(true);
	});

	it('a second query from the same origin cell reuses the memoised solve', () => {
		const grid = build(obstacles);
		const before = terrainSolveStats.solves;
		gridRouteFromOrigin(
			grid,
			origin,
			targets.map((point) => ({ kind: 'point' as const, point }))
		);
		// Same cell, a metre away: the selected-marker path after the list search.
		gridRoutePath(grid, at(101, 21), targets[0]);
		expect(terrainSolveStats.solves - before).toBe(1);
		gridRoutePath(grid, at(30, 30), targets[0]);
		expect(terrainSolveStats.solves - before).toBe(2);
	});

	it('reported meters equal the polyline length', () => {
		const grid = build(obstacles);
		const routes = gridRouteFromOrigin(
			grid,
			origin,
			targets.map((point) => ({ kind: 'point' as const, point }))
		);
		for (const route of routes) {
			expect(route).not.toBeNull();
			expect(Math.abs(route!.meters - polylineLength(route!.points))).toBeLessThan(0.01);
		}
	});
});

describe('shore goal sets', () => {
	// A 60 x 40 m pond with its near shore 60 m north of the origin.
	const pond: GeoJSON.Polygon = {
		type: 'Polygon',
		coordinates: [
			[
				[70, 120],
				[130, 120],
				[130, 160],
				[70, 160],
				[70, 120]
			].map(([x, y]) => {
				const p = at(x, y);
				return [p.lng, p.lat];
			})
		]
	};

	it('ends exactly on the outline at the nearest reachable shore', () => {
		const grid = build({});
		const [route] = gridRouteFromOrigin(grid, at(100, 60), [{ kind: 'shore', outline: pond }]);
		expect(route).not.toBeNull();
		expect(distanceToOutline(pond, route!.endpoint)).toBeLessThan(0.01);
		expect(route!.points[route!.points.length - 1]).toEqual(route!.endpoint);
		// Straight north: about 60 m, never the 75 m to a far corner.
		expect(route!.meters).toBeGreaterThan(55);
		expect(route!.meters).toBeLessThan(66);
	});

	it('goes around a building that blocks the near shore', () => {
		const wall = polygon([
			[50, 90],
			[150, 90],
			[150, 110],
			[50, 110]
		]);
		const grid = build({ buildings: [wall] });
		const [route] = gridRouteFromOrigin(grid, at(100, 60), [{ kind: 'shore', outline: pond }]);
		expect(route).not.toBeNull();
		expect(distanceToOutline(pond, route!.endpoint)).toBeLessThan(0.01);
		for (let i = 0; i < route!.points.length - 1; i++) {
			const a: [number, number] = [route!.points[i].lng, route!.points[i].lat];
			const b: [number, number] = [route!.points[i + 1].lng, route!.points[i + 1].lat];
			expect(segmentIntersectsPolygon(a, b, wall)).toBe(false);
		}
	});

	it('returns null for an outline outside the grid', () => {
		const far: GeoJSON.Polygon = {
			type: 'Polygon',
			coordinates: [
				[
					[16, 49],
					[16.001, 49],
					[16.001, 49.001],
					[16, 49]
				]
			]
		};
		expect(gridRouteFromOrigin(build({}), at(100, 60), [{ kind: 'shore', outline: far }])).toEqual([
			null
		]);
	});
});

// ---------------------------------------------------------------------------
// optimized model (plan sections 6.3, 6.5, 6.6)
// ---------------------------------------------------------------------------

const lngLat = (x: number, y: number): [number, number] => {
	const p = at(x, y);
	return [p.lng, p.lat];
};

function areaRect(kind: string, x0: number, y0: number, x1: number, y1: number): AreaPolygon {
	const poly = polygon([
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1]
	]);
	return { ...poly, kind, areaM2: (x1 - x0) * (y1 - y0) };
}

function linear(kind: string, kindDetail: string, ...points: [number, number][]): LinearFeature {
	const pts = points.map(([x, y]) => lngLat(x, y));
	return {
		bbox: [
			Math.min(...pts.map((p) => p[0])),
			Math.min(...pts.map((p) => p[1])),
			Math.max(...pts.map((p) => p[0])),
			Math.max(...pts.map((p) => p[1]))
		],
		points: pts,
		kind,
		kindDetail,
		isBridge: false,
		isTunnel: false
	};
}

const LANDUSE_KINDS = ['farmland', 'forest', 'residential', 'park', 'railway', 'garden', 'school'];

/**
 * Random optimized scene: landuse patches, buildings, maybe a water body, a
 * stream, a heavy-rail line with a level crossing, and a few roads and paths.
 */
function randomScene(next: () => number): Partial<ObstacleData> {
	const r = (lo: number, hi: number) => lo + next() * (hi - lo);
	const landuse: AreaPolygon[] = [];
	for (let i = 0, n = 2 + Math.floor(next() * 5); i < n; i++) {
		const x0 = r(0, 150);
		const y0 = r(0, 150);
		landuse.push(
			areaRect(
				LANDUSE_KINDS[Math.floor(next() * LANDUSE_KINDS.length)],
				x0,
				y0,
				x0 + r(20, 120),
				y0 + r(20, 120)
			)
		);
	}
	const buildings = [];
	for (let i = 0, n = Math.floor(next() * 7); i < n; i++) {
		const x0 = r(5, 170);
		const y0 = r(5, 170);
		buildings.push(
			polygon([
				[x0, y0],
				[x0 + r(6, 30), y0],
				[x0 + r(6, 30), y0 + r(6, 30)],
				[x0, y0 + r(6, 30)]
			])
		);
	}
	// Roads drawn over a footprint are passages (passable by design): keep the
	// random houses off the random roads so the building-edge property is meaningful.
	const roads: RoadLine[] = [];
	for (let i = 0, n = 1 + Math.floor(next() * 3); i < n; i++) {
		const road = roadLine([r(0, 200), 0], [r(0, 200), 200]);
		if (next() < 0.4) road.kind = 'path';
		if (next() < 0.4) road.kindDetail = 'footway';
		roads.push(road);
	}
	const clearOfRoads = buildings.filter(
		(b) => !roads.some((road) => segmentIntersectsPolygon(road.points[0], road.points[1], b))
	);
	const waterAreas: WaterPolygon[] = [];
	if (next() < 0.4) {
		const x0 = r(20, 150);
		const y0 = r(20, 150);
		waterAreas.push({
			...areaRect('water', x0, y0, x0 + r(10, 40), y0 + r(10, 40)),
			tile: '15/0/0'
		});
	}
	const waterLines = next() < 0.5 ? [linear('stream', '', [r(0, 200), 0], [r(0, 200), 200])] : [];
	const rails = next() < 0.5 ? [linear('rail', 'rail', [0, r(30, 170)], [200, r(30, 170)])] : [];
	return { landuse, buildings: clearOfRoads, waterAreas, waterLines, rails, roads };
}

function randomPoint(next: () => number) {
	return at(3 + next() * 194, 3 + next() * 194);
}

/** Dijkstra cost A → B (true endpoints, escape zones of both), or null. */
function dijkstraCost(
	grid: TerrainGrid,
	a: { lng: number; lat: number },
	b: { lng: number; lat: number }
) {
	grid.solve = undefined;
	return solveTerrain(grid, a, [b])!.distanceTo(b)?.cost ?? null;
}

describe('optimized: symmetric step cost and A* (plan section 6.5)', () => {
	it('100 seeded random grids: cost A to B equals cost B to A', () => {
		const next = rng(31337);
		let compared = 0;
		for (let n = 0; n < 100; n++) {
			const grid = buildOptimizedGrid({ ...emptyObstacleData(), ...randomScene(next) }, BOUNDS)!;
			const a = randomPoint(next);
			const b = randomPoint(next);
			const ab = dijkstraCost(grid, a, b);
			const ba = dijkstraCost(grid, b, a);
			if (ab === null || ba === null) {
				expect(ab, `grid ${n}`).toBe(ba);
				continue;
			}
			expect(Math.abs(ab - ba), `grid ${n}`).toBeLessThan(1e-9 * Math.max(1, ab));
			compared++;
		}
		expect(compared).toBeGreaterThan(70);
	});

	it('A* cost equals Dijkstra cost on the same 100 cases (admissible heuristic)', () => {
		const next = rng(31337);
		let compared = 0;
		for (let n = 0; n < 100; n++) {
			const grid = buildOptimizedGrid({ ...emptyObstacleData(), ...randomScene(next) }, BOUNDS)!;
			const a = randomPoint(next);
			const b = randomPoint(next);
			const dijkstra = dijkstraCost(grid, a, b);
			const astar = astarRoute(grid, a, { kind: 'point', point: b });
			if (dijkstra === null) {
				expect(astar, `grid ${n}`).toBeNull();
				continue;
			}
			expect(Math.abs(astar!.cost - dijkstra), `grid ${n}`).toBeLessThan(
				1e-9 * Math.max(1, dijkstra)
			);
			compared++;
		}
		expect(compared).toBeGreaterThan(70);
	});

	it('A* settles fewer cells than the full field', () => {
		const grid = buildOptimizedGrid(emptyObstacleData(), BOUNDS)!;
		const before = terrainSolveStats.astar;
		const route = astarRoute(grid, at(20, 100), { kind: 'point', point: at(60, 100) })!;
		expect(terrainSolveStats.astar - before).toBe(1);
		expect(route.meters).toBeCloseTo(40, 0);
	});

	it('a single path after the list search reuses the list field (same chain, same metres)', () => {
		const grid = buildOptimizedGrid({ ...emptyObstacleData(), ...randomScene(rng(5)) }, BOUNDS)!;
		const origin = at(20, 20);
		const targets = [at(180, 180), at(30, 170), at(170, 40)];
		const listed = gridRouteFromOrigin(
			grid,
			origin,
			targets.map((point): GridGoal => ({ kind: 'point', point }))
		);
		const astarBefore = terrainSolveStats.astar;
		const single = gridRouteSingle(grid, origin, { kind: 'point', point: targets[0] });
		expect(terrainSolveStats.astar).toBe(astarBefore);
		expect(single?.meters).toBe(listed[0]?.meters);
	});
});

describe('optimized: blocked classes and escape', () => {
	it('heavy rail is crossed only at the level crossing', () => {
		const grid = buildOptimizedGrid(
			{
				...emptyObstacleData(),
				rails: [linear('rail', 'rail', [0, 100], [200, 100])],
				roads: [roadLine([150, 0], [150, 200])]
			},
			BOUNDS
		)!;
		const route = gridRouteSingle(grid, at(40, 60), { kind: 'point', point: at(40, 140) })!;
		// Around via the crossing at x = 150: 2 x sqrt(110^2 + 40^2) = 234 m at least.
		expect(route.meters).toBeGreaterThan(230);
		const y = (lat: number) => (lat - LAT) * M_PER_DEG_LAT;
		const x = (lng: number) => (lng - LNG) * mPerDegLng;
		const crossing = route.points.some((p, i) => {
			const q = route.points[i + 1];
			if (!q || (y(p.lat) - 100) * (y(q.lat) - 100) > 0) return false;
			const f = (100 - y(p.lat)) / (y(q.lat) - y(p.lat));
			return Math.abs(x(p.lng) + f * (x(q.lng) - x(p.lng)) - 150) < 8;
		});
		expect(crossing).toBe(true);
	});

	it('a target inside a building is reached through the escape zone', () => {
		const house = polygon([
			[90, 90],
			[110, 90],
			[110, 110],
			[90, 110]
		]);
		const grid = buildOptimizedGrid({ ...emptyObstacleData(), buildings: [house] }, BOUNDS)!;
		const route = gridRouteSingle(grid, at(20, 100), { kind: 'point', point: at(100, 100) });
		expect(route).not.toBeNull();
		expect(route!.points.at(-1)).toEqual(at(100, 100));
	});

	it('a target deep inside a large building (beyond the escape radius of its walls) is unreached', () => {
		const block = polygon([
			[40, 40],
			[160, 40],
			[160, 160],
			[40, 160]
		]);
		const grid = buildOptimizedGrid({ ...emptyObstacleData(), buildings: [block] }, BOUNDS)!;
		expect(gridRouteSingle(grid, at(10, 10), { kind: 'point', point: at(100, 100) })).toBeNull();
	});
});

describe('optimized: goal sets for ponds', () => {
	// 60 x 40 m pond, near shore 60 m north of the origin; a wall in front of it.
	const pondRing = [
		[70, 120],
		[130, 120],
		[130, 160],
		[70, 160],
		[70, 120]
	].map(([x, y]) => lngLat(x, y));
	const pond: GeoJSON.Polygon = { type: 'Polygon', coordinates: [pondRing] };
	const obstacles: ObstacleData = {
		...emptyObstacleData(),
		waterAreas: [{ ...areaRect('water', 70, 120, 130, 160), tile: '15/0/0' }],
		buildings: [
			polygon([
				[60, 90],
				[115, 90],
				[115, 105],
				[60, 105]
			])
		],
		landuse: [areaRect('farmland', 0, 0, 200, 200)]
	};
	const origin = at(95, 50);

	it('the returned goal is the minimum-cost goal cell, and A* agrees with Dijkstra', () => {
		const grid = buildOptimizedGrid(obstacles, BOUNDS)!;
		const astar = astarRoute(grid, origin, { kind: 'shore', outline: pond })!;
		expect(astar).not.toBeNull();
		const solve = solveTerrain(grid, origin)!;
		const dijkstra = solve.routeTo({ kind: 'shore', outline: pond })!;
		const goals = shoreGoalCells(grid, pond, escapeZone(grid, [origin]));
		expect(goals.has(astar.cell)).toBe(true);
		const goalCost = (cell: number) =>
			solve.distanceTo(centreOf(grid, cell % grid.cols, Math.floor(cell / grid.cols)))!.cost;
		const best = Math.min(...[...goals].map(goalCost));
		expect(goalCost(astar.cell)).toBeCloseTo(best, 9);
		expect(goalCost(dijkstra.cell)).toBeCloseTo(best, 9);
		expect(astar.cost).toBeCloseTo(dijkstra.cost, 9);
	});

	it('goal cells are passable: the pond itself stays blocked', () => {
		const grid = buildOptimizedGrid(obstacles, BOUNDS)!;
		const goals = shoreGoalCells(grid, pond, escapeZone(grid, [origin]));
		expect(goals.size).toBeGreaterThan(20);
		for (const cell of goals) expect(grid.cells[cell]).not.toBe(12);
	});

	it('the endpoint equals nearestPointOnOutline of the goal cell', () => {
		const grid = buildOptimizedGrid(obstacles, BOUNDS)!;
		const route = astarRoute(grid, origin, { kind: 'shore', outline: pond })!;
		const cellCentre = centreOf(grid, route.cell % grid.cols, Math.floor(route.cell / grid.cols));
		expect(route.endpoint).toEqual(nearestPointOnOutline(pond, cellCentre));
		expect(route.points.at(-1)).toEqual(route.endpoint);
		expect(distanceToOutline(pond, route.endpoint)).toBeLessThan(0.01);
	});

	it('a suction point within 30 m overrides the goal set', () => {
		const element = {
			type: 'way',
			id: 1,
			center: { lat: at(100, 140).lat, lon: at(100, 140).lng },
			tags: { emergency: 'fire_water_pond' },
			outline: pond
		} as unknown as OverPassElement;
		const suction = at(140, 140);
		const suctionNode = {
			type: 'node',
			id: 2,
			lat: suction.lat,
			lon: suction.lng,
			tags: { emergency: 'suction_point' }
		} as unknown as OverPassElement;
		const target = accessTargetFor(element, origin, pond, [suctionNode]);
		expect(target).toEqual({ kind: 'point', point: suction });
		const grid = buildOptimizedGrid(obstacles, BOUNDS)!;
		const route = gridRouteSingle(grid, origin, { kind: 'point', point: suction })!;
		expect(route.points.at(-1)).toEqual(suction);
		// The shore goal would have ended on the pond's south side instead.
		const shore = gridRouteSingle(grid, origin, { kind: 'shore', outline: pond })!;
		expect(distanceTo(shore.endpoint, suction)).toBeGreaterThan(10);
	});
});

describe('optimized: cost-aware smoothing (plan section 6.6)', () => {
	it('200 seeded scenes: no segment touches a building edge or a blocked cell; cost within bounds', () => {
		const next = rng(4242);
		let routes = 0;
		for (let n = 0; n < 200; n++) {
			const scene = randomScene(next);
			const grid = buildOptimizedGrid({ ...emptyObstacleData(), ...scene }, BOUNDS)!;
			const a = randomPoint(next);
			const b = randomPoint(next);
			// Endpoints clear of the escape zone (12 m) by a cell: a building near an
			// endpoint may be passed on purpose (courtyard hydrants).
			const nearBuilding = (p: { lng: number; lat: number }) =>
				(scene.buildings ?? []).some((bd) => {
					const [w, so, e, n] = bd.bbox;
					const dx = Math.max(w - p.lng, 0, p.lng - e) * mPerDegLng;
					const dy = Math.max(so - p.lat, 0, p.lat - n) * M_PER_DEG_LAT;
					return Math.hypot(dx, dy) < 18;
				});
			if (nearBuilding(a) || nearBuilding(b)) continue;
			const route = gridRouteSingle(grid, a, { kind: 'point', point: b });
			if (!route) continue;
			routes++;
			const zone = escapeZone(grid, [a, b]);
			let smoothedCost = 0;
			for (let i = 0; i + 1 < route.points.length; i++) {
				const p = route.points[i];
				const q = route.points[i + 1];
				for (const building of scene.buildings ?? []) {
					expect(
						segmentIntersectsPolygon([p.lng, p.lat], [q.lng, q.lat], building),
						`scene ${n}, segment ${i}`
					).toBe(false);
				}
				const cost = lineCost(grid, p, q, zone);
				expect(Number.isFinite(cost), `scene ${n}, segment ${i} crosses a blocked cell`).toBe(true);
				smoothedCost += cost;
			}
			const segments = route.points.length - 1;
			expect(smoothedCost, `scene ${n}`).toBeLessThanOrEqual(
				route.cost * SMOOTH_COST_TOLERANCE + SMOOTH_SLACK_M * segments + 1e-6
			);
			expect(Math.abs(route.meters - polylineLength(route.points))).toBeLessThan(0.01);
		}
		expect(routes).toBeGreaterThan(120);
	});

	it('takes a straight shortcut on uniform ground, keeps to the road when the field is dearer', () => {
		const open = buildOptimizedGrid(emptyObstacleData(), BOUNDS)!;
		expect(
			gridRouteSingle(open, at(20, 20), { kind: 'point', point: at(180, 150) })!.points
		).toHaveLength(2);
		// An L-shaped road vs a diagonal across forest (1.6): the road (1.0) wins.
		const forest = buildOptimizedGrid(
			{
				...emptyObstacleData(),
				landuse: [areaRect('forest', 0, 0, 200, 200)],
				roads: [roadLine([20, 20], [180, 20], [180, 180])]
			},
			BOUNDS
		)!;
		const route = gridRouteSingle(forest, at(20, 20), { kind: 'point', point: at(180, 180) })!;
		expect(route.points.length).toBeGreaterThanOrEqual(3);
		expect(route.meters).toBeGreaterThan(300);
	});
});

describe('simplifyGated (Douglas-Peucker with the smoothing tests)', () => {
	const pts = [at(0, 0), at(50, 1), at(100, 0), at(150, 1), at(200, 0)];
	const all = [0, 1, 2, 3, 4];

	it('drops vertices within the tolerance when the chord passes the tests', () => {
		expect(simplifyGated(pts, all, 1.5, () => true)).toEqual([0, 4]);
	});

	it('never removes a vertex whose removal would break the tests', () => {
		// The chord 0 -> 4 and 0 -> 2 are rejected (say, they cross a wall).
		const valid = (i: number, j: number) => !(i === 0 && j >= 2);
		const kept = simplifyGated(pts, all, 1.5, valid);
		expect(kept).toContain(1);
		for (let k = 0; k + 1 < kept.length; k++) expect(valid(kept[k], kept[k + 1])).toBe(true);
	});

	it('keeps vertices beyond the tolerance', () => {
		const zig = [at(0, 0), at(50, 10), at(100, 0)];
		expect(simplifyGated(zig, [0, 1, 2], 1.5, () => true)).toEqual([0, 1, 2]);
	});
});

// ---------------------------------------------------------------------------
// optimized: slope in the step cost (plan section 6.4, phase 4)
// ---------------------------------------------------------------------------

/** A height raster for `grid` from a function of the local metre frame (halo included). */
function heightsFor(
	grid: TerrainGrid,
	height: (xM: number, yM: number) => number,
	zoom = 14
): HeightRaster {
	const { cols, rows, cellM } = gridFrameOf(grid);
	const heights = new Float32Array((cols + 2) * (rows + 2));
	for (let r = -1; r <= rows; r++) {
		for (let c = -1; c <= cols; c++) {
			heights[(r + 1) * (cols + 2) + (c + 1)] = height((c + 0.5) * cellM, (r + 0.5) * cellM);
		}
	}
	return { cols, rows, cellM, zoom, heights };
}

/** Rolling random terrain (hills of 20-60 m wavelength, grades up to ~150 %). */
function randomTerrain(next: () => number): (x: number, y: number) => number {
	const waves = Array.from({ length: 4 }, () => ({
		ax: next() * 2 * Math.PI * (1 / 20 + next() / 40),
		ay: next() * 2 * Math.PI * (1 / 20 + next() / 40),
		amp: 2 + next() * 12,
		phase: next() * 2 * Math.PI
	}));
	return (x, y) => waves.reduce((h, w) => h + w.amp * Math.sin(w.ax * x + w.ay * y + w.phase), 100);
}

function bridgeLine(...points: [number, number][]): RoadLine {
	return { ...roadLine(...points), isBridge: true };
}

/** {@link randomScene} plus heights (z14 or z12) and, sometimes, a bridge. */
function randomSlopeGrid(next: () => number, n: number): TerrainGrid {
	const scene = randomScene(next);
	if (next() < 0.5) {
		const x = 20 + next() * 160;
		scene.roads = [
			...(scene.roads ?? []),
			bridgeLine([x, 40 + next() * 40], [x, 120 + next() * 40])
		];
	}
	const grid = buildOptimizedGrid({ ...emptyObstacleData(), ...scene }, BOUNDS)!;
	setGridHeights(grid, heightsFor(grid, randomTerrain(next), n % 2 === 0 ? 14 : 12));
	return grid;
}

describe('optimized: slope (plan section 6.4)', () => {
	it('100 seeded grids with terrain: the step cost with slope is symmetric (A to B = B to A)', () => {
		const next = rng(4242);
		let compared = 0;
		for (let n = 0; n < 100; n++) {
			const grid = randomSlopeGrid(next, n);
			const a = randomPoint(next);
			const b = randomPoint(next);
			const ab = dijkstraCost(grid, a, b);
			const ba = dijkstraCost(grid, b, a);
			if (ab === null || ba === null) {
				expect(ab, `grid ${n}`).toBe(ba);
				continue;
			}
			expect(Math.abs(ab - ba), `grid ${n}`).toBeLessThan(1e-9 * Math.max(1, ab));
			compared++;
		}
		expect(compared).toBeGreaterThan(70);
	});

	it('A* cost equals Dijkstra cost with slope on the same 100 grids (admissible)', () => {
		const next = rng(4242);
		let compared = 0;
		for (let n = 0; n < 100; n++) {
			const grid = randomSlopeGrid(next, n);
			const a = randomPoint(next);
			const b = randomPoint(next);
			const dijkstra = dijkstraCost(grid, a, b);
			const astar = astarRoute(grid, a, { kind: 'point', point: b });
			if (dijkstra === null) {
				expect(astar, `grid ${n}`).toBeNull();
				continue;
			}
			expect(Math.abs(astar!.cost - dijkstra), `grid ${n}`).toBeLessThan(
				1e-9 * Math.max(1, dijkstra)
			);
			compared++;
		}
		expect(compared).toBeGreaterThan(70);
	});

	it('slope never makes a step cheaper: cost with terrain >= cost on flat ground', () => {
		const next = rng(99);
		for (let n = 0; n < 30; n++) {
			const grid = randomSlopeGrid(next, n);
			const a = randomPoint(next);
			const b = randomPoint(next);
			const sloped = dijkstraCost(grid, a, b);
			const heights = grid.heights!;
			setGridHeights(
				grid,
				heightsFor(grid, () => 50)
			);
			const flat = dijkstraCost(grid, a, b);
			setGridHeights(grid, heights);
			if (sloped === null || flat === null) continue;
			expect(sloped).toBeGreaterThanOrEqual(flat - 1e-9);
		}
	});

	// Straight east-west road on a 40 % slope across it (grade along the road 0 %) vs a
	// road climbing a 40 % ramp: on road cells the factor is capped at x1.3.
	it('caps the factor at x1.3 on roads; a step on open ground pays the full curve', () => {
		const ramp = (_x: number, y: number) => 0.4 * y;
		const road = buildOptimizedGrid(
			{ ...emptyObstacleData(), roads: [roadLine([100, 10], [100, 190])] },
			BOUNDS
		)!;
		setGridHeights(road, heightsFor(road, ramp));
		const onRoad = astarRoute(road, at(100, 40), { kind: 'point', point: at(100, 160) })!;
		// 120 m at factor 1.0 x 1.3; the endpoint offsets add at most a few metres.
		expect(onRoad.cost).toBeGreaterThan(120 * 1.3 - 1);
		expect(onRoad.cost).toBeLessThan(120 * 1.3 + 12);
		const open = buildOptimizedGrid(emptyObstacleData(), BOUNDS)!;
		setGridHeights(open, heightsFor(open, ramp));
		const across = dijkstraCost(open, at(100, 40), at(100, 160))!;
		// UNKNOWN_OPEN 1.3 x slopeFactor(0.4) = 1.3 x 3.08 straight up; diagonal steps
		// (grade 0.28, factor 1.98, x1.41 length) are a little cheaper: 1.3 x 2.8.
		expect(across).toBeGreaterThan(120 * 1.3 * 2.7);
	});

	it('a BRIDGE ignores slope (factor 1.0 along it)', () => {
		const ramp = (_x: number, y: number) => 0.8 * y;
		const grid = buildOptimizedGrid(
			{ ...emptyObstacleData(), roads: [bridgeLine([100, 10], [100, 190])] },
			BOUNDS
		)!;
		setGridHeights(grid, heightsFor(grid, ramp));
		const route = astarRoute(grid, at(100, 40), { kind: 'point', point: at(100, 160) })!;
		expect(route.cost).toBeGreaterThan(120 - 1);
		expect(route.cost).toBeLessThan(120 + 12);
	});

	it('rejects a step from a BRIDGE to OPEN ground (and back), in the grid and in smoothing', () => {
		// A bridge over meadow with no road at its ends: it cannot be entered or left.
		const meadow = areaRect('meadow', 0, 0, 200, 200);
		const isolated = buildOptimizedGrid(
			{ ...emptyObstacleData(), landuse: [meadow], roads: [bridgeLine([100, 60], [100, 140])] },
			BOUNDS
		)!;
		const along = (grid: TerrainGrid) =>
			astarRoute(grid, at(100, 70), { kind: 'point', point: at(100, 130) });
		// From a bridge cell to a bridge cell: the endpoint cells may step off, so use a
		// target off the bridge instead.
		expect(
			astarRoute(isolated, at(60, 100), { kind: 'point', point: at(100, 100) })
		).not.toBeNull();
		const zone = escapeZone(isolated, [at(60, 100), at(140, 100)]);
		// Straight across the bridge, ground to ground: never cheaper by riding the deck.
		expect(lineCost(isolated, at(60, 100), at(140, 100), zone)).toBe(Infinity);
		// The bridge alone, reached only through its endpoint cells.
		expect(along(isolated)).not.toBeNull();
		// The same deck as a plain road is crossed at ground level.
		const plain = buildOptimizedGrid(
			{ ...emptyObstacleData(), landuse: [meadow], roads: [roadLine([100, 60], [100, 140])] },
			BOUNDS
		)!;
		expect(lineCost(plain, at(60, 100), at(140, 100), zone)).toBeLessThan(Infinity);
		// A route from one side of the deck to the other must go round its ends.
		const round = astarRoute(isolated, at(80, 100), { kind: 'point', point: at(120, 100) })!;
		expect(round.meters).toBeGreaterThan(2 * 40);
		const plainRoute = astarRoute(plain, at(80, 100), { kind: 'point', point: at(120, 100) })!;
		expect(plainRoute.meters).toBeLessThan(41);
	});

	it('a bridge joined to roads at both ends carries the route over a river', () => {
		const river: WaterPolygon = { ...areaRect('water', 0, 90, 200, 110), tile: '15/0/0' };
		const grid = buildOptimizedGrid(
			{
				...emptyObstacleData(),
				waterAreas: [river],
				roads: [
					roadLine([100, 20], [100, 80]),
					bridgeLine([100, 80], [100, 120]),
					roadLine([100, 120], [100, 180])
				]
			},
			BOUNDS
		)!;
		const route = astarRoute(grid, at(100, 30), { kind: 'point', point: at(100, 170) });
		expect(route).not.toBeNull();
		expect(Math.abs(route!.meters - 140)).toBeLessThan(2);
	});

	// A 30 m band of 70 % slope (21 m) between flat ground. A path climbs it in two legs
	// at ~15 % (1.7x the straight line in all); straight up costs 1.3 x 6.7 per metre on
	// the band. Smoothing may round the hairpin (a few metres across the band are cheaper
	// than 30 m of path), but no stretch of the line goes up the fall line. With a gentle
	// 20 % band the detour is not worth it.
	it('takes a 15 % switchback instead of a 70 % direct line when the detour is under 2x', () => {
		const band = (grade: number) => (_x: number, y: number) =>
			grade * Math.min(Math.max(y - 80, 0), 30);
		const zig = {
			...roadLine([100, 20], [100, 80], [168, 95], [100, 110], [100, 170]),
			kind: 'path',
			kindDetail: 'footway'
		};
		const grid = buildOptimizedGrid({ ...emptyObstacleData(), roads: [zig] }, BOUNDS)!;
		const from = at(100, 25);
		const to = at(100, 165);
		setGridHeights(grid, heightsFor(grid, band(0.7)));
		const steep = astarRoute(grid, from, { kind: 'point', point: to })!;
		expect(steep.meters).toBeGreaterThan(1.15 * 140);
		expect(steep.meters).toBeLessThan(2 * 140);
		expect(steep.cost).toBeLessThan(lineCost(grid, from, to));
		// No piece of the chosen line climbs faster than ~30 % (the path, not the fall line).
		const frame = { ...grid, cellM: GRID_CELL_M };
		const h = (p: { lng: number; lat: number }) =>
			heightAtGrid(grid.heights!, gridX(frame, p.lng), gridY(frame, p.lat));
		for (let i = 0; i + 1 < steep.points.length; i++) {
			const a = steep.points[i];
			const b = steep.points[i + 1];
			expect(Math.abs(h(b) - h(a)) / distanceTo(a, b)).toBeLessThan(0.3);
		}
		setGridHeights(grid, heightsFor(grid, band(0.2)));
		const gentle = astarRoute(grid, from, { kind: 'point', point: to })!;
		expect(gentle.meters).toBeLessThan(145);
	});
});
