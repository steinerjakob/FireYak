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
	/** Protomaps `kind` (highway, major_road, medium_road, minor_road, path, …). */
	kind: string;
}

/** A Protomaps `water` polygon (tile-clipped; pieces of one lake may repeat per tile). */
export interface WaterPolygon {
	bbox: FeatureBBox;
	/** Outer ring first, holes after; each ring is a closed list of [lng, lat]. */
	rings: [number, number][][];
	/** Protomaps `kind`, e.g. `water`, `lake`, `basin`. */
	kind: string;
	/** `z/x/y` of the tile the piece was decoded from. */
	tile: string;
}

export interface ObstacleData {
	buildings: BuildingPolygon[];
	roads: RoadLine[];
	/** Water polygons, when decoded (used to find a pond's outline). */
	water?: WaterPolygon[];
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
}

/** Decoded obstacles plus the coverage they were decoded with. */
export interface ObstacleResult extends ObstacleData {
	water: WaterPolygon[];
	coverage: BasemapCoverage;
}
