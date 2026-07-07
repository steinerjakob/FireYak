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

export interface ObstacleData {
	buildings: BuildingPolygon[];
	roads: RoadLine[];
}
