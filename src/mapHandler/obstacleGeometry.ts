import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { Feature, Position } from 'geojson';
import { GeoBounds } from '@/types/geo';
import { fetchTileCacheFirst } from '@/offline/offlineProtocol';
import { PROTOMAPS_MAX_ZOOM, tilesForBounds } from '@/offline/tileMath';
import type { BuildingPolygon, FeatureBBox, ObstacleData, RoadLine } from '@/types/obstacles';

/**
 * Decodes building footprints and road centerlines from the Protomaps basemap
 * vector tiles (z15) that back the road-aware distance ranking. Tiles come from
 * the same cache-first `offline://` pipeline the map renders from, so an offline
 * gap simply yields no obstacles for that tile (the feature fails open upstream).
 */

/** Protomaps source layer holding building footprints. */
const BUILDINGS_LAYER = 'buildings';
/** Protomaps source layer holding road centerlines. */
const ROADS_LAYER = 'roads';
/** Road `kind`s that are not drivable/walkable barriers and are dropped. */
const EXCLUDED_ROAD_KINDS = new Set(['rail', 'ferry']);

/**
 * Upper bound on tiles decoded per call. The nearby-sources search re-runs on
 * every location update, so this guards against a huge viewport ever kicking off
 * an unbounded fetch/decode storm.
 */
const MAX_TILES_PER_CALL = 32;

/** LRU cap for the per-tile decode cache (entries are small `ObstacleData`). */
const TILE_CACHE_LIMIT = 64;

/**
 * Per-tile decode cache keyed by `"z/x/y"`. Stores the in-flight Promise (not
 * the resolved value) so concurrent requests for the same tile share one decode.
 * Simple LRU: re-insert on hit, evict oldest on overflow.
 */
const tileCache = new Map<string, Promise<ObstacleData>>();

/** Clears the per-tile decode cache (e.g. after an offline-area deletion). */
export function invalidateObstacleCache(): void {
	tileCache.clear();
}

/**
 * Returns building footprints and road centerlines covering `bounds`, decoded
 * from the z15 Protomaps tiles overlapping it. Tiles are fetched and decoded in
 * parallel and merged; missing (offline) tiles are skipped silently.
 * @param bounds Geographic window to collect obstacles for.
 */
export async function getObstaclesForBounds(bounds: GeoBounds): Promise<ObstacleData> {
	const z = PROTOMAPS_MAX_ZOOM;
	const tiles = [...tilesForBounds(bounds, z, z)];
	if (tiles.length > MAX_TILES_PER_CALL) {
		console.warn(
			`getObstaclesForBounds: ${tiles.length} tiles cover bounds; capping at ${MAX_TILES_PER_CALL}`
		);
		tiles.length = MAX_TILES_PER_CALL;
	}

	const results = await Promise.all(tiles.map((t) => getTileObstacles(t.x, t.y)));

	const buildings: BuildingPolygon[] = [];
	const roads: RoadLine[] = [];
	for (const result of results) {
		buildings.push(...result.buildings);
		roads.push(...result.roads);
	}
	return { buildings, roads };
}

/** Cache-aware accessor for a single z15 tile's obstacles (LRU + in-flight dedupe). */
function getTileObstacles(x: number, y: number): Promise<ObstacleData> {
	const key = `${PROTOMAPS_MAX_ZOOM}/${x}/${y}`;
	const hit = tileCache.get(key);
	if (hit) {
		// Mark most-recently-used by re-inserting at the tail.
		tileCache.delete(key);
		tileCache.set(key, hit);
		return hit;
	}

	const pending = decodeTile(x, y).catch((err) => {
		// Don't cache a failed decode so a later call can retry the tile.
		tileCache.delete(key);
		throw err;
	});
	tileCache.set(key, pending);
	if (tileCache.size > TILE_CACHE_LIMIT) {
		const oldest = tileCache.keys().next().value;
		if (oldest !== undefined) tileCache.delete(oldest);
	}
	return pending;
}

/** Fetches and decodes a single z15 tile; empty/offline tiles yield no obstacles. */
async function decodeTile(x: number, y: number): Promise<ObstacleData> {
	const z = PROTOMAPS_MAX_ZOOM;
	const empty: ObstacleData = { buildings: [], roads: [] };

	const buffer = await fetchTileCacheFirst('protomaps', z, x, y);
	if (!buffer || buffer.byteLength === 0) return empty;

	const tile = new VectorTile(new PbfReader(buffer));
	const buildings: BuildingPolygon[] = [];
	const roads: RoadLine[] = [];

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

	return { buildings, roads };
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
