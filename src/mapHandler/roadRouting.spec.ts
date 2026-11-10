import { describe, expect, it } from 'vitest';
import { distanceTo } from '@/types/geo';
import type { RoadLine } from '@/types/obstacles';
import {
	MAX_SNAP_M,
	POND_SHORE_SNAP_M,
	buildRoadGraph,
	routeFromOrigin,
	routePath
} from '@/mapHandler/roadRouting';

// Synthetic roads in a local metre frame around (48, 15).
const LAT = 48;
const LNG = 15;
const M_PER_DEG_LAT = 110_540;
const mPerDegLng = Math.cos((LAT * Math.PI) / 180) * 111_320;
const at = (xM: number, yM: number) => ({
	lng: LNG + xM / mPerDegLng,
	lat: LAT + yM / M_PER_DEG_LAT
});
const road = (...points: [number, number][]): RoadLine => {
	const pts = points.map(([x, y]) => {
		const p = at(x, y);
		return [p.lng, p.lat] as [number, number];
	});
	const lngs = pts.map((p) => p[0]);
	const lats = pts.map((p) => p[1]);
	return {
		bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
		points: pts,
		kind: 'minor_road'
	};
};
const components = (graph: ReturnType<typeof buildRoadGraph>) => new Set(graph.nodeComponent).size;

describe('buildRoadGraph node merging', () => {
	it('merges vertices within 2 m into one node', () => {
		const graph = buildRoadGraph([road([-100, 0], [0, 0]), road([1.5, 0], [100, 0])]);
		expect(graph.nodes).toHaveLength(3);
		expect(components(graph)).toBe(1);
	});

	it('keeps vertices 3 m apart as separate nodes', () => {
		const graph = buildRoadGraph([road([-100, 0], [0, 0]), road([3, 0], [100, 0])]);
		expect(graph.nodes).toHaveLength(4);
	});
});

describe('buildRoadGraph T-junction repair', () => {
	const through = road([-100, 0], [100, 0]);

	it('joins a side street that ends mid-segment within 6 m', () => {
		const graph = buildRoadGraph([through, road([0, 4], [0, 100])]);
		expect(components(graph)).toBe(1);
	});

	it('leaves a side street that ends 8 m away disconnected', () => {
		const graph = buildRoadGraph([through, road([0, 8], [0, 100])]);
		expect(components(graph)).toBe(2);
	});
});

describe('routing', () => {
	// An L: 200 m east, then 100 m north.
	const graph = buildRoadGraph([road([0, 0], [200, 0]), road([200, 0], [200, 100])]);

	it('finds no route when nothing lies within the snap range', () => {
		const far = at(100, MAX_SNAP_M + 50);
		expect(routeFromOrigin(graph, far, [at(200, 50)])).toEqual([null]);
		expect(routePath(graph, far, at(200, 50))).toBeNull();
		expect(routeFromOrigin(graph, at(0, 0), [far])).toEqual([null]);
	});

	it('routes along the L and reports the geometric length', () => {
		const [result] = routeFromOrigin(graph, at(0, 0), [at(200, 100)]);
		expect(result?.meters).toBeCloseTo(300, 0);
	});

	it('meters equals the length of the routePath polyline, approach legs included', () => {
		const origin = at(-10, 20); // 20 m off the road, 10 m before its start
		const target = at(230, 60); // 30 m off the road
		const [result] = routeFromOrigin(graph, origin, [target]);
		const path = routePath(graph, origin, target);
		expect(result).not.toBeNull();
		expect(path).not.toBeNull();
		let length = 0;
		for (let i = 0; i < path!.length - 1; i++) length += distanceTo(path![i], path![i + 1]);
		expect(length).toBeCloseTo(result!.meters, 0);
		expect(path![0]).toEqual(origin);
		expect(path![path!.length - 1]).toEqual(target);
	});
});

describe('shore targets (plan section 6.5)', () => {
	// One straight road; a pond 240 m north of it, shore sampled every 20 m.
	const graph = buildRoadGraph([road([0, 0], [400, 0])]);
	const shore = [0, 20, 40, 60, 80].map((dx) => at(160 + dx, 240));

	it('uses a final leg of up to 250 m when it is the cheapest arrival', () => {
		expect(POND_SHORE_SNAP_M).toBe(250);
		const origin = at(0, 0);
		// A single point 240 m off the road is out of the normal 100 m snap range.
		expect(routeFromOrigin(graph, origin, [shore[0]])).toEqual([null]);
		const [result] = routeFromOrigin(graph, origin, [
			{ points: shore, maxSnapM: POND_SHORE_SNAP_M }
		]);
		expect(result).not.toBeNull();
		// The cheapest arrival is the sample nearest the origin: 160 m along, 240 m up.
		expect(result!.endpoint).toEqual(shore[0]);
		expect(result!.meters).toBeCloseTo(400, -1);
		const path = routePath(graph, origin, { points: shore, maxSnapM: POND_SHORE_SNAP_M })!;
		expect(path[path.length - 1]).toEqual(shore[0]);
		expect(distanceTo(path[path.length - 2], path[path.length - 1])).toBeGreaterThan(235);
	});

	it('attaches at a farther road when that arrival is cheaper (all roads in range count)', () => {
		// The origin sits on a spur that ends 10 m below the shore's east end.
		const bent = buildRoadGraph([road([0, 0], [300, 0]), road([300, 0], [300, 230])]);
		const [result] = routeFromOrigin(bent, at(300, 200), [
			{ points: shore, maxSnapM: POND_SHORE_SNAP_M }
		]);
		expect(result!.endpoint).toEqual(shore[4]);
		expect(result!.meters).toBeLessThan(100);
		// From the west end of the straight road the west sample wins instead.
		const [west] = routeFromOrigin(bent, at(0, 0), [
			{ points: shore, maxSnapM: POND_SHORE_SNAP_M }
		]);
		expect(west!.endpoint).toEqual(shore[0]);
	});
});
