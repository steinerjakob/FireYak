import { describe, expect, it } from 'vitest';
import {
	pointInPolygon,
	segmentIntersectsPolygon,
	segmentsIntersect,
	type LngLat,
	type PolygonRings
} from '@/helper/polygonGeometry';

/** Closed square ring from (x0, y0) to (x1, y1). */
function square(x0: number, y0: number, x1: number, y1: number): LngLat[] {
	return [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1],
		[x0, y0]
	];
}

function polygon(...rings: LngLat[][]): PolygonRings {
	const all = rings.flat();
	return {
		bbox: [
			Math.min(...all.map((p) => p[0])),
			Math.min(...all.map((p) => p[1])),
			Math.max(...all.map((p) => p[0])),
			Math.max(...all.map((p) => p[1]))
		],
		rings
	};
}

// A 10 x 10 building with a 4 x 4 courtyard (hole) in the middle.
const building = polygon(square(0, 0, 10, 10), square(3, 3, 7, 7));

describe('segmentsIntersect', () => {
	it('detects a proper crossing and rejects parallel segments', () => {
		expect(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true);
		expect(segmentsIntersect([0, 0], [2, 0], [0, 1], [2, 1])).toBe(false);
	});
});

describe('segmentIntersectsPolygon', () => {
	it('crossing an edge hits', () => {
		expect(segmentIntersectsPolygon([-5, 1], [1, 1], building)).toBe(true);
	});

	it('touching a vertex hits', () => {
		expect(segmentIntersectsPolygon([-5, -5], [0, 0], building)).toBe(true);
		expect(segmentIntersectsPolygon([-2, 2], [2, -2], building)).toBe(true);
	});

	it('running along an edge hits', () => {
		expect(segmentIntersectsPolygon([-5, 0], [15, 0], building)).toBe(true);
		expect(segmentIntersectsPolygon([2, 10], [8, 10], building)).toBe(true);
	});

	it('a segment fully inside the area hits', () => {
		expect(segmentIntersectsPolygon([1, 1], [2, 2], building)).toBe(true);
	});

	it('a segment inside a hole does not hit', () => {
		expect(segmentIntersectsPolygon([4, 4], [6, 6], building)).toBe(false);
		expect(pointInPolygon(5, 5, building)).toBe(false);
		expect(pointInPolygon(1, 1, building)).toBe(true);
	});

	it('a segment leaving the hole through the wall hits', () => {
		expect(segmentIntersectsPolygon([5, 5], [5, 12], building)).toBe(true);
	});

	it('bbox prefilter rejects a far segment without touching the rings', () => {
		const trap: PolygonRings = {
			bbox: [0, 0, 1, 1],
			get rings(): LngLat[][] {
				throw new Error('rings must not be read for a far segment');
			}
		};
		expect(segmentIntersectsPolygon([5, 5], [6, 6], trap)).toBe(false);
	});

	it('a segment passing outside near a corner misses', () => {
		expect(segmentIntersectsPolygon([-1, 9], [1, 11.5], building)).toBe(false);
	});
});
