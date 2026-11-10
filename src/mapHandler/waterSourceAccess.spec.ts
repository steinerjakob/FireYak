import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverPassElement } from '@/mapHandler/overPassApi';
import {
	accessTargetFor,
	resolveAccessPoint,
	type AccessLookups
} from '@/mapHandler/waterSourceAccess';

// The real lookups read IndexedDB, Overpass and the tile protocol; every case
// injects its own, so only stub the modules out of the import graph.
vi.mock('@/mapHandler/areaOutline', () => ({
	cachedOutline: () => undefined,
	getAreaOutline: async () => null
}));
vi.mock('@/mapHandler/databaseHandler', () => ({ getMapNodesForView: async () => [] }));
vi.mock('@/mapHandler/obstacleGeometry', () => ({ waterOutlineAt: async () => null }));

// Haversine metres per degree, so distances agree with `distanceTo`.
const LAT = 48;
const LNG = 15;
const M_PER_DEG_LAT = (6_371_000 * Math.PI) / 180;
const mPerDegLng = Math.cos((LAT * Math.PI) / 180) * M_PER_DEG_LAT;
const at = (xM: number, yM: number) => ({
	lng: LNG + xM / mPerDegLng,
	lat: LAT + yM / M_PER_DEG_LAT
});
const pos = (xM: number, yM: number): GeoJSON.Position => {
	const p = at(xM, yM);
	return [p.lng, p.lat];
};

/** 100 x 100 m pond centred on (0, 0). */
const extractOutline: GeoJSON.Polygon = {
	type: 'Polygon',
	coordinates: [[pos(-50, -50), pos(50, -50), pos(50, 50), pos(-50, 50), pos(-50, -50)]]
};
/** The Protomaps water polygon: slightly different from the OSM outline. */
const waterPolygon: GeoJSON.Polygon = {
	type: 'Polygon',
	coordinates: [[pos(-48, -48), pos(48, -48), pos(48, 48), pos(-48, 48), pos(-48, -48)]]
};

function pond(withOutline: boolean): OverPassElement {
	return {
		type: 'way',
		id: 42,
		center: { lat: LAT, lon: LNG },
		tags: { emergency: 'fire_water_pond' },
		...(withOutline ? { outline: extractOutline } : {})
	} as unknown as OverPassElement;
}

function suctionPoint(xM: number, yM: number): OverPassElement {
	const p = at(xM, yM);
	return {
		type: 'node',
		id: 7,
		lat: p.lat,
		lon: p.lng,
		tags: { emergency: 'suction_point' }
	} as unknown as OverPassElement;
}

function lookups(overrides: Partial<AccessLookups> = {}): AccessLookups {
	return {
		waterOutlineAt: vi.fn(async () => waterPolygon),
		suctionPointsIn: vi.fn(async () => []),
		fetchOutline: vi.fn(() => new Promise<GeoJSON.Geometry | null>(() => {})),
		...overrides
	};
}

const from = at(0, -300);

afterEach(() => {
	vi.useRealTimers();
});

describe('accessTargetFor: mapped suction points', () => {
	it('a suction point within 30 m of the shore is the only goal', () => {
		const target = accessTargetFor(pond(true), from, extractOutline, [suctionPoint(20, 79.5)]);
		expect(target).toEqual({ kind: 'point', point: at(20, 79.5) });
	});

	it('one 31 m from the shore is not: the whole shore stays the goal', () => {
		const target = accessTargetFor(pond(true), from, extractOutline, [suctionPoint(20, 81)]);
		expect(target?.kind).toBe('shore');
		if (target?.kind !== 'shore') return;
		expect(target.outline).toBe(extractOutline);
		// The fallback is the straight-line nearest shore point.
		expect(target.fallback.lat).toBeCloseTo(at(0, -50).lat, 6);
	});

	it('anything but a pond area routes to its marker position', () => {
		const hydrant = suctionPoint(10, 10);
		expect(accessTargetFor(hydrant, from, extractOutline, [])).toEqual({
			kind: 'point',
			point: at(10, 10)
		});
	});
});

describe('resolveAccessPoint: outline sources and no Overpass wait', () => {
	it('uses the extract outline first, without looking up the water polygon', async () => {
		const io = lookups();
		const target = await resolveAccessPoint(pond(true), from, {}, io);
		expect(target?.kind === 'shore' && target.outline).toBe(extractOutline);
		expect(io.waterOutlineAt).not.toHaveBeenCalled();
		expect(io.fetchOutline).not.toHaveBeenCalled();
	});

	it('then the Protomaps water polygon under the marker', async () => {
		const io = lookups();
		const target = await resolveAccessPoint(pond(false), from, {}, io);
		expect(target?.kind === 'shore' && target.outline).toBe(waterPolygon);
		// Overpass is asked, but only in the background.
		expect(io.fetchOutline).toHaveBeenCalledTimes(1);
	});

	it('then the marker point', async () => {
		const io = lookups({ waterOutlineAt: vi.fn(async () => null) });
		const target = await resolveAccessPoint(pond(false), from, {}, io);
		expect(target).toEqual({ kind: 'point', point: { lat: LAT, lng: LNG } });
	});

	it('resolves at once while Overpass never answers (fake timers)', async () => {
		vi.useFakeTimers();
		const io = lookups({ waterOutlineAt: vi.fn(async () => null) });
		let settled = false;
		const pending = resolveAccessPoint(pond(false), from, {}, io).then((t) => {
			settled = true;
			return t;
		});
		// Flush microtasks only: no timer may be needed to get an answer.
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(settled).toBe(true);
		expect((await pending)?.kind).toBe('point');
	});

	it('reports a late Overpass outline through onOutlineArrived', async () => {
		let answer: (g: GeoJSON.Geometry | null) => void = () => {};
		const io = lookups({
			waterOutlineAt: vi.fn(async () => null),
			fetchOutline: vi.fn(() => new Promise<GeoJSON.Geometry | null>((r) => (answer = r)))
		});
		const arrived = vi.fn();
		const first = await resolveAccessPoint(pond(false), from, { onOutlineArrived: arrived }, io);
		expect(first?.kind).toBe('point');
		answer(extractOutline);
		await vi.waitFor(() => expect(arrived).toHaveBeenCalledTimes(1));
		expect(arrived.mock.calls[0][0].kind).toBe('shore');
	});
});
