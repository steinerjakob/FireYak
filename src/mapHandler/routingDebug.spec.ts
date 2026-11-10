import { describe, expect, it } from 'vitest';
import type { RoadLine } from '@/types/obstacles';
import { buildTerrainGrid } from '@/mapHandler/gridRouting';
import { costRaster, onRoadShare, pathLength, ratioTable } from '@/mapHandler/routingDebug';

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
		kind: 'minor_road'
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
		const grid = buildTerrainGrid({ buildings: [], roads: [road([0, 4], [80, 4])] }, bounds)!;
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
