import { VectorTile } from '@mapbox/vector-tile';
import type { VectorTileFeature } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { Feature, Position } from 'geojson';
import { ringsAreaM2 } from '@/helper/polygonGeometry';
import {
	RESIDENTIAL_LANDUSE_KINDS,
	isThinBuildingTile,
	type TileLandStats
} from '@/mapHandler/hoseCostModel';
import type {
	AreaPolygon,
	BasemapCoverage,
	BuildingPolygon,
	FeatureBBox,
	LayerCoverage,
	LinearFeature,
	ObstacleData,
	ObstacleLayer,
	RoadLine,
	WaterPolygon
} from '@/types/obstacles';

/**
 * Pure decoding of Protomaps basemap tiles into routing obstacles (plan §6.2):
 * bytes in, data out. No fetching, no cache, no map or Capacitor imports, so it
 * runs in Node specs and in a worker. `obstacleGeometry.ts` is the thin I/O
 * part on top.
 */

const BUILDINGS_LAYER = 'buildings';
const ROADS_LAYER = 'roads';
const LANDUSE_LAYER = 'landuse';
const WATER_LAYER = 'water';
const EARTH_LAYER = 'earth';

/** MVT geometry types. */
const MVT_LINE = 2;
const MVT_POLYGON = 3;

export const OBSTACLE_LAYERS: readonly ObstacleLayer[] = [
	'buildings',
	'roads',
	'landuse',
	'water',
	'earth'
];

/** A decoded tile: the obstacles plus how many features each source layer held. */
export interface TileObstacles extends ObstacleData {
	/** Raw feature count per source layer; 0 for a layer the tile does not contain. */
	featureCounts: Record<ObstacleLayer, number>;
	/** Residential and building area of the tile (thin-buildings safeguard, plan §6.11). */
	stats: TileLandStats;
}

export function emptyObstacleData(): ObstacleData {
	return {
		buildings: [],
		roads: [],
		rails: [],
		landuse: [],
		waterAreas: [],
		waterLines: [],
		cliffs: []
	};
}

function emptyCounts(): Record<ObstacleLayer, number> {
	return { buildings: 0, roads: 0, landuse: 0, water: 0, earth: 0 };
}

/** An empty tile (no bytes were available or the tile has no layers). */
export function emptyTileObstacles(): TileObstacles {
	return {
		...emptyObstacleData(),
		featureCounts: emptyCounts(),
		stats: { tileM2: 0, residentialM2: 0, buildingM2: 0 }
	};
}

/** Ground area of a Web-Mercator tile in m² (spherical, at its mid latitude). */
export function tileAreaM2(x: number, y: number, z: number): number {
	const n = 2 ** z;
	const latOf = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)));
	const north = latOf(y);
	const south = latOf(y + 1);
	const width = (2 * Math.PI * 6_371_000 * Math.cos((north + south) / 2)) / n;
	const height = 6_371_000 * (north - south);
	return width * height;
}

/**
 * Decodes one z/x/y Protomaps tile.
 *
 * - `roads`: every way except `kind=rail` (goes to `rails`) and `kind=ferry`.
 *   `path/corridor` (indoor passages), tunnelled paths and military access are
 *   kept with their flags for now, so the road graph and the grid are unchanged
 *   in phase 2; `classifyRoad` (`hoseCostModel.ts`) says they are excluded and
 *   phase 3 filters with it.
 * - `landuse`, `water` (polygons and lines), `earth` (cliff lines) as described
 *   in the plan.
 */
export function decodeObstacleTile(
	buffer: ArrayBuffer | Uint8Array,
	x: number,
	y: number,
	z: number
): TileObstacles {
	const out = emptyTileObstacles();
	const tile = new VectorTile(new PbfReader(buffer));
	const tileId = `${z}/${x}/${y}`;

	const buildingLayer = tile.layers[BUILDINGS_LAYER];
	if (buildingLayer) {
		out.featureCounts.buildings = buildingLayer.length;
		for (let i = 0; i < buildingLayer.length; i++) {
			collectBuildings(buildingLayer.feature(i).toGeoJSON(x, y, z), out.buildings);
		}
	}

	const roadLayer = tile.layers[ROADS_LAYER];
	if (roadLayer) {
		out.featureCounts.roads = roadLayer.length;
		for (let i = 0; i < roadLayer.length; i++) {
			const feature = roadLayer.feature(i);
			const kind = stringProp(feature, 'kind', 'unknown');
			const kindDetail = stringProp(feature, 'kind_detail', '');
			const flags = {
				isBridge: feature.properties.is_bridge === true,
				isTunnel: feature.properties.is_tunnel === true
			};
			if (kind === 'ferry') continue;
			if (kind === 'rail') {
				collectLines(
					feature.toGeoJSON(x, y, z),
					(points) => lineFeature(points, kind, kindDetail, flags),
					out.rails
				);
				continue;
			}
			const access = stringProp(feature, 'access', '');
			collectLines(
				feature.toGeoJSON(x, y, z),
				(points) => ({
					...lineFeature(points, kind, kindDetail, flags),
					...(access ? { access } : {})
				}),
				out.roads
			);
		}
	}

	const landuseLayer = tile.layers[LANDUSE_LAYER];
	if (landuseLayer) {
		out.featureCounts.landuse = landuseLayer.length;
		for (let i = 0; i < landuseLayer.length; i++) {
			const feature = landuseLayer.feature(i);
			if (feature.type !== MVT_POLYGON) continue;
			collectPolygons(
				feature.toGeoJSON(x, y, z),
				stringProp(feature, 'kind', 'unknown'),
				out.landuse
			);
		}
	}

	const waterLayer = tile.layers[WATER_LAYER];
	if (waterLayer) {
		out.featureCounts.water = waterLayer.length;
		for (let i = 0; i < waterLayer.length; i++) {
			const feature = waterLayer.feature(i);
			if (feature.type === MVT_POLYGON) {
				const kind = stringProp(feature, 'kind', 'water');
				collectPolygons(feature.toGeoJSON(x, y, z), kind, out.waterAreas, tileId);
			} else if (feature.type === MVT_LINE) {
				const kind = stringProp(feature, 'kind', 'unknown');
				const kindDetail = stringProp(feature, 'kind_detail', '');
				collectLines(
					feature.toGeoJSON(x, y, z),
					(points) => lineFeature(points, kind, kindDetail, NO_FLAGS),
					out.waterLines
				);
			}
		}
	}

	out.stats = {
		tileM2: tileAreaM2(x, y, z),
		residentialM2: out.landuse
			.filter((area) => RESIDENTIAL_LANDUSE_KINDS.has(area.kind))
			.reduce((sum, area) => sum + area.areaM2, 0),
		buildingM2: out.buildings.reduce((sum, building) => sum + ringsAreaM2(building.rings), 0)
	};

	const earthLayer = tile.layers[EARTH_LAYER];
	if (earthLayer) {
		out.featureCounts.earth = earthLayer.length;
		for (let i = 0; i < earthLayer.length; i++) {
			const feature = earthLayer.feature(i);
			if (feature.type !== MVT_LINE || feature.properties.kind !== 'cliff') continue;
			collectLines(
				feature.toGeoJSON(x, y, z),
				(points) => lineFeature(points, 'cliff', stringProp(feature, 'kind_detail', ''), NO_FLAGS),
				out.cliffs
			);
		}
	}

	return out;
}

/** The obstacles of several tiles concatenated, with the per-layer coverage. */
export function mergeTileObstacles(tiles: TileObstacles[]): {
	data: ObstacleData;
	layers: BasemapCoverage['layers'];
	/** Tiles flagged by the thin-buildings safeguard (plan §6.11). */
	thinBuildingTiles: number;
} {
	let thinBuildingTiles = 0;
	const data = emptyObstacleData();
	const layers = Object.fromEntries(
		OBSTACLE_LAYERS.map((layer) => [layer, { tiles: 0, features: 0 } as LayerCoverage])
	) as Record<ObstacleLayer, LayerCoverage>;
	for (const tile of tiles) {
		data.buildings.push(...tile.buildings);
		data.roads.push(...tile.roads);
		data.rails.push(...tile.rails);
		data.landuse.push(...tile.landuse);
		data.waterAreas.push(...tile.waterAreas);
		data.waterLines.push(...tile.waterLines);
		data.cliffs.push(...tile.cliffs);
		for (const layer of OBSTACLE_LAYERS) {
			const count = tile.featureCounts[layer];
			if (count > 0) layers[layer].tiles++;
			layers[layer].features += count;
		}
		if (isThinBuildingTile(tile.stats)) thinBuildingTiles++;
	}
	return { data, layers, thinBuildingTiles };
}

const NO_FLAGS = { isBridge: false, isTunnel: false };

/** String property or `fallback` (also when the tile stores another type). */
function stringProp(feature: VectorTileFeature, key: string, fallback: string): string {
	const value = feature.properties[key];
	return typeof value === 'string' ? value : fallback;
}

/** Calls `build` for each linestring of a (Multi)LineString feature and appends the result. */
function collectLines<T>(
	feature: Feature,
	build: (points: [number, number][]) => T,
	out: T[]
): void {
	const geometry = feature.geometry;
	if (geometry.type === 'LineString') {
		out.push(build(geometry.coordinates.map(toLngLat)));
	} else if (geometry.type === 'MultiLineString') {
		for (const line of geometry.coordinates) out.push(build(line.map(toLngLat)));
	}
}

function lineFeature(
	points: [number, number][],
	kind: string,
	kindDetail: string,
	flags: { isBridge: boolean; isTunnel: boolean }
): LinearFeature & RoadLine {
	return { bbox: bboxOfPoints(points), points, kind, kindDetail, ...flags };
}

/** Appends each polygon of a (Multi)Polygon feature as an area (with `tile` for water). */
function collectPolygons(feature: Feature, kind: string, out: AreaPolygon[]): void;
function collectPolygons(feature: Feature, kind: string, out: WaterPolygon[], tile: string): void;
function collectPolygons(
	feature: Feature,
	kind: string,
	out: (AreaPolygon | WaterPolygon)[],
	tile?: string
): void {
	const geometry = feature.geometry;
	const push = (coordinates: Position[][]) => {
		const rings = coordinates.map((ring) => ring.map(toLngLat));
		const area: AreaPolygon = {
			bbox: bboxOfRings(rings),
			rings,
			kind,
			areaM2: ringsAreaM2(rings)
		};
		out.push(tile === undefined ? area : { ...area, tile });
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
	const push = (coordinates: Position[][]) => {
		const rings = coordinates.map((ring) => ring.map(toLngLat));
		out.push({ bbox: bboxOfRings(rings), rings });
	};
	if (geometry.type === 'Polygon') {
		push(geometry.coordinates);
	} else if (geometry.type === 'MultiPolygon') {
		for (const polygon of geometry.coordinates) push(polygon);
	}
}

/** Narrows a GeoJSON `Position` to a `[lng, lat]` tuple (drops any elevation). */
function toLngLat(position: Position): [number, number] {
	return [position[0], position[1]];
}

function bboxOfRings(rings: [number, number][][]): FeatureBBox {
	const bbox: FeatureBBox = [Infinity, Infinity, -Infinity, -Infinity];
	for (const ring of rings) for (const point of ring) extendBBox(bbox, point);
	return bbox;
}

function bboxOfPoints(points: [number, number][]): FeatureBBox {
	const bbox: FeatureBBox = [Infinity, Infinity, -Infinity, -Infinity];
	for (const point of points) extendBBox(bbox, point);
	return bbox;
}

function extendBBox(bbox: FeatureBBox, [lng, lat]: [number, number]): void {
	if (lng < bbox[0]) bbox[0] = lng;
	if (lat < bbox[1]) bbox[1] = lat;
	if (lng > bbox[2]) bbox[2] = lng;
	if (lat > bbox[3]) bbox[3] = lat;
}
