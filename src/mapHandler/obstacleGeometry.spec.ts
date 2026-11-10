import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MAX_TILES_PER_CALL,
	getObstaclesForBounds,
	invalidateObstacleCache,
	waterOutlineAt,
	type TileFetcher
} from '@/mapHandler/obstacleGeometry';
import { tileToBounds } from '@/offline/tileMath';
import { encodeMvt } from '@/testing/mvt';
import { isInsideOutline } from '@/helper/areaShore';

// The default fetcher lives in the MapLibre-backed protocol module; every case
// here injects its own fetcher.
vi.mock('@/offline/offlineProtocol', () => ({ fetchTileCacheFirst: async () => null }));

const Z = 15;
const X = 17772;
const Y = 11372;
const tile = tileToBounds(Z, X, Y);
/** Geographic point at tile coordinate (tx, ty) of tile X/Y (extent 4096). */
const at = (tx: number, ty: number) => ({
	lng: tile.west + ((tile.east - tile.west) * tx) / 4096,
	lat: tile.north - ((tile.north - tile.south) * ty) / 4096
});
const square = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
	[x0, y0],
	[x1, y0],
	[x1, y1],
	[x0, y1],
	[x0, y0]
];

const tileWithBuilding = encodeMvt([
	{
		name: 'buildings',
		features: [
			{ type: 3, geometry: [square(1000, 1000, 1200, 1200)], properties: { kind: 'building' } }
		]
	},
	{
		name: 'water',
		features: [
			{ type: 3, geometry: [square(2000, 2000, 2600, 2400)], properties: { kind: 'water' } }
		]
	}
]);
const emptyTile = encodeMvt([{ name: 'roads', features: [] }]);
/** Bounds well inside tile X/Y. */
const inside = {
	west: at(100, 0).lng,
	east: at(3900, 0).lng,
	north: at(0, 100).lat,
	south: at(0, 3900).lat
};

beforeEach(() => invalidateObstacleCache());

describe('missing vs empty tiles (plan section 6.9)', () => {
	it('a fetcher returning null gives a missing tile that is not cached', async () => {
		const offline: TileFetcher = vi.fn(async () => null);
		const first = await getObstaclesForBounds(inside, offline);
		expect(first.coverage).toMatchObject({
			basemap: 'none',
			truncated: false,
			missingTiles: 1,
			totalTiles: 1
		});
		expect(first.buildings).toHaveLength(0);

		// The network is back: the same tile now decodes instead of staying "empty".
		const online: TileFetcher = vi.fn(async () => tileWithBuilding);
		const second = await getObstaclesForBounds(inside, online);
		expect(online).toHaveBeenCalledTimes(1);
		expect(second.coverage.basemap).toBe('full');
		expect(second.buildings).toHaveLength(1);
		expect(second.waterAreas).toHaveLength(1);
		expect(second.coverage.layers.buildings).toEqual({ tiles: 1, features: 1 });
		expect(second.coverage.layers.water).toEqual({ tiles: 1, features: 1 });
		expect(second.coverage.layers.roads).toEqual({ tiles: 0, features: 0 });
	});

	it('an empty tile that did arrive is cached as empty', async () => {
		await getObstaclesForBounds(inside, async () => emptyTile);
		const offline: TileFetcher = vi.fn(async () => null);
		const again = await getObstaclesForBounds(inside, offline);
		expect(offline).not.toHaveBeenCalled();
		expect(again.coverage.basemap).toBe('full');
	});

	it('some missing tiles give partial coverage', async () => {
		const bounds = { ...inside, east: tileToBounds(Z, X + 1, Y).east - 1e-5 };
		const result = await getObstaclesForBounds(bounds, async (_s, _z, x) =>
			x === X ? emptyTile : null
		);
		expect(result.coverage).toMatchObject({
			basemap: 'partial',
			truncated: false,
			missingTiles: 1,
			totalTiles: 2
		});
	});

	it(`more than ${MAX_TILES_PER_CALL} tiles sets coverage.truncated`, async () => {
		const far = tileToBounds(Z, X + 6, Y + 6);
		const bounds = {
			west: tile.west + 1e-5,
			north: tile.north - 1e-5,
			east: far.east - 1e-5,
			south: far.south + 1e-5
		};
		const fetcher: TileFetcher = vi.fn(async () => emptyTile);
		const result = await getObstaclesForBounds(bounds, fetcher);
		expect(result.coverage.totalTiles).toBe(49);
		expect(result.coverage.truncated).toBe(true);
		expect(result.coverage.basemap).toBe('partial');
		expect(fetcher).toHaveBeenCalledTimes(MAX_TILES_PER_CALL);
	});
});

describe('waterOutlineAt', () => {
	it('returns the water polygon under a point, null on land', async () => {
		const fetcher: TileFetcher = async (_s, _z, x, y) =>
			x === X && y === Y ? tileWithBuilding : emptyTile;
		const outline = await waterOutlineAt(at(2300, 2200), fetcher);
		expect(outline?.type).toBe('Polygon');
		expect(isInsideOutline(outline, at(2300, 2200))).toBe(true);
		expect(await waterOutlineAt(at(500, 500), fetcher)).toBeNull();
	});
});
