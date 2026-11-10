import { describe, expect, it } from 'vitest';
import { emptyObstacleData } from '@/mapHandler/obstacleDecode';
import type {
	AreaPolygon,
	BuildingPolygon,
	LinearFeature,
	ObstacleData,
	RoadLine
} from '@/types/obstacles';
import { pointInPolygon, segmentsIntersect, type LngLat } from '@/helper/polygonGeometry';
import {
	gridFrameFor,
	rasterizeCostClasses,
	routableRoads,
	scanlineFill,
	supercoverLine,
	traverseSegment,
	type GridFrame
} from '@/mapHandler/costGrid';
import {
	GRID_CELL_M,
	buildOptimizedGrid,
	escapeZone,
	optimizedCellFactor
} from '@/mapHandler/gridRouting';
import { CELL_CLASS, ESCAPE_RADIUS_M } from '@/mapHandler/hoseCostModel';
import { distanceTo } from '@/types/geo';

// Local metre frame: a 200 m x 200 m window at (48, 15), 8 m cells (25 x 25).
const LAT = 48;
const LNG = 15;
const M_PER_DEG_LAT = 110_540;
const mPerDegLng = Math.cos(((LAT + 100 / M_PER_DEG_LAT) * Math.PI) / 180) * 111_320;
const at = (xM: number, yM: number): LngLat => [LNG + xM / mPerDegLng, LAT + yM / M_PER_DEG_LAT];
const BOUNDS = {
	south: LAT,
	west: LNG,
	north: LAT + 200 / M_PER_DEG_LAT,
	east: LNG + 200 / mPerDegLng
};
const frame: GridFrame = gridFrameFor(BOUNDS, GRID_CELL_M, 1e6)!;

function ring(corners: [number, number][]): LngLat[] {
	const r = corners.map(([x, y]) => at(x, y));
	r.push(r[0]);
	return r;
}

function bboxOf(rings: LngLat[][]): [number, number, number, number] {
	const all = rings.flat();
	return [
		Math.min(...all.map((p) => p[0])),
		Math.min(...all.map((p) => p[1])),
		Math.max(...all.map((p) => p[0])),
		Math.max(...all.map((p) => p[1]))
	];
}

function building(...rings: [number, number][][]): BuildingPolygon {
	const r = rings.map(ring);
	return { bbox: bboxOf(r), rings: r };
}

function area(kind: string, areaM2: number, ...rings: [number, number][][]): AreaPolygon {
	const r = rings.map(ring);
	return { bbox: bboxOf(r), rings: r, kind, areaM2 };
}

function line(
	kind: string,
	kindDetail: string,
	points: [number, number][],
	flags: Partial<Pick<RoadLine, 'isBridge' | 'isTunnel' | 'access'>> = {}
): RoadLine & LinearFeature {
	const pts = points.map(([x, y]) => at(x, y));
	return {
		bbox: bboxOf([pts]),
		points: pts,
		kind,
		kindDetail,
		isBridge: false,
		isTunnel: false,
		...flags
	};
}

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
	[x0, y0],
	[x1, y0],
	[x1, y1],
	[x0, y1]
];

function raster(obstacles: Partial<ObstacleData>) {
	return rasterizeCostClasses({ ...emptyObstacleData(), ...obstacles }, frame);
}

/** Class of the cell containing the local point (x, y) in metres. */
function classAt(cells: Uint8Array, x: number, y: number): number {
	return cells[Math.floor(y / GRID_CELL_M) * frame.cols + Math.floor(x / GRID_CELL_M)];
}

const centre = (cell: number): LngLat => {
	const c = cell % frame.cols;
	const r = Math.floor(cell / frame.cols);
	return at((c + 0.5) * GRID_CELL_M, (r + 0.5) * GRID_CELL_M);
};

describe('scanline fill equals a centre point-in-polygon test', () => {
	const shapes: [string, [number, number][][]][] = [
		['a square', [rect(30.3, 41.7, 121.9, 133.2)]],
		[
			'a concave polygon',
			[
				[
					[20.5, 20.5],
					[180.2, 30.1],
					[110.7, 90.3],
					[170.4, 170.9],
					[30.6, 150.2],
					[70.1, 95.4]
				]
			]
		],
		['a polygon with a hole', [rect(10.2, 10.6, 190.1, 189.3), rect(60.4, 50.9, 140.3, 150.8)]]
	];

	it.each(shapes)('%s', (_name, rings) => {
		const polygon = building(...rings);
		const filled = new Set<number>();
		scanlineFill(frame, polygon.rings, (cell) => filled.add(cell));
		const expected = new Set<number>();
		for (let cell = 0; cell < frame.cols * frame.rows; cell++) {
			const [lng, lat] = centre(cell);
			if (pointInPolygon(lng, lat, polygon)) expected.add(cell);
		}
		expect(expected.size).toBeGreaterThan(20);
		expect([...filled].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
	});
});

describe('building fringe', () => {
	it('fringe = cells an edge touches, minus the filled cells', () => {
		const house = building([
			[50.3, 60.2],
			[130.6, 70.8],
			[120.1, 140.4],
			[66.6, 120.5]
		]);
		const { cells } = raster({ buildings: [house] });
		const touched = new Set<number>();
		const edges = house.rings[0];
		for (let cell = 0; cell < frame.cols * frame.rows; cell++) {
			const c = cell % frame.cols;
			const r = Math.floor(cell / frame.cols);
			const corners = [
				at(c * GRID_CELL_M, r * GRID_CELL_M),
				at((c + 1) * GRID_CELL_M, r * GRID_CELL_M),
				at((c + 1) * GRID_CELL_M, (r + 1) * GRID_CELL_M),
				at(c * GRID_CELL_M, (r + 1) * GRID_CELL_M)
			];
			for (let i = 0; i + 1 < edges.length; i++) {
				const inside = (p: LngLat) =>
					p[0] > corners[0][0] &&
					p[0] < corners[2][0] &&
					p[1] > corners[0][1] &&
					p[1] < corners[2][1];
				const crossesSide = [0, 1, 2, 3].some((k) =>
					segmentsIntersect(edges[i], edges[i + 1], corners[k], corners[(k + 1) % 4])
				);
				if (crossesSide || inside(edges[i])) touched.add(cell);
			}
		}
		const core = new Set<number>();
		scanlineFill(frame, house.rings, (cell) => core.add(cell));
		const expectedFringe = [...touched].filter((cell) => !core.has(cell)).sort((a, b) => a - b);
		const fringe: number[] = [];
		cells.forEach((cls, cell) => {
			if (cls === CELL_CLASS.BUILDING_FRINGE) fringe.push(cell);
			if (core.has(cell)) expect(cls).toBe(CELL_CLASS.BUILDING_CORE);
		});
		expect(fringe).toEqual(expectedFringe);
	});

	it('a footprint smaller than a cell is a fringe cell', () => {
		const { cells } = raster({ buildings: [building(rect(81, 81, 84, 84))] });
		expect(classAt(cells, 82, 82)).toBe(CELL_CLASS.BUILDING_FRINGE);
	});

	it('a fringe never opens a water cell', () => {
		const { cells } = raster({
			waterAreas: [{ ...area('water', 6400, rect(0, 0, 100, 200)), tile: '15/0/0' }],
			buildings: [building(rect(95, 50, 130, 80))]
		});
		// The house's west wall (x = 95) runs through the water cell 88..96: it stays blocked.
		expect(classAt(cells, 92, 60)).toBe(CELL_CLASS.BLOCKED);
		expect(classAt(cells, 100, 60)).toBe(CELL_CLASS.BUILDING_CORE);
	});
});

describe('rasterisation order (plan section 6.3)', () => {
	it('a nested smaller landuse polygon wins, whatever the input order', () => {
		const park = area('park', 3600, rect(60, 60, 120, 120));
		const residential = area('residential', 40000, rect(0, 0, 200, 200));
		for (const landuse of [
			[park, residential],
			[residential, park]
		]) {
			const { cells } = raster({ landuse });
			expect(classAt(cells, 90, 90)).toBe(CELL_CLASS.OPEN);
			expect(classAt(cells, 20, 20)).toBe(CELL_CLASS.YARD);
		}
	});

	it('defaults to UNKNOWN_OPEN, unknown landuse kinds too', () => {
		const { cells } = raster({ landuse: [area('kindergarten', 1600, rect(0, 0, 40, 40))] });
		expect(classAt(cells, 20, 20)).toBe(CELL_CLASS.UNKNOWN_OPEN);
		expect(classAt(cells, 150, 150)).toBe(CELL_CLASS.UNKNOWN_OPEN);
	});

	it('water polygons block; streams are STREAM, rivers BLOCKED', () => {
		const { cells } = raster({
			waterAreas: [{ ...area('water', 1600, rect(10, 10, 50, 50)), tile: '15/0/0' }],
			waterLines: [
				line('stream', '', [
					[100, 0],
					[100, 200]
				]),
				line('river', '', [
					[180, 0],
					[180, 200]
				])
			]
		});
		expect(classAt(cells, 30, 30)).toBe(CELL_CLASS.BLOCKED);
		expect(classAt(cells, 100, 120)).toBe(CELL_CLASS.STREAM);
		expect(classAt(cells, 180, 120)).toBe(CELL_CLASS.BLOCKED);
	});

	it('a road drawn over surface heavy rail leaves the crossing cell passable', () => {
		const rail = line('rail', 'rail', [
			[0, 100],
			[200, 100]
		]);
		const road = line('minor_road', 'residential', [
			[100, 0],
			[100, 200]
		]);
		const { cells } = raster({ rails: [rail], roads: [road] });
		expect(classAt(cells, 100, 100)).toBe(CELL_CLASS.ROAD);
		expect(classAt(cells, 40, 100)).toBe(CELL_CLASS.BLOCKED);
	});

	it('roads overwrite buildings (passages), bridges overwrite roads', () => {
		const { cells } = raster({
			buildings: [building(rect(60, 60, 140, 140))],
			roads: [
				line('minor_road', 'residential', [
					[0, 100],
					[200, 100]
				]),
				line(
					'minor_road',
					'residential',
					[
						[100, 0],
						[100, 200]
					],
					{ isBridge: true }
				)
			]
		});
		expect(classAt(cells, 70, 100)).toBe(CELL_CLASS.ROAD);
		expect(classAt(cells, 100, 100)).toBe(CELL_CLASS.BRIDGE);
		expect(classAt(cells, 80, 80)).toBe(CELL_CLASS.BUILDING_CORE);
	});

	it('bridged or tunnelled rail, tram and subway are not drawn', () => {
		const { cells } = raster({
			rails: [
				line(
					'rail',
					'rail',
					[
						[0, 20],
						[200, 20]
					],
					{ isBridge: true }
				),
				line(
					'rail',
					'rail',
					[
						[0, 60],
						[200, 60]
					],
					{ isTunnel: true }
				),
				line('rail', 'tram', [
					[0, 100],
					[200, 100]
				]),
				line('rail', 'subway', [
					[0, 140],
					[200, 140]
				]),
				line('rail', 'light_rail', [
					[0, 180],
					[200, 180]
				])
			]
		});
		for (const y of [20, 60, 100, 140]) expect(classAt(cells, 50, y)).toBe(CELL_CLASS.UNKNOWN_OPEN);
		expect(classAt(cells, 50, 180)).toBe(CELL_CLASS.BLOCKED);
	});

	it('a surface motorway blocks; a bridged or tunnelled one is not drawn', () => {
		const { cells } = raster({
			roads: [
				line('highway', 'motorway', [
					[0, 44],
					[200, 44]
				]),
				line(
					'highway',
					'motorway',
					[
						[0, 100],
						[200, 100]
					],
					{ isBridge: true }
				),
				line(
					'highway',
					'motorway',
					[
						[0, 164],
						[200, 164]
					],
					{ isTunnel: true }
				)
			]
		});
		expect(classAt(cells, 50, 44)).toBe(CELL_CLASS.BLOCKED);
		expect(classAt(cells, 50, 100)).toBe(CELL_CLASS.UNKNOWN_OPEN);
		expect(classAt(cells, 50, 164)).toBe(CELL_CLASS.UNKNOWN_OPEN);
	});

	it('cliffs and military ground block; military-access and excluded ways are not drawn', () => {
		const roads = [
			line(
				'minor_road',
				'service',
				[
					[0, 150],
					[200, 150]
				],
				{ access: 'military' }
			),
			line('path', 'corridor', [
				[0, 170],
				[200, 170]
			]),
			line(
				'path',
				'footway',
				[
					[0, 190],
					[200, 190]
				],
				{ isTunnel: true }
			),
			line('ferry', '', [
				[0, 130],
				[200, 130]
			])
		];
		expect(routableRoads(roads)).toEqual([]);
		const { cells } = raster({
			landuse: [area('military', 4000, rect(0, 0, 100, 40))],
			cliffs: [
				line('cliff', '', [
					[0, 84],
					[200, 84]
				])
			],
			roads
		});
		expect(classAt(cells, 50, 20)).toBe(CELL_CLASS.BLOCKED);
		expect(classAt(cells, 50, 84)).toBe(CELL_CLASS.BLOCKED);
		for (const y of [130, 150, 170, 190])
			expect(classAt(cells, 50, y)).toBe(CELL_CLASS.UNKNOWN_OPEN);
	});

	it('paths, steps and tracks get their classes', () => {
		const { cells } = raster({
			roads: [
				line('path', 'footway', [
					[0, 20],
					[200, 20]
				]),
				line('path', 'steps', [
					[0, 60],
					[200, 60]
				]),
				line('minor_road', 'track', [
					[0, 100],
					[200, 100]
				])
			]
		});
		expect(classAt(cells, 50, 20)).toBe(CELL_CLASS.PATH);
		expect(classAt(cells, 50, 60)).toBe(CELL_CLASS.STEPS);
		expect(classAt(cells, 50, 100)).toBe(CELL_CLASS.PATH);
	});
});

describe('supercover lines', () => {
	it('a line exactly through cell corners touches both side cells', () => {
		const cells: number[] = [];
		traverseSegment(frame, 0, 0, 9, 9, (cell) => {
			cells.push(cell);
		});
		const set = new Set(cells);
		// The last corner is the segment's own end point.
		for (let k = 0; k < 8; k++) {
			const diagonal = k * frame.cols + k;
			expect(set.has(diagonal)).toBe(true);
			expect(set.has(diagonal + 1)).toBe(true);
			expect(set.has(diagonal + frame.cols)).toBe(true);
		}
	});

	it('any drawn line is 4-connected (no diagonal gap to slip through)', () => {
		const cells: number[] = [];
		supercoverLine(frame, [at(3.3, 7.1), at(187.2, 151.9), at(20.4, 190.6)], (cell) =>
			cells.push(cell)
		);
		for (let i = 1; i < cells.length; i++) {
			const dx = Math.abs((cells[i] % frame.cols) - (cells[i - 1] % frame.cols));
			const dy = Math.abs(
				Math.floor(cells[i] / frame.cols) - Math.floor(cells[i - 1] / frame.cols)
			);
			expect(dx + dy).toBeLessThanOrEqual(1);
		}
	});

	it('reports the parameter interval spent in each cell', () => {
		let total = 0;
		traverseSegment(frame, 0.5, 0.5, 3.5, 1.7, (_cell, t0, t1) => {
			expect(t1).toBeGreaterThanOrEqual(t0);
			total += t1 - t0;
		});
		expect(total).toBeCloseTo(1, 9);
	});
});

describe('escape radius (plan section 6.3)', () => {
	// Cell centres sit at 8k + 4 m. The endpoint is 11 m west of the centre of cell
	// (5, 5); the centre of cell (5, 6) is then sqrt(11^2 + 8^2) = 13.6 m away.
	const endpoint = at(44 - 11, 44);
	const grid = buildOptimizedGrid(
		{ ...emptyObstacleData(), buildings: [building(rect(36, 30, 100, 100))] },
		BOUNDS
	)!;
	const cellNear = 5 * grid.cols + 5;
	const cellFar = 6 * grid.cols + 5;
	const zone = escapeZone(grid, [{ lng: endpoint[0], lat: endpoint[1] }]);

	it('the test cells are building cores at about 11 m and 13.6 m', () => {
		expect(grid.cells[cellNear]).toBe(CELL_CLASS.BUILDING_CORE);
		expect(grid.cells[cellFar]).toBe(CELL_CLASS.BUILDING_CORE);
		const e = { lng: endpoint[0], lat: endpoint[1] };
		const c = (cell: number) => ({ lng: centre(cell)[0], lat: centre(cell)[1] });
		expect(distanceTo(e, c(cellNear))).toBeGreaterThan(10.5);
		expect(distanceTo(e, c(cellNear))).toBeLessThan(ESCAPE_RADIUS_M);
		expect(distanceTo(e, c(cellFar))).toBeGreaterThan(13);
	});

	it('a core cell 11 m from an endpoint is finite (30); at 13 m it is blocked', () => {
		expect(optimizedCellFactor(grid, zone, cellNear)).toBe(30);
		expect(optimizedCellFactor(grid, zone, cellFar)).toBe(Infinity);
	});

	it('the escape zone does not open other blocked cells', () => {
		const wet = buildOptimizedGrid(
			{
				...emptyObstacleData(),
				waterAreas: [{ ...area('water', 4000, rect(36, 0, 200, 200)), tile: '15/0/0' }]
			},
			BOUNDS
		)!;
		const wetZone = escapeZone(wet, [{ lng: endpoint[0], lat: endpoint[1] }]);
		expect(optimizedCellFactor(wet, wetZone, cellNear)).toBe(Infinity);
	});
});
