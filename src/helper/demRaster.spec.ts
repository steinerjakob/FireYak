import { describe, expect, it } from 'vitest';
import {
	pointToTileCoord,
	sampleBlended,
	terrariumToElevations,
	tileKey,
	tilesForSamples,
	type DecodedDemTile
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
