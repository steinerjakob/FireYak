import { GeoBounds, GeoPoint } from '@/types/geo';
import { fetchTileCacheFirst } from '@/offline/offlineProtocol';
import { PROTOMAPS_MAX_ZOOM, lngLatToTile, tileToBounds, tilesForBounds } from '@/offline/tileMath';
import { pointInPolygon } from '@/helper/polygonGeometry';
import {
	decodeObstacleTile,
	emptyTileObstacles,
	mergeTileObstacles,
	type TileObstacles
} from '@/mapHandler/obstacleDecode';
import type { FeatureBBox, ObstacleResult, WaterPolygon } from '@/types/obstacles';

/**
 * Fetches the Protomaps basemap vector tiles (z15) that back hose routing and
 * decodes them into obstacles (`obstacleDecode.ts` holds the pure decoder).
 * Tiles come from the same cache-first `offline://` pipeline the map renders
 * from. An offline gap yields no obstacles for that tile and is reported in the
 * coverage, so callers can say the map data was incomplete.
 */

/**
 * Upper bound on tiles decoded per call. The nearby-sources search re-runs on
 * every location update, so this guards against a huge viewport ever kicking off
 * an unbounded fetch/decode storm. A capped call reports `coverage.truncated`.
 */
export const MAX_TILES_PER_CALL = 32;

/** LRU cap for the per-tile decode cache (entries are small `ObstacleData`). */
const TILE_CACHE_LIMIT = 64;

/** Fetches a tile's bytes; `null` = unavailable (offline and uncached). */
export type TileFetcher = (
	source: string,
	z: number,
	x: number,
	y: number,
	signal?: AbortSignal
) => Promise<ArrayBuffer | null>;

/**
 * A decoded tile. `missing` means no bytes were available, which is not the
 * same as a tile that decoded to nothing (open farmland): a missing tile is
 * never cached, so it is fetched again next time (plan §6.9).
 */
export interface DecodedTile {
	status: 'ok' | 'missing';
	data: TileObstacles;
}

/**
 * Per-tile decode cache keyed by `"z/x/y"`. Stores the in-flight Promise (not
 * the resolved value) so concurrent requests for the same tile share one decode.
 * Simple LRU: re-insert on hit, evict oldest on overflow.
 */
const tileCache = new Map<string, Promise<DecodedTile>>();

/** Clears the per-tile decode cache (e.g. after an offline-area deletion). */
export function invalidateObstacleCache(): void {
	tileCache.clear();
}

/**
 * Returns building footprints, road centerlines and water polygons covering
 * `bounds`, decoded from the z15 Protomaps tiles overlapping it, plus the
 * coverage: how many tiles were missing and whether the tile list was capped.
 * Tiles are fetched and decoded in parallel and merged.
 * @param bounds Geographic window to collect obstacles for.
 * @param fetcher Tile source; defaults to the app's cache-first pipeline.
 */
export async function getObstaclesForBounds(
	bounds: GeoBounds,
	fetcher: TileFetcher = fetchTileCacheFirst
): Promise<ObstacleResult> {
	const z = PROTOMAPS_MAX_ZOOM;
	const tiles = [...tilesForBounds(bounds, z, z)];
	const totalTiles = tiles.length;
	const truncated = tiles.length > MAX_TILES_PER_CALL;
	if (truncated) {
		console.warn(
			`getObstaclesForBounds: ${tiles.length} tiles cover bounds; capping at ${MAX_TILES_PER_CALL}`
		);
		tiles.length = MAX_TILES_PER_CALL;
	}

	const results = await Promise.all(tiles.map((t) => getTileObstacles(t.x, t.y, fetcher)));

	const missingTiles = results.filter((result) => result.status === 'missing').length;
	const { data, layers, thinBuildingTiles } = mergeTileObstacles(
		results.map((result) => result.data)
	);
	const decoded = tiles.length - missingTiles;
	const basemap = decoded === 0 ? 'none' : missingTiles > 0 || truncated ? 'partial' : 'full';
	return {
		...data,
		coverage: { basemap, truncated, missingTiles, totalTiles, layers, thinBuildingTiles }
	};
}

/** Cache-aware accessor for a single z15 tile's obstacles (LRU + in-flight dedupe). */
function getTileObstacles(x: number, y: number, fetcher: TileFetcher): Promise<DecodedTile> {
	const key = `${PROTOMAPS_MAX_ZOOM}/${x}/${y}`;
	const hit = tileCache.get(key);
	if (hit) {
		// Mark most-recently-used by re-inserting at the tail.
		tileCache.delete(key);
		tileCache.set(key, hit);
		return hit;
	}

	const pending: Promise<DecodedTile> = decodeTile(x, y, fetcher).then(
		(tile) => {
			// A missing tile must not stay cached as "empty": drop it so the next
			// call fetches it again (e.g. once the network is back).
			if (tile.status === 'missing' && tileCache.get(key) === pending) tileCache.delete(key);
			return tile;
		},
		(err) => {
			// Don't cache a failed decode so a later call can retry the tile.
			if (tileCache.get(key) === pending) tileCache.delete(key);
			throw err;
		}
	);
	tileCache.set(key, pending);
	if (tileCache.size > TILE_CACHE_LIMIT) {
		const oldest = tileCache.keys().next().value;
		if (oldest !== undefined) tileCache.delete(oldest);
	}
	return pending;
}

/** Fetches and decodes a single z15 tile; unavailable tiles come back as `missing`. */
async function decodeTile(x: number, y: number, fetcher: TileFetcher): Promise<DecodedTile> {
	const buffer = await fetcher('protomaps', PROTOMAPS_MAX_ZOOM, x, y);
	if (!buffer || buffer.byteLength === 0) {
		return { status: 'missing', data: emptyTileObstacles() };
	}
	return { status: 'ok', data: decodeObstacleTile(buffer, x, y, PROTOMAPS_MAX_ZOOM) };
}

/**
 * Outline of the Protomaps water polygon that contains `point`, as GeoJSON,
 * or `null` when the point is on dry land or its tile is unavailable. Pieces
 * of the same water body from neighbouring tiles (polygons are clipped per
 * tile, with a small overlap) are merged into one MultiPolygon. This is the
 * second outline source for ponds, after the static extract (plan §6.5).
 */
export async function waterOutlineAt(
	point: GeoPoint,
	fetcher: TileFetcher = fetchTileCacheFirst
): Promise<GeoJSON.Geometry | null> {
	const z = PROTOMAPS_MAX_ZOOM;
	const { x, y } = lngLatToTile(point.lng, point.lat, z);
	const home = await getTileObstacles(x, y, fetcher);
	const containing = home.data.waterAreas.find((w) => pointInPolygon(point.lng, point.lat, w));
	if (!containing) return null;

	const pieces: WaterPolygon[] = [containing];
	const tileBounds = tileToBounds(z, x, y);
	const [west, south, east, north] = containing.bbox;
	const clipped =
		west <= tileBounds.west ||
		east >= tileBounds.east ||
		south <= tileBounds.south ||
		north >= tileBounds.north;
	if (clipped) {
		const around = await getObstaclesForBounds({ west, south, east, north }, fetcher);
		for (const piece of around.waterAreas) {
			if (piece.tile === containing.tile) continue;
			if (!bboxesOverlap(piece.bbox, containing.bbox)) continue;
			// Clipped pieces of one polygon overlap in the tile buffer, so a vertex
			// of one lies inside the other.
			const overlaps =
				piece.rings[0].some(([lng, lat]) => pointInPolygon(lng, lat, containing)) ||
				containing.rings[0].some(([lng, lat]) => pointInPolygon(lng, lat, piece));
			if (overlaps) pieces.push(piece);
		}
	}
	if (pieces.length === 1) return { type: 'Polygon', coordinates: containing.rings };
	return { type: 'MultiPolygon', coordinates: pieces.map((p) => p.rings) };
}

function bboxesOverlap(a: FeatureBBox, b: FeatureBBox): boolean {
	return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
