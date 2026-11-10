import { describe, expect, it } from 'vitest';
import {
	distanceToOutline,
	expandBounds,
	isInsideOutline,
	nearestPointOnOutline,
	outlineBounds,
	sampleShore
} from '@/helper/areaShore';
import { distanceTo } from '@/types/geo';

// A 200 m x 200 m square around (48, 15), built in a local metre frame.
const LAT = 48;
const LNG = 15;
const M_PER_DEG_LAT = 110_540;
const mPerDegLng = Math.cos((LAT * Math.PI) / 180) * 111_320;
const at = (xM: number, yM: number) => ({
	lng: LNG + xM / mPerDegLng,
	lat: LAT + yM / M_PER_DEG_LAT
});
const pos = (xM: number, yM: number): GeoJSON.Position => {
	const p = at(xM, yM);
	return [p.lng, p.lat];
};
const closedRing = (...corners: [number, number][]): GeoJSON.Position[] => {
	const ring = corners.map(([x, y]) => pos(x, y));
	return [...ring, ring[0]];
};

const SQUARE_RING = closedRing([-100, -100], [100, -100], [100, 100], [-100, 100]);
const square: GeoJSON.Polygon = { type: 'Polygon', coordinates: [SQUARE_RING] };
const squareWithIsland: GeoJSON.Polygon = {
	type: 'Polygon',
	coordinates: [SQUARE_RING, closedRing([-20, -20], [20, -20], [20, 20], [-20, 20])]
};

describe('nearestPointOnOutline', () => {
	it('finds the closest point on a square from outside', () => {
		const nearest = nearestPointOnOutline(square, at(150, 30));
		expect(nearest).not.toBeNull();
		expect(distanceTo(nearest!, at(100, 30))).toBeLessThan(0.5);
	});

	it('snaps to a corner when that is closest', () => {
		const nearest = nearestPointOnOutline(square, at(130, 140));
		expect(distanceTo(nearest!, at(100, 100))).toBeLessThan(0.5);
	});

	it('looks at every polygon of a multipolygon', () => {
		const second = closedRing([400, -50], [500, -50], [500, 50], [400, 50]);
		const multi: GeoJSON.MultiPolygon = {
			type: 'MultiPolygon',
			coordinates: [[SQUARE_RING], [second]]
		};
		const nearest = nearestPointOnOutline(multi, at(380, 0));
		expect(distanceTo(nearest!, at(400, 0))).toBeLessThan(0.5);
	});

	it('works on open member lines (a split multipolygon)', () => {
		const lines: GeoJSON.MultiLineString = {
			type: 'MultiLineString',
			coordinates: [
				[pos(0, 0), pos(50, 0)],
				[pos(50, 0), pos(50, 80)]
			]
		};
		const nearest = nearestPointOnOutline(lines, at(70, 40));
		expect(distanceTo(nearest!, at(50, 40))).toBeLessThan(0.5);
	});

	it('returns null for an empty outline', () => {
		expect(nearestPointOnOutline(null, at(0, 0))).toBeNull();
		expect(nearestPointOnOutline({ type: 'Polygon', coordinates: [] }, at(0, 0))).toBeNull();
	});
});

describe('isInsideOutline', () => {
	it('is true inside the square and false outside', () => {
		expect(isInsideOutline(square, at(0, 0))).toBe(true);
		expect(isInsideOutline(square, at(150, 0))).toBe(false);
	});

	it('treats a hole (island) as outside', () => {
		expect(isInsideOutline(squareWithIsland, at(0, 0))).toBe(false);
		expect(isInsideOutline(squareWithIsland, at(60, 0))).toBe(true);
	});

	it('ignores open member lines, which enclose nothing alone', () => {
		const open: GeoJSON.LineString = { type: 'LineString', coordinates: SQUARE_RING.slice(0, -1) };
		expect(isInsideOutline(open, at(0, 0))).toBe(false);
	});
});

describe('distanceToOutline', () => {
	it('is 0 inside the area', () => {
		expect(distanceToOutline(square, at(10, 10))).toBe(0);
	});

	it('is the distance to the shore outside', () => {
		expect(distanceToOutline(square, at(160, 0))).toBeCloseTo(60, 0);
	});

	it('measures to the island shore from the water around it', () => {
		// 40 m east of the island centre is inside the island hole (outside the water).
		expect(distanceToOutline(squareWithIsland, at(0, 0))).toBeCloseTo(20, 0);
	});

	it('is null for an empty outline', () => {
		expect(distanceToOutline(null, at(0, 0))).toBeNull();
	});
});

describe('outlineBounds and expandBounds', () => {
	it('bounds the square and grows by a margin in meters', () => {
		const bounds = outlineBounds(square)!;
		expect(bounds.north - bounds.south).toBeCloseTo(200 / M_PER_DEG_LAT, 6);
		const grown = expandBounds(bounds, 50);
		expect((grown.north - bounds.north) * M_PER_DEG_LAT).toBeCloseTo(50, 3);
		expect((grown.east - bounds.east) * mPerDegLng).toBeCloseTo(50, 1);
	});

	it('is null without vertices', () => {
		expect(outlineBounds(null)).toBeNull();
	});
});

describe('sampleShore', () => {
	/** Largest gap between consecutive samples, including the wrap-around. */
	const maxGap = (points: { lat: number; lng: number }[]) => {
		let max = 0;
		for (let i = 0; i < points.length; i++) {
			max = Math.max(max, distanceTo(points[i], points[(i + 1) % points.length]));
		}
		return max;
	};

	it('spaces samples at most 20 m apart, all on the outline', () => {
		const samples = sampleShore(square, 20);
		expect(samples.length).toBeGreaterThanOrEqual(40);
		expect(maxGap(samples)).toBeLessThanOrEqual(20);
		for (const p of samples) expect(distanceToOutline(square, p)).toBeLessThan(0.01);
	});

	it('a pond under 20 m perimeter still yields at least 3 samples', () => {
		const tiny: GeoJSON.Polygon = {
			type: 'Polygon',
			coordinates: [closedRing([0, 0], [4, 0], [4, 4], [0, 4])]
		};
		expect(sampleShore(tiny, 20).length).toBeGreaterThanOrEqual(3);
	});

	it('samples multipolygon members and open member lines', () => {
		const multi: GeoJSON.MultiPolygon = {
			type: 'MultiPolygon',
			coordinates: [[SQUARE_RING], [closedRing([300, 0], [340, 0], [340, 40], [300, 40])]]
		};
		const samples = sampleShore(multi, 20);
		expect(samples.some((p) => distanceTo(p, at(320, 20)) < 30)).toBe(true);
		expect(samples.some((p) => distanceTo(p, at(0, 0)) < 150)).toBe(true);
		const lines: GeoJSON.MultiLineString = {
			type: 'MultiLineString',
			coordinates: [[pos(0, 0), pos(100, 0)]]
		};
		const lineSamples = sampleShore(lines, 20);
		expect(lineSamples).toHaveLength(6);
		expect(distanceTo(lineSamples[5], at(100, 0))).toBeLessThan(0.01);
	});
});
