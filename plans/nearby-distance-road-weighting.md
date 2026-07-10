# Road-aware ranking for nearby water sources

## Context

Reddit feedback (r/openstreetmap, thread `1pcc97i`): the nearby-sources list ranks by pure
haversine distance, so a hydrant on a *parallel* street (straight line cuts across a building
block) is suggested before a slightly farther hydrant on the *same* road — even though hoses
get laid along roads, not through buildings. Commenter *wung* proposed a cheap heuristic
instead of full routing:

> For each hydrant: draw the direct line, intersect it with buildings (+weight) and road
> areas (−weight), accumulate, and sort by `distance × weight`. Covers ~90% of cases.

Current behavior: `sortElementsByDistance()` in `src/mapHandler/markerHandler.ts:290` sorts
by `distanceTo()` (haversine, `src/types/geo.ts:15`). The list is filled by
`searchNearbyMarkers()` in `MainMap.vue:938` (user location, 2000 m radius, re-runs on map
events) and rendered by `NearbyMarker.vue` (also derives the B-tube count from the distance).

## Approach: weighted straight line, geometry from the basemap vector tiles

Instead of querying Overpass for buildings/roads (extra load we just worked to *reduce*, and
dead when offline), read building polygons and road lines from the **Protomaps vector tiles
that are already on the device**. The `offline://` protocol serves them cache-first
(`src/offline/offlineProtocol.ts`), so this works fully offline in downloaded areas and adds
zero Overpass traffic. Protomaps basemaps v4 tiles contain `buildings` (polygons) and `roads`
(lines with a `kind` property) source layers; z15 is the max zoom and carries full detail.

Rather than exact line/polygon intersection, sample the straight line every ~10 m (reusing
`pointsEveryMetersBetween()` from `src/helper/distanceCalculation.ts:80`) and give each
sample a per-meter cost:

| sample lands…                        | weight            |
| ------------------------------------ | ----------------- |
| inside a building polygon            | `BUILDING_WEIGHT` = 4.0 |
| within ~6 m of a road line           | `ROAD_WEIGHT` = 0.75    |
| anywhere else                        | 1.0               |

`effectiveDistance = Σ (stepMeters × weight)`. Sort by `effectiveDistance`, keep displaying
the true straight-line distance. Getting the weights right is the known hard part (per the
Reddit thread) — keep all constants in one exported block for tuning.

## Implementation steps

### 1. Expose a reusable cache-first tile fetch

`src/offline/offlineProtocol.ts` — extract the tile branch of the protocol handler
(tileStore.get → network fetch → write-through gate, lines ~126–146) into an exported
`fetchTileCacheFirst(source, z, x, y, signal?): Promise<ArrayBuffer | null>`; the protocol
handler and the new feature both call it (single source of truth for tile access, including
the `isInsideDownloadedArea` write-through rule). Return `null` where the handler currently
returns the empty buffer.

### 2. New module: decode obstacle geometry from tiles

`src/mapHandler/obstacleGeometry.ts` (new):

- deps: add `@mapbox/vector-tile` + `pbf` (tiny, the standard MVT decoder).
- `getObstaclesForBounds(bounds: GeoBounds)` → `{ buildings: Ring[][], roads: Line[] }`
  - enumerate z15 tiles via `lngLatToTile()` / `PROTOMAPS_MAX_ZOOM` from
    `src/offline/tileMath.ts`;
  - fetch each via `fetchTileCacheFirst('protomaps', 15, x, y)`;
  - decode source layers `buildings` and `roads` (`VectorTileFeature.toGeoJSON(x, y, z)`
    yields lng/lat); filter `roads` to drivable/layable kinds (drop `rail`);
  - precompute a bbox per feature for cheap prefiltering;
  - keep a small in-memory LRU keyed by tile coord (the search re-runs on every location
    update; decoding 9–20 tiles per run without a cache would be wasteful). Empty/missing
    tiles (offline gap) decode to no features — harmless.

### 3. New helper: weighted distance

`src/helper/weightedDistance.ts` (new, pure — no map/store imports):

- `effectiveDistance(from: GeoPoint, to: GeoPoint, obstacles): number`
  - sample with `pointsEveryMetersBetween(from, to, 10)`;
  - point-in-polygon: small ray-casting implementation with bbox prefilter (no turf needed);
  - road proximity: point-to-segment distance in a local meter projection, bbox-prefiltered;
  - exported tuning constants: `SAMPLE_STEP_M = 10`, `BUILDING_WEIGHT = 4`,
    `ROAD_WEIGHT = 0.75`, `ROAD_HALF_WIDTH_M = 6`.

### 4. Wire into the nearby list

- `src/composable/nearbyWaterSource.ts`: add `effectiveDistance: number` to `NearbyMarker`.
- `src/mapHandler/markerHandler.ts` `sortElementsByDistance()`:
  - compute haversine `distance` as today (display + B-tube count stay truthful);
  - load obstacles once for the bounds covering the candidates, then compute
    `effectiveDistance` for the nearest ~30 candidates within ~1500 m (beyond that, weight 1
    — keeps tile count and CPU bounded); farther markers keep
    `effectiveDistance = distance`;
  - sort by `effectiveDistance`, tie-break by `distance`;
  - **fail open**: any error (no tiles, decode failure, offline+uncached) → fall back to
    plain haversine ordering. The list must never break because of this feature.
- `src/components/NearbyMarker.vue`: no change required (keeps showing straight-line
  distance). Optional polish: subtle icon/hint when an item was promoted past a
  geometrically closer one.

### 5. Optional: settings escape hatch

A `roadAwareSorting` boolean (default on) in the existing settings store, surfaced next to
the marker filters — cheap insurance while the weights are being tuned. Skip if it clutters
the UI; the fail-open path already covers robustness.

## Verification

1. `npm run dev`, open the nearby-sources view (`/nearbysources`).
2. Real-world scenario from the Reddit comment: pick a spot mid-block between two parallel
   streets in a dense town (dev-tools sensor override or map-center fallback). Confirm a
   same-road hydrant now ranks above a closer parallel-road hydrant, while displayed meter
   values stay the straight-line ones.
3. Offline check: download the area, go offline (dev-tools network → offline), confirm the
   weighted order still applies (tiles come from the store) and that an *undownloaded*
   offline area gracefully falls back to haversine order.
4. Console sanity harness (temporary): log `distance` vs `effectiveDistance` for the top 10
   to tune `BUILDING_WEIGHT` / `ROAD_WEIGHT` against a few known intersections.
5. Perf: ordering computation for ~30 candidates should stay well under ~100 ms after the
   first run (decoded-tile cache warm); verify no jank while panning with the panel open.

## Future extension (out of scope)

The decoded `roads` layer is the foundation for real routing later: build a small graph from
road segments and run A* to get true hose-path length — would improve the B-tube estimate and
could replace the straight "path to selected marker" line. The heuristic above ships value
now and the tile-decoding module carries over unchanged.
