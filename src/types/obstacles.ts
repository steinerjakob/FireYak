/**
 * Shared geometry types for road-aware distance ranking. Building footprints
 * and road centerlines are decoded from the Protomaps basemap vector tiles
 * (see `src/mapHandler/obstacleGeometry.ts`) and consumed by the weighted
 * straight-line heuristic (`src/helper/weightedDistance.ts`) and the road
 * graph router (`src/mapHandler/roadRouting.ts`).
 */

/** Feature bounding box as [west, south, east, north] (degrees). */
export type FeatureBBox = [number, number, number, number];

export interface BuildingPolygon {
	bbox: FeatureBBox;
	/** Outer ring first, holes after; each ring is a closed list of [lng, lat]. */
	rings: [number, number][][];
}

export interface RoadLine {
	bbox: FeatureBBox;
	/** Polyline vertices as [lng, lat]. */
	points: [number, number][];
	/** Protomaps `kind` (highway, major_road, medium_road, minor_road, path, other). */
	kind: string;
	/** OSM `highway` value (track, footway, steps, residential, ...); `''` when absent. */
	kindDetail: string;
	/** The way is on a bridge (`is_bridge`). */
	isBridge: boolean;
	/** The way is in a tunnel (`is_tunnel`). */
	isTunnel: boolean;
	/** Raw OSM `access` value; absent when untagged. Only `military` matters for routing. */
	access?: string;
}

/** A Protomaps polygon with a `kind` (landuse, water) and its area. */
export interface AreaPolygon {
	bbox: FeatureBBox;
	/** Outer ring first, holes after; each ring is a closed list of [lng, lat]. */
	rings: [number, number][][];
	/** Protomaps `kind`, e.g. `farmland`, `forest`, `water`. */
	kind: string;
	/** Outer ring minus holes in square meters (planar, local scale). */
	areaM2: number;
}

/** A Protomaps line that is not a road: rail, water lines, cliffs. */
export interface LinearFeature {
	bbox: FeatureBBox;
	points: [number, number][];
	/** Protomaps `kind`: `rail`, a water line kind (`river`, `stream`, ...) or `cliff`. */
	kind: string;
	/** Detail value (`rail`, `tram`, `subway`, `disused`, ...); `''` when absent. */
	kindDetail: string;
	isBridge: boolean;
	isTunnel: boolean;
}

/** A Protomaps `water` polygon (tile-clipped; pieces of one lake may repeat per tile). */
export interface WaterPolygon extends AreaPolygon {
	/** `z/x/y` of the tile the piece was decoded from. */
	tile: string;
}

/** Source layers of the Protomaps basemap that routing reads. */
export type ObstacleLayer = 'buildings' | 'roads' | 'landuse' | 'water' | 'earth';

export interface ObstacleData {
	buildings: BuildingPolygon[];
	/**
	 * Road centerlines with their flags. Rail and ferry are not in here (rail is in
	 * `rails`); whether a way is walkable or excluded is decided by
	 * `classifyRoad` in `hoseCostModel.ts`.
	 */
	roads: RoadLine[];
	/** `kind=rail` of every `kind_detail`; kept apart so road mode is unchanged. */
	rails: LinearFeature[];
	landuse: AreaPolygon[];
	/** Water polygons (also used to find a pond's outline). */
	waterAreas: WaterPolygon[];
	/** Water lines: rivers, streams, drains, canals, ditches. */
	waterLines: LinearFeature[];
	/** `earth` lines with `kind=cliff`. */
	cliffs: LinearFeature[];
}

/** What one source layer contributed to a decode (plan section 6.2, 6.9). */
export interface LayerCoverage {
	/** Decoded tiles in which the layer had at least one feature. */
	tiles: number;
	/** Features of the layer read from the decoded tiles (before filtering). */
	features: number;
}

/** How much of the basemap a routing window got (plan §6.9). */
export interface BasemapCoverage {
	/** `full`: every tile decoded; `partial`: some missing or capped; `none`: no tile. */
	basemap: 'full' | 'partial' | 'none';
	/** More tiles cover the window than one call decodes; the rest were skipped. */
	truncated: boolean;
	/** Tiles that were unavailable (offline and uncached). */
	missingTiles: number;
	totalTiles: number;
	/**
	 * Per source layer. Protomaps omits a layer that a tile has no features for, so
	 * `tiles` below the decoded count is normal (open farmland has no `buildings`).
	 */
	layers: Record<ObstacleLayer, LayerCoverage>;
	/**
	 * Decoded tiles that map much residential land with hardly any buildings
	 * (`isThinBuildingTile` in `hoseCostModel.ts`); `optimized` routing then
	 * falls back to roads (plan §6.11).
	 */
	thinBuildingTiles: number;
}

/** Decoded obstacles plus the coverage they were decoded with. */
export interface ObstacleResult extends ObstacleData {
	coverage: BasemapCoverage;
}
