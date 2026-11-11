import { describe, expect, it } from 'vitest';
import {
	baselineCells,
	buildHeightRaster,
	heightAt,
	pointToTileCoord,
	sampleBlended,
	smooth3x3,
	stepGrade,
	terrariumToElevations,
	tileKey,
	tilesForFrame,
	tilesForSamples,
	type DecodedDemTile,
	type HeightRaster,
	type RasterFrame
} from '@/helper/demRaster';
import type { GeoPoint } from '@/types/geo';

describe('terrariumToElevations', () => {
	it('decodes known RGB triplets', () => {
		const rgba = [128, 0, 0, 255, 0, 0, 0, 255, 130, 15, 128, 255, 128, 100, 64, 255];
		expect([...terrariumToElevations(rgba, 4)]).toEqual([0, -32768, 527.5, 100.25]);
	});
});

describe('sampleBlended across tile edges', () => {
	const Z = 3;
	const SIZE = 8;
	// A plane in global pixel coordinates (pixel centres): bilinear interpolation
	// reproduces it exactly, so any seam shows up as an error.
	const plane = (gx: number, gy: number) => 100 + 0.5 * gx - 0.25 * gy;

	function tile(x: number, y: number): DecodedDemTile {
		const elevations = new Float32Array(SIZE * SIZE);
		for (let py = 0; py < SIZE; py++) {
			for (let px = 0; px < SIZE; px++) {
				elevations[py * SIZE + px] = plane(x * SIZE + px, y * SIZE + py);
			}
		}
		return { size: SIZE, elevations };
	}

	const tiles = new Map<string, DecodedDemTile>();
	for (const [x, y] of [
		[3, 2],
		[4, 2],
		[3, 3],
		[4, 3]
	]) {
		tiles.set(tileKey(x, y), tile(x, y));
	}

	/** Geographic point at global pixel coordinate (gx, gy) (pixel centres at +0.5). */
	function at(gx: number, gy: number): GeoPoint {
		const n = 2 ** Z;
		const tx = (gx + 0.5) / SIZE;
		const ty = (gy + 0.5) / SIZE;
		const lng = (tx / n) * 360 - 180;
		const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
		return { lat, lng };
	}

	it('reproduces the plane at and around the shared corner of four tiles', () => {
		// The corner of the four tiles is at global pixel edge 32/24 → centre coords 31.5/23.5.
		for (const [gx, gy] of [
			[31.5, 23.5],
			[31.2, 23.9],
			[31.9, 23.1],
			[30.25, 25.75],
			[33.6, 22.4],
			[31.5, 20]
		]) {
			const p = at(gx, gy);
			const { tx, ty } = pointToTileCoord(p, Z);
			const exactGx = tx * SIZE - 0.5;
			const exactGy = ty * SIZE - 0.5;
			expect(sampleBlended(tiles, p, Z)).toBeCloseTo(plane(exactGx, exactGy), 4);
		}
	});

	it('lists the neighbour tiles a sample at an edge needs', () => {
		const keys = tilesForSamples([at(31.5, 23.5)], Z, SIZE);
		expect([...keys].sort()).toEqual(['3/2', '3/3', '4/2', '4/3']);
		expect([...tilesForSamples([at(28, 20)], Z, SIZE)]).toEqual(['3/2']);
	});

	it('returns null without the home tile and clamps into it without a neighbour', () => {
		const only = new Map([[tileKey(3, 2), tile(3, 2)]]);
		expect(sampleBlended(only, at(20, 20), Z)).toBeNull();
		// Bilinear at 31.2 reads pixels 31 (home tile) and 32 (missing tile 4/2).
		const edge = sampleBlended(only, at(31.2, 20), Z)!;
		expect(edge).toBeCloseTo(plane(31, 20), 4);
	});
});

describe('buildHeightRaster (plan section 6.4)', () => {
	// z14 tiles of 8 px (≈ 76 m pixels at 48° N), so a 20 m grid spans a tile seam.
	const Z = 14;
	const SIZE = 8;
	const X0 = 8936;
	const Y0 = 5680;
	const GX0 = X0 * SIZE;
	const GY0 = Y0 * SIZE;
	const plane = (gx: number, gy: number) => 200 + 0.5 * (gx - GX0) - 0.25 * (gy - GY0);

	function tileOf(x: number, y: number, size: number, f: (gx: number, gy: number) => number) {
		const elevations = new Float32Array(size * size);
		for (let py = 0; py < size; py++) {
			for (let px = 0; px < size; px++)
				elevations[py * size + px] = f(x * size + px, y * size + py);
		}
		return { size, elevations };
	}

	/** Geographic point at the corner of tiles (x, y) at zoom Z. */
	function corner(x: number, y: number) {
		const n = 2 ** Z;
		return {
			lng: (x / n) * 360 - 180,
			lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
		};
	}

	/** A 20 m frame of 12 x 12 cells centred on the shared corner of four tiles. */
	function frameAtCorner(): RasterFrame {
		const c = corner(X0 + 1, Y0 + 1);
		const cellM = 20;
		const mPerDegLng = Math.cos((c.lat * Math.PI) / 180) * 111_320;
		return {
			west: c.lng - (6 * cellM) / mPerDegLng,
			south: c.lat - (6 * cellM) / 110_540,
			mPerDegLng,
			cols: 12,
			rows: 12,
			cellM
		};
	}

	function fourTiles(f: (gx: number, gy: number) => number) {
		const tiles = new Map<string, DecodedDemTile>();
		for (const [dx, dy] of [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1]
		]) {
			tiles.set(tileKey(X0 + dx, Y0 + dy), tileOf(X0 + dx, Y0 + dy, SIZE, f));
		}
		return tiles;
	}

	it('needs the four tiles round the corner (halo included)', () => {
		expect([...tilesForFrame(frameAtCorner(), Z, SIZE)].sort()).toEqual(
			[tileKey(X0, Y0), tileKey(X0, Y0 + 1), tileKey(X0 + 1, Y0), tileKey(X0 + 1, Y0 + 1)].sort()
		);
	});

	it('a synthetic plane matches the plane at every cell, across tile edges', () => {
		const frame = frameAtCorner();
		const raster = buildHeightRaster(frame, fourTiles(plane), Z);
		expect(raster.heights).toHaveLength((frame.cols + 2) * (frame.rows + 2));
		for (let row = 0; row < frame.rows; row++) {
			for (let col = 0; col < frame.cols; col++) {
				const lng = frame.west + ((col + 0.5) * frame.cellM) / frame.mPerDegLng;
				const lat = frame.south + ((row + 0.5) * frame.cellM) / 110_540;
				const { tx, ty } = pointToTileCoord({ lat, lng }, Z);
				const expected = plane(tx * SIZE - 0.5, ty * SIZE - 0.5);
				expect(Math.abs(heightAt(raster, col, row) - expected)).toBeLessThan(1e-3);
			}
		}
	});

	it('bilinear across a tile seam equals a single-tile reference (any surface)', () => {
		// Random heights: the four z14 tiles of 8 px hold exactly the pixels of one z13 tile
		// of 16 px, so both rasters must agree at every cell and halo cell.
		let seed = 7;
		const noise = new Map<string, number>();
		const f = (gx: number, gy: number) => {
			const key = `${gx}/${gy}`;
			if (!noise.has(key)) {
				seed = (seed * 16807) % 2147483647;
				noise.set(key, 100 + (seed % 1000) / 10);
			}
			return noise.get(key)!;
		};
		const frame = frameAtCorner();
		const split = buildHeightRaster(frame, fourTiles(f), Z);
		const whole = new Map([[tileKey(X0 / 2, Y0 / 2), tileOf(X0 / 2, Y0 / 2, 2 * SIZE, f)]]);
		const reference = buildHeightRaster(frame, whole, Z - 1);
		for (let i = 0; i < split.heights.length; i++) {
			expect(split.heights[i]).toBeCloseTo(reference.heights[i], 4);
		}
	});

	it('3x3 smoothing leaves a plane unchanged and skips unknown cells', () => {
		const w = 7;
		const h = 5;
		const values = new Float32Array(w * h);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = 3 * x - 2 * y + 10;
		const smooth = smooth3x3(values, w, h);
		for (let y = 1; y < h - 1; y++) {
			for (let x = 1; x < w - 1; x++) expect(smooth[y * w + x]).toBeCloseTo(values[y * w + x], 5);
		}
		values[2 * w + 3] = NaN;
		const holed = smooth3x3(values, w, h);
		expect(holed[2 * w + 3]).toBeNaN();
		expect(holed[2 * w + 2]).toBeCloseTo((3 * 2 - 2 * 2 + 10) * 1, 0);
	});

	it('marks cells without a tile as unknown (NaN)', () => {
		const frame = frameAtCorner();
		const tiles = fourTiles(plane);
		tiles.delete(tileKey(X0 + 1, Y0 + 1));
		const raster = buildHeightRaster(frame, tiles, Z);
		// The south-east quarter (tile x0+1, y0+1 lies south-east of the corner) is unknown.
		expect(heightAt(raster, frame.cols - 1, 0)).toBeNaN();
		expect(heightAt(raster, 0, frame.rows - 1)).not.toBeNaN();
	});
});

describe('stepGrade: per step on z14, over the 24 m baseline on z12', () => {
	/** A raster whose height jumps by 10 m between columns 5 and 6. */
	function stepRaster(cellM: number, zoom: number): HeightRaster {
		const cols = 12;
		const rows = 3;
		const heights = new Float32Array((cols + 2) * (rows + 2));
		for (let r = -1; r <= rows; r++) {
			for (let c = -1; c <= cols; c++) heights[(r + 1) * (cols + 2) + (c + 1)] = c >= 6 ? 10 : 0;
		}
		return { cols, rows, cellM, zoom, heights };
	}

	it('the z12 baseline uses ceil(24 / cellM) cells', () => {
		expect(baselineCells(8)).toBe(3);
		expect(baselineCells(6)).toBe(4);
		expect(baselineCells(4)).toBe(6);
		expect(baselineCells(5)).toBe(5);
	});

	it('z14: the jump shows on its own step only', () => {
		const raster = stepRaster(8, 14);
		expect(stepGrade(raster, 5, 1, 1, 0)).toBeCloseTo(10 / 8);
		expect(stepGrade(raster, 4, 1, 1, 0)).toBe(0);
		expect(stepGrade(raster, 6, 1, 1, 0)).toBe(0);
	});

	it('z12, 8 m cells: spread over 3 cells (24 m), on each step whose baseline spans it', () => {
		const raster = stepRaster(8, 12);
		expect(stepGrade(raster, 5, 1, 1, 0)).toBeCloseTo(10 / 24);
		expect(stepGrade(raster, 4, 1, 1, 0)).toBeCloseTo(10 / 24);
		expect(stepGrade(raster, 6, 1, 1, 0)).toBeCloseTo(10 / 24);
		expect(stepGrade(raster, 3, 1, 1, 0)).toBe(0);
		expect(stepGrade(raster, 7, 1, 1, 0)).toBe(0);
		// Symmetric: the reverse step has the same grade.
		expect(stepGrade(raster, 6, 1, -1, 0)).toBeCloseTo(stepGrade(raster, 5, 1, 1, 0));
		expect(stepGrade(raster, 7, 1, -1, 0)).toBeCloseTo(stepGrade(raster, 6, 1, 1, 0));
	});

	it('z12, 6 m cells: a baseline of 4 cells (24 m), symmetric', () => {
		const raster = stepRaster(6, 12);
		expect(stepGrade(raster, 5, 1, 1, 0)).toBeCloseTo(10 / 24);
		for (let x = 2; x < 9; x++) {
			expect(stepGrade(raster, x + 1, 1, -1, 0)).toBeCloseTo(stepGrade(raster, x, 1, 1, 0));
		}
	});

	it('returns NaN where a height is unknown', () => {
		const raster = stepRaster(8, 14);
		raster.heights[(1 + 1) * 14 + (5 + 1)] = NaN;
		expect(stepGrade(raster, 5, 1, 1, 0)).toBeNaN();
	});
});
