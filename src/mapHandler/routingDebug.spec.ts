import { describe, expect, it } from 'vitest';
import { emptyObstacleData } from '@/mapHandler/obstacleDecode';
import { classSummary, lineLengthM } from '@/mapHandler/routingDebug';
import type { RoadLine } from '@/types/obstacles';
import { buildOptimizedGrid } from '@/mapHandler/gridRouting';
import { CELL_CLASS } from '@/mapHandler/hoseCostModel';
import {
	OPTIMIZED_CLASS_COLOR,
	costRaster,
	heightRasterImage,
	onRoadShare,
	slopeBucket,
	pathLength,
	ratioTable
} from '@/mapHandler/routingDebug';

const LAT = 48;
const LNG = 15;
const mPerDegLng = Math.cos((LAT * Math.PI) / 180) * 111_320;
const at = (xM: number, yM: number) => ({ lng: LNG + xM / mPerDegLng, lat: LAT + yM / 110_540 });
const road = (...pts: [number, number][]): RoadLine => {
	const points = pts.map(([x, y]) => [at(x, y).lng, at(x, y).lat] as [number, number]);
	return {
		bbox: [
			Math.min(...points.map((p) => p[0])),
			Math.min(...points.map((p) => p[1])),
			Math.max(...points.map((p) => p[0])),
			Math.max(...points.map((p) => p[1]))
		],
		points,
		kind: 'minor_road',
		kindDetail: 'residential',
		isBridge: false,
		isTunnel: false
	};
};

describe('pathLength', () => {
	it('sums the segments', () => {
		expect(pathLength([at(0, 0), at(300, 0), at(300, 400)])).toBeCloseTo(700, -1);
		expect(pathLength([at(0, 0)])).toBe(0);
	});
});

describe('onRoadShare', () => {
	const roads = [road([0, 0], [100, 0])];

	it('is 1 for a route along the road and 0 for one far away', () => {
		expect(onRoadShare([at(0, 2), at(100, 2)], roads)).toBe(1);
		expect(onRoadShare([at(0, 50), at(100, 50)], roads)).toBe(0);
	});

	it('is the covered fraction for a route that leaves the road halfway', () => {
		const share = onRoadShare([at(0, 0), at(100, 0), at(100, 100)], roads);
		expect(share).toBeGreaterThan(0.45);
		expect(share).toBeLessThan(0.55);
	});

	it('is 0 without roads or without a route', () => {
		expect(onRoadShare([at(0, 0), at(10, 0)], [])).toBe(0);
		expect(onRoadShare([], roads)).toBe(0);
	});
});

describe('ratioTable', () => {
	it('gives count, median and worst ratio per radius, ascending', () => {
		const rows = ratioTable([
			{ radius: 300, ratio: 2 },
			{ radius: 150, ratio: 1 },
			{ radius: 150, ratio: 3 },
			{ radius: 150, ratio: 2 },
			{ radius: 150, ratio: null }
		]);
		expect(rows.map((r) => r.radius)).toEqual([150, 300]);
		expect(rows[0]).toEqual({ radius: 150, count: 3, unrouted: 1, median: 2, worst: 3 });
		expect(rows[1].median).toBe(2);
	});

	it('has null statistics when nothing routed', () => {
		expect(ratioTable([{ radius: 150, ratio: null }])[0]).toMatchObject({
			median: null,
			worst: null
		});
	});
});

describe('costRaster', () => {
	it('draws the grid north row first with one colour per cell class', () => {
		const bounds = {
			south: LAT,
			west: LNG,
			north: LAT + 80 / 110_540,
			east: LNG + 80 / mPerDegLng
		};
		const grid = buildOptimizedGrid(
			{ ...emptyObstacleData(), roads: [road([0, 4], [80, 4])] },
			bounds
		)!;
		const raster = costRaster(grid);
		expect(raster.width).toBe(grid.cols);
		expect(raster.height).toBe(grid.rows);
		// The road runs through the southernmost row, i.e. the LAST image row.
		const alphaAt = (imageRow: number, col: number) =>
			raster.data[(imageRow * raster.width + col) * 4 + 3];
		expect(alphaAt(raster.height - 1, 3)).toBeGreaterThan(0);
		expect(alphaAt(0, 3)).toBe(0);
	});
});

describe('costRaster, cost-model classes', () => {
	it('colours the cost-model classes (road blue, blocked dark)', () => {
		const bounds = {
			south: LAT,
			west: LNG,
			north: LAT + 80 / 110_540,
			east: LNG + 80 / mPerDegLng
		};
		const rail: RoadLine = { ...road([0, 76], [80, 76]), kind: 'rail', kindDetail: 'rail' };
		const grid = buildOptimizedGrid(
			{ ...emptyObstacleData(), roads: [road([0, 4], [80, 4])], rails: [rail] },
			bounds
		)!;
		const raster = costRaster(grid);
		const pixel = (imageRow: number, col: number) => [
			...raster.data.slice(
				(imageRow * raster.width + col) * 4,
				(imageRow * raster.width + col) * 4 + 4
			)
		];
		expect(pixel(raster.height - 1, 3)).toEqual(OPTIMIZED_CLASS_COLOR[CELL_CLASS.ROAD]);
		const railRow = raster.height - 1 - Math.floor(76 / 8);
		expect(pixel(railRow, 3)).toEqual(OPTIMIZED_CLASS_COLOR[CELL_CLASS.BLOCKED]);
		expect(pixel(4, 3)[3]).toBe(0);
	});
});

describe('classSummary', () => {
	const ring = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
		[x0, y0]
	];
	const area = (kind: string, areaM2: number) => ({
		bbox: [0, 0, 1, 1] as [number, number, number, number],
		rings: [ring(0, 0, 1, 1)],
		kind,
		areaM2
	});

	it('sums landuse and water by area and linear features by length, and lists unknown landuse', () => {
		const data = {
			...emptyObstacleData(),
			roads: [road([0, 0], [100, 0])],
			landuse: [area('farmland', 1000), area('meadow', 500), area('sand', 300), area('zoo', 50)],
			waterAreas: [{ ...area('water', 200), tile: '15/1/1' }]
		};
		const summary = classSummary(data);
		expect(summary.areaM2).toMatchObject({ OPEN: 1500, UNKNOWN_OPEN: 350, BLOCKED: 200 });
		expect(summary.lengthM.ROAD).toBeGreaterThan(95);
		expect(summary.lengthM.ROAD).toBeLessThan(105);
		expect(summary.unknownLanduse).toEqual([
			{ kind: 'sand', areaM2: 300, listed: true },
			{ kind: 'zoo', areaM2: 50, listed: false }
		]);
	});

	it('measures a polyline in meters', () => {
		expect(lineLengthM([[14, 48]])).toBe(0);
		expect(
			lineLengthM([
				[14, 48],
				[14, 48.001]
			])
		).toBeCloseTo(110.54, 1);
	});
});

describe('heightRasterImage (phase 4: the height and slope raster)', () => {
	// 4 x 3 cells of 8 m, a 30 % ramp to the east (halo included), one unknown cell.
	const cols = 4;
	const rows = 3;
	const heights = new Float32Array((cols + 2) * (rows + 2));
	for (let r = -1; r <= rows; r++) {
		for (let c = -1; c <= cols; c++) heights[(r + 1) * (cols + 2) + (c + 1)] = 100 + 0.3 * 8 * c;
	}
	heights[(2 + 1) * (cols + 2) + (0 + 1)] = NaN; // cell (0, 2): north-west corner
	const raster = { cols, rows, cellM: 8, zoom: 14, heights };

	it('buckets grades at the slope-factor knots', () => {
		expect([0, 0.08, 0.1, 0.25, 0.3, 0.5, 0.6, 0.8, 1.2].map(slopeBucket)).toEqual([
			0, 0, 1, 1, 2, 2, 3, 3, 4
		]);
	});

	it('colours every known cell by its steepest step, north row first', () => {
		const image = heightRasterImage(raster, 'slope');
		expect(image.width).toBe(cols);
		expect(image.height).toBe(rows);
		const pixel = (row: number, col: number) => [
			...image.data.slice((row * cols + col) * 4, (row * cols + col) * 4 + 4)
		];
		// Cell (0, 2) is unknown: image row 0, col 0 stays clear.
		expect(pixel(0, 0)[3]).toBe(0);
		// A 30 % ramp: bucket 2 (25-50 %).
		expect(pixel(2, 2)).toEqual([255, 140, 0, 150]);
	});

	it('shades heights from the lowest (black) to the highest (white) cell', () => {
		const image = heightRasterImage(raster, 'height');
		expect(image.data[(2 * cols + 0) * 4]).toBe(0);
		expect(image.data[(2 * cols + 3) * 4]).toBe(255);
	});
});
