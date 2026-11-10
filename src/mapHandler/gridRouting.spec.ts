import { describe, expect, it } from 'vitest';
import { distanceTo } from '@/types/geo';
import type { BuildingPolygon, ObstacleData, RoadLine } from '@/types/obstacles';
import { segmentIntersectsPolygon } from '@/helper/polygonGeometry';
import { distanceToOutline } from '@/helper/areaShore';
import {
	GRID_BUILDING_FACTOR,
	GRID_BUILDING_FRINGE_FACTOR,
	GRID_CELL_M,
	GRID_ROAD_FACTOR,
	buildTerrainGrid,
	gridRouteFromOrigin,
	gridRoutePath,
	solveTerrain,
	terrainSolveStats,
	type TerrainGrid
} from '@/mapHandler/gridRouting';

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
		bbox: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), 0, 0],
		points: pts,
		kind: 'minor_road'
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
	const grid = buildTerrainGrid({ buildings: [], roads: [], ...obstacles }, BOUNDS);
	if (!grid) throw new Error('grid not built');
	return grid;
}

describe('cell classes and costs (today: building 30, fringe 4, road 0.9)', () => {
	it('uses the documented factors', () => {
		expect(GRID_BUILDING_FACTOR).toBe(30);
		expect(GRID_BUILDING_FRINGE_FACTOR).toBe(4);
		expect(GRID_ROAD_FACTOR).toBe(0.9);
	});

	it('classifies a building: core where the centre is inside, fringe where only a corner is', () => {
		const grid = build({
			buildings: [
				polygon([
					[60, 60],
					[100, 60],
					[100, 100],
					[60, 100]
				])
			]
		});
		const cells = [...grid.cells];
		expect(cells.filter((c) => c === 2).length).toBeGreaterThan(10);
		expect(cells.filter((c) => c === 3).length).toBeGreaterThan(0);
	});

	it('prices one step into a building cell at 30x, a fringe cell at 4x, a road cell at 0.9x', () => {
		// Walls 1 m off the cell centres (61/99): a step onto a centre that lies
		// exactly on a wall touches the building and is priced as one (phase 1).
		const grid = build({
			buildings: [
				polygon([
					[61, 61],
					[99, 61],
					[99, 99],
					[61, 99]
				])
			],
			roads: [roadLine([0, 20], [200, 20])]
		});
		const stepInto = (targetClass: number) => {
			for (let row = 1; row < grid.rows; row++) {
				for (let col = 0; col < grid.cols; col++) {
					if (grid.cells[row * grid.cols + col] !== targetClass) continue;
					// Open neighbour to the south (a core cell is ringed by fringe cells now).
					const south = grid.cells[(row - 1) * grid.cols + col];
					if (south !== 0 && !(targetClass === 2 && south === 3)) continue;
					const solve = solveTerrain(grid, centreOf(grid, col, row - 1))!;
					return solve.distanceTo(centreOf(grid, col, row))!;
				}
			}
			throw new Error(`no open cell next to class ${targetClass}`);
		};
		expect(stepInto(2).cost).toBeCloseTo(GRID_CELL_M * 30, 1);
		expect(stepInto(3).cost).toBeCloseTo(GRID_CELL_M * 4, 1);
		expect(stepInto(1).cost).toBeCloseTo(GRID_CELL_M * 0.9, 1);
		// The geometric length is the plain step in every case.
		expect(stepInto(2).meters).toBeCloseTo(GRID_CELL_M, 1);
	});

	it('returns null when the origin lies outside the window', () => {
		const grid = build({});
		expect(solveTerrain(grid, at(-500, -500))).toBeNull();
	});
});

describe('open ground', () => {
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
