import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { Feature, Position } from 'geojson';
import { GeoBounds, GeoPoint } from '@/types/geo';
import { fetchTileCacheFirst } from '@/offline/offlineProtocol';
import { PROTOMAPS_MAX_ZOOM, lngLatToTile, tileToBounds, tilesForBounds } from '@/offline/tileMath';
import { pointInPolygon } from '@/helper/polygonGeometry';
import type {
	BuildingPolygon,
	FeatureBBox,
	ObstacleData,
	ObstacleResult,
	RoadLine,
	WaterPolygon
} from '@/types/obstacles';

/**
 * Decodes building footprints and road centerlines from the Protomaps basemap
 * vector tiles (z15) that back the road-aware distance ranking. Tiles come from
 * the same cache-first `offline://` pipeline the map renders from. An offline
 * gap yields no obstacles for that tile and is reported in the coverage, so
 * callers can say the map data was incomplete.
 */

/** Protomaps source layer holding building footprints. */
const BUILDINGS_LAYER = 'buildings';
/** Protomaps source layer holding road centerlines. */
const ROADS_LAYER = 'roads';
/** Protomaps source layer holding water polygons and lines. */
const WATER_LAYER = 'water';
/** Road `kind`s that are not drivable/walkable barriers and are dropped. */
const EXCLUDED_ROAD_KINDS = new Set(['rail', 'ferry']);

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
	data: Required<ObstacleData>;
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

	const buildings: BuildingPolygon[] = [];
	const roads: RoadLine[] = [];
	const water: WaterPolygon[] = [];
	let missingTiles = 0;
	for (const result of results) {
		if (result.status === 'missing') missingTiles++;
		buildings.push(...result.data.buildings);
		roads.push(...result.data.roads);
		water.push(...result.data.water);
	}
	const decoded = tiles.length - missingTiles;
	const basemap = decoded === 0 ? 'none' : missingTiles > 0 || truncated ? 'partial' : 'full';
	return {
		buildings,
		roads,
		water,
		coverage: { basemap, truncated, missingTiles, totalTiles }
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
	const z = PROTOMAPS_MAX_ZOOM;
	const buildings: BuildingPolygon[] = [];
	const roads: RoadLine[] = [];
	const water: WaterPolygon[] = [];

	const buffer = await fetcher('protomaps', z, x, y);
	if (!buffer || buffer.byteLength === 0) {
		return { status: 'missing', data: { buildings, roads, water } };
	}

	const tile = new VectorTile(new PbfReader(buffer));

	const buildingLayer = tile.layers[BUILDINGS_LAYER];
	if (buildingLayer) {
		for (let i = 0; i < buildingLayer.length; i++) {
			collectBuildings(buildingLayer.feature(i).toGeoJSON(x, y, z), buildings);
		}
	}

	const roadLayer = tile.layers[ROADS_LAYER];
	if (roadLayer) {
		for (let i = 0; i < roadLayer.length; i++) {
			const feature = roadLayer.feature(i);
			const kindRaw = feature.properties.kind;
			const kind = typeof kindRaw === 'string' ? kindRaw : 'unknown';
			if (EXCLUDED_ROAD_KINDS.has(kind)) continue;
			collectRoads(feature.toGeoJSON(x, y, z), kind, roads);
		}
	}

	const waterLayer = tile.layers[WATER_LAYER];
	if (waterLayer) {
		const tileId = `${z}/${x}/${y}`;
		for (let i = 0; i < waterLayer.length; i++) {
			const feature = waterLayer.feature(i);
			// 3 = polygon in the MVT spec; lines (streams) are not outlines.
			if (feature.type !== 3) continue;
			const kindRaw = feature.properties.kind;
			const kind = typeof kindRaw === 'string' ? kindRaw : 'water';
			collectWater(feature.toGeoJSON(x, y, z), kind, tileId, water);
		}
	}

	return { status: 'ok', data: { buildings, roads, water } };
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
	const containing = home.data.water.find((w) => pointInPolygon(point.lng, point.lat, w));
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
		for (const piece of around.water) {
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

/** Appends each polygon of a (Multi)Polygon water feature to `out`. */
function collectWater(feature: Feature, kind: string, tile: string, out: WaterPolygon[]): void {
	const geometry = feature.geometry;
	const push = (coordinates: Position[][]) => {
		const rings = coordinates.map((ring) => ring.map(toLngLat));
		out.push({ bbox: bboxOfRings(rings), rings, kind, tile });
	};
	if (geometry.type === 'Polygon') {
		push(geometry.coordinates);
	} else if (geometry.type === 'MultiPolygon') {
		for (const polygon of geometry.coordinates) push(polygon);
	}
}

/** Appends each polygon of a (Multi)Polygon building feature to `out`. */
function collectBuildings(feature: Feature, out: BuildingPolygon[]): void {
	const geometry = feature.geometry;
	if (geometry.type === 'Polygon') {
		out.push(polygonToBuilding(geometry.coordinates));
	} else if (geometry.type === 'MultiPolygon') {
		for (const polygon of geometry.coordinates) out.push(polygonToBuilding(polygon));
	}
}

/** Appends each linestring of a (Multi)LineString road feature to `out`. */
function collectRoads(feature: Feature, kind: string, out: RoadLine[]): void {
	const geometry = feature.geometry;
	if (geometry.type === 'LineString') {
		out.push(lineToRoad(geometry.coordinates, kind));
	} else if (geometry.type === 'MultiLineString') {
		for (const line of geometry.coordinates) out.push(lineToRoad(line, kind));
	}
}

/** Builds a `BuildingPolygon` (outer ring first) with its computed bbox. */
function polygonToBuilding(coordinates: Position[][]): BuildingPolygon {
	const rings = coordinates.map((ring) => ring.map(toLngLat));
	return { bbox: bboxOfRings(rings), rings };
}

/** Builds a `RoadLine` with its computed bbox. */
function lineToRoad(coordinates: Position[], kind: string): RoadLine {
	const points = coordinates.map(toLngLat);
	return { bbox: bboxOfPoints(points), points, kind };
}

/** Narrows a GeoJSON `Position` to a `[lng, lat]` tuple (drops any elevation). */
function toLngLat(position: Position): [number, number] {
	return [position[0], position[1]];
}

/** [west, south, east, north] bbox spanning every vertex of every ring. */
function bboxOfRings(rings: [number, number][][]): FeatureBBox {
	const bbox: FeatureBBox = [Infinity, Infinity, -Infinity, -Infinity];
	for (const ring of rings) for (const point of ring) extendBBox(bbox, point);
	return bbox;
}

/** [west, south, east, north] bbox spanning every vertex. */
function bboxOfPoints(points: [number, number][]): FeatureBBox {
	const bbox: FeatureBBox = [Infinity, Infinity, -Infinity, -Infinity];
	for (const point of points) extendBBox(bbox, point);
	return bbox;
}

/** Grows `bbox` ([west, south, east, north]) in place to include `[lng, lat]`. */
function extendBBox(bbox: FeatureBBox, [lng, lat]: [number, number]): void {
	if (lng < bbox[0]) bbox[0] = lng;
	if (lat < bbox[1]) bbox[1] = lat;
	if (lng > bbox[2]) bbox[2] = lng;
	if (lat > bbox[3]) bbox[3] = lat;
}
