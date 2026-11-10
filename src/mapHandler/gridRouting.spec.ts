import { describe, expect, it } from 'vitest';
import { distanceTo } from '@/types/geo';
import type { BuildingPolygon, ObstacleData, RoadLine } from '@/types/obstacles';
import {
	GRID_BUILDING_FACTOR,
	GRID_BUILDING_FRINGE_FACTOR,
	GRID_CELL_M,
	GRID_ROAD_FACTOR,
	buildTerrainGrid,
	gridRoutePath,
	solveTerrain,
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
		const grid = build({
			buildings: [
				polygon([
					[60, 60],
					[100, 60],
					[100, 100],
					[60, 100]
				])
			],
			roads: [roadLine([0, 20], [200, 20])]
		});
		const stepInto = (targetClass: number) => {
			for (let row = 1; row < grid.rows; row++) {
				for (let col = 0; col < grid.cols; col++) {
					if (grid.cells[row * grid.cols + col] !== targetClass) continue;
					if (grid.cells[(row - 1) * grid.cols + col] !== 0) continue; // open neighbour to the south
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

	// KNOWN DEFECT (plan section 3.3 / phase 1): line of sight is checked from cell
	// centres, but the drawn line starts at the true origin, so the first segment
	// can cut through the L's bar. Phase 1 fixes it and turns this into a plain `it`.
	it.fails('keeps the smoothed line out of the building (known defect, phase 1)', () => {
		const grid = build({ buildings: [lShape] });
		const path = gridRoutePath(grid, origin, target)!;
		expect(crossesBuilding(path, lShape)).toBe(false);
	});
});
