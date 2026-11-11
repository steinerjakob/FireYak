import type { GeoBounds, GeoPoint } from '@/types/geo';
import type { ObstacleResult } from '@/types/obstacles';
import { fetchTileCacheFirst } from '@/offline/offlineProtocol';
import {
	getObstaclesForBounds as getObstaclesWith,
	waterOutlineAt as waterOutlineWith,
	type TileFetcher
} from '@/mapHandler/obstacleTiles';

/**
 * Main-thread entry to the decoded z15 basemap obstacles (`obstacleTiles.ts`),
 * fetching through the same cache-first `offline://` pipeline the map renders
 * from. The hose routing worker has its own copy of `obstacleTiles.ts`, fed by
 * the main thread (plan §6.10).
 */

export {
	MAX_TILES_PER_CALL,
	invalidateObstacleCache,
	type DecodedTile,
	type TileFetcher
} from '@/mapHandler/obstacleTiles';

/** {@link getObstaclesWith} over the app's cache-first tile pipeline by default. */
export function getObstaclesForBounds(
	bounds: GeoBounds,
	fetcher: TileFetcher = fetchTileCacheFirst
): Promise<ObstacleResult> {
	return getObstaclesWith(bounds, fetcher);
}

/** {@link waterOutlineWith} over the app's cache-first tile pipeline by default. */
export function waterOutlineAt(
	point: GeoPoint,
	fetcher: TileFetcher = fetchTileCacheFirst
): Promise<GeoJSON.Geometry | null> {
	return waterOutlineWith(point, fetcher);
}
