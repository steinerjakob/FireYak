# Hose routing: optimized mode, slope, steep-section warnings, non-blocking data

> **Code references.** Every `file:line` below points to commit `558308a`
> (`feature/110-pond-shore`), whose tree is identical to `main` at `1726b5c`
> after #114 was merged.
> Read them with `git show 558308a:<path>`. The local checkout may be on another
> branch, where the line numbers differ.
>
> **Status of this plan.** It replaces the routing parts of
> `plans/nearby-distance-road-weighting.md` and §B of
> `plans/pump-calculation-offline-routing.md`. Both now start with a note that lists
> what in them is out of date.
>
> **How sure each statement is.** **MEASURED** means decoded or computed from real
> tiles or OSM data during the research. **ESTIMATED** or **INFERRED** means
> reasoned from measurements or recalled, not checked. **OPEN** means the owner
> or a measurement must decide. Every cost and threshold in this plan is a
> starting value to tune on the five test scenes (§5).

## 1. Context and goal

Hose routing has two modes today, chosen by the boolean setting `clampHosesToRoads`:

- **road graph:** `roadRouting.ts`, used when the setting is on.
- **terrain grid:** `gridRouting.ts`, used when the setting is off (the default).

The owner's screenshots and the research found these problems:

- Road mode gives absurd detours.
- Terrain mode cuts through gardens and buildings.
- Neither mode knows about slope, land use, railways or water.
- The list and the map label show different lengths.
- Routing waits on Overpass, which in real use times out "most of the time" (owner).

Goal:

1. Add the mode **`optimized`**: a weighted cost grid built from Protomaps z15
   and the Mapterhorn DEM at z14. It becomes the default and **replaces** the
   terrain-only mode. The end state has two modes, `optimized` and `roads`
   (§6.7).
2. Fix the defects of the two existing modes. The terrain-mode fixes carry over
   into the single cost grid that remains.
3. Price slope into the cost.
4. Show steep and off-road sections on the route line, with warnings for steep
   stretches and for excess hose pressure on downhill lines (§6.13).
5. Never block routing on Overpass.
6. Optional, last: a barrier extract in `fireyak-data`.

## 2. Owner's screenshots → verified cause

All four come from scene 1 (§5). The pond numbers come from the screenshots.
The hydrant numbers come from the research brief. Which screenshot showed which
hydrant mode is INFERRED from that brief.

| # | Screenshot | Verified cause |
|---|---|---|
| 1 | Pond, road mode: 1.7 km / 85 hoses | The only road within `MAX_SNAP_M = 100` (`roadRouting.ts:27`) of the shore point is a cycleway that leads away from the village. The farm track that comes within 198 m is out of snap range. A faithful JS port of `roadRouting` gave 1,727 m. Attaching at the track would give ≈ 842 m. The graph itself is healthy: 11 components, the main one 56.6 km, no broken track stubs. Also, the shore point is fixed **before** routing as the straight-line nearest outline point (`waterSourceAccess.ts:86`), so the router cannot pick a better point on the shore. |
| 2 | Pond, terrain mode: 528 m straight across farmland | The behaviour is as designed: the grid has no land-use classes, and all non-road, non-building cells cost `GRID_OPEN_FACTOR = 1.0` (`gridRouting.ts:22`). String pulling then draws a straight line. The number is the shortest conceivable line, not a recommendation. |
| 3 | Hydrant ~300 m east (node 4477703437), road mode: 295 m | The road route is plausible. It serves as the reference value. |
| 4 | Same hydrant, terrain mode: 232 m through gardens | The straight drawn line crosses 4 building polygons that **are in the tile**, so no data is missing. Smoothing lets the line through for three reasons: line of sight is checked from cell centres (`gridRouting.ts:282-297`); footprints are only point-sampled every 4 m (`:285`); and the drawn line starts at the true origin/target, not the checked cell centre (`:388-390`). The hydrant position is approximate. |

## 3. Today's code (verified at 558308a)

### 3.1 Data

- `obstacleGeometry.ts` decodes only the z15 `buildings` and `roads` layers
  (`:16-21`, `:97-127`). The only road kinds dropped are `rail` and `ferry`
  (`:21`).
- `MAX_TILES_PER_CALL = 32` (`:28`). The tile list is truncated silently apart
  from a `console.warn` (`:54-59`).
- A missing tile (`fetchTileCacheFirst` returns `null`) decodes to empty
  obstacles (`:101-102`). The **resolved empty promise stays in the 64-entry LRU**
  (`:83-93`): only a thrown error is evicted. So a tile that was missing once stays
  "empty" until it is evicted, even after the network returns.
- Tile URL: `https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=…`
  (`offlineProtocol.ts:20-21`).
- Tiles fetched outside downloaded areas are not persisted. Write-through happens
  only inside an area (`offlineProtocol.ts:123-127`).

### 3.2 Road mode (`roadRouting.ts`)

- The graph is undirected. It merges nodes within 2 m (`:31`), repairs
  T-junctions within 6 m (`:33`, `:194-250`) and labels components with
  union-find (`:252-269`).
- A point snaps to the nearest edge of up to 8 components within 100 m
  (`:27-29`, `:281-337`).
- Dijkstra runs over plain edge length (`:405-456`). Snap legs are priced by
  `legCost`, which is `effectiveDistanceMeters` from `nearbyRouting.ts:172,222`.
- The router returns `null` when nothing is within 100 m. Callers then draw a
  straight line (`MainMap.vue:1037`, `pumpCalculation.ts:283`).
- `meters` equals the drawn polyline length, legs included (`:502`, `:515`).

### 3.3 Terrain mode (`gridRouting.ts`)

- Cells are 8 m (`:14`). The cap is `MAX_GRID_CELLS = 250_000` (`:33`).
  Above the cap, `buildTerrainGrid` returns `null` (`:97`). `getRoutedPath`
  then silently uses the road graph instead (`nearbyRouting.ts:216-221`).
- Class factors (`:20-31`):

  | Class | Factor |
  |---|---|
  | road | 0.9 |
  | open | 1.0 |
  | building core | 30 |
  | building fringe | 4 |

- Buildings are rasterised per cell with a point-in-polygon test at the centre
  plus four corners (`:120-144`). Roads are drawn after buildings (`:148-163`).
- Dijkstra is 8-connected over the **whole** field, with no early exit
  (`:323-349`).
- `gridRoutePath` re-solves on every call (`:411-419`), and every
  `getRoutedPath` call re-solves too.
- `meters` is the unsmoothed cell-chain length plus the end offsets
  (`:352-359`).
- Smoothing is greedy string pulling (`:367-383`). It blocks only on
  building-core cells (`:245-279`) and on footprints point-sampled every 4 m
  between cell centres (`:282-297`). The drawn line then replaces the first and
  last centre with the true origin and target (`:388-390`), and those two end
  segments are never checked.
- The nearby list shows the router's `meters` (`NearbyMarker.vue:47`). The map
  label shows the drawn polyline length (`MainMap.vue:884-890`). In terrain mode
  the two differ by up to ~8 % (MEASURED in the research). In road mode they
  match.

### 3.4 Ponds (`waterSourceAccess.ts`, `areaShore.ts`)

- `accessPointFor` (`:58-87`) picks one of two points, before routing and in
  either mode:
  - a mapped suction point within `SUCTION_POINT_SHORE_TOLERANCE_M = 30`
    (`:28`), or else
  - the straight-line nearest outline point (`areaShore.ts:86-123`).
- `OUTLINE_WAIT_MS = 2500` (`:30`). It is awaited in `preloadPondOutlines`
  (`:114`, called from `markerHandler.ts:672-674` when online) and in
  `resolveAccessPoint` (`:130`, called from `MainMap.vue:1021` and
  `pumpCalculation.ts:381,580`).
- Outlines come from three places, in this order:
  1. the static extract, stored on the marker when it has ≤ 2000 vertices
     (`staticDataApi.ts:187-195,201`);
  2. the session cache;
  3. Overpass (`areaOutline.ts:28-47`).

### 3.5 Limits and context

- Ranking horizon: 1500 m straight and 30 targets (`nearbyRouting.ts:25-27`).
- The window margin is 150 m (`:29`).
- `getRoutedPath` returns `null` beyond 3000 m (`:211`), and the caller draws a
  straight line.
- A context is reused while it covers the query and is under 60 s old
  (`:31`, `:106-119`). The terrain grid is built lazily per context
  (`:54-59`).
- A marker line outside the nearby view is skipped beyond 2500 m
  (`MainMap.vue:992,1028`).

### 3.6 Setting

| What | Where |
|---|---|
| Store field `clampHosesToRoads`, default `false` | `settingsStore.ts:59-61` |
| Setter | `settingsStore.ts:86-88` |
| Preferences key `clamp_hoses_to_roads` | `composable/settings.ts:13` |
| Load | `composable/settings.ts:31,40,62-63` |
| Save | `composable/settings.ts:132-142,201` |
| Toggle in the view | `SettingsView.vue:63-73,241-243,256-258` |
| i18n `settings.map.clampToRoads.{label,description}` | `src/locales/{en,de}.json:453-456` |
| Readers | `markerHandler.ts:587-589`, `MainMap.vue:1033-1035`, `pumpCalculation.ts:274-276` |
| Option type `RoutingOptions.clampToRoads` | `nearbyRouting.ts:48-51`, used at `:139,163,209,216` |

No settings migration mechanism exists.

### 3.7 Elevation

- The DEM is capped at z12 in three places:
  - the style source (`MainMap.vue:369`);
  - `DEM_ZOOM` (`demElevation.ts:15`);
  - `TERRAIN_MAX_ZOOM = 12` (`offline/tileMath.ts:26`).
- The comment "z12 × 512 px ≈ 19 m/px" (`demElevation.ts:14`) is wrong. At 48°N
  the resolution is ≈ 12.8 m/px.
- Sampling is bilinear **within one tile**, clamped at the tile edges
  (`:91-111`). The decoded-tile LRU holds 8 tiles (`:18`).
- `decodeTerrariumTile`, `pointToTileCoord` and `sampleTile` are not exported.
- Elevation is used only after routing:
  - `resamplePolyline` samples every 20 m (`ELEVATION_RASTER`,
    `elevationData.ts:6`);
  - `getElevationDataForPoints` is called at `pumpCalculation.ts:625-626`;
  - the 3D segment length and pressure are computed at
    `calculatePumpPosition.ts:69-81`.
- The offline downloader always fetches zooms `0..zMax` (`tileDownloader.ts:148`).
  The jobs are defined in `offlineAreasStore.ts:68-79` and the size estimate in
  `offlineAreaActions.ts:18-33`.
- Hose count = `Math.ceil(m / tubeLength)`, default 20 m "B"
  (`MainMap.vue:818-822`).

## 4. What the data contains (MEASURED)

### 4.1 Protomaps z15 vector tiles

Real tiles were decoded for the five scenes. Four were compared with raw OSM
(OSM API `/map`, bboxes of ~0.39 km²; Vienna ~0.10 km²). These are small samples.

| Layer | Content relevant to hoses |
|---|---|
| `buildings` | polygons `kind=building` plus address points |
| `earth` | occasionally a `kind=cliff` line |
| `landuse` | `kind` + `sort_rank` only (no access). Seen: farmland, meadow, forest, wood, scrub, grass, residential, commercial, industrial, pitch, park, garden, pedestrian, cemetery, recreation_ground, hospital, railway, sand, kindergarten |
| `roads` | `kind` (highway, major_road, medium_road, minor_road, path, rail, ferry, other), `kind_detail` = OSM highway/railway value (track, path, footway, cycleway, sidewalk, crossing, steps, pedestrian, corridor, service, residential, living_street, unclassified, tertiary…; rail: rail, tram, subway, disused), `is_bridge`, `is_tunnel`, `access` (raw OSM value, 26/26 matched), `oneway`, `ref`, `name`, `min_zoom`, `sort_rank`. **No `layer`.** |
| `water` | polygons kind water/lake/basin/swimming_pool/fountain; lines with kind_detail river/stream/drain/canal/ditch. No width, culvert or intermittent flag |
| `pois`, `places`, `boundaries` | not needed |

The tiles contain **no** barrier or fence layer anywhere. They also lack
surface, tracktype, sac_scale, foot, layer, incline and step_count.

Fidelity outside dense city centres:

- Roads: 100 % of OSM highway length is present, mean deviation 0.04–0.06 m,
  and 96 % of junctions connect.
- Buildings: 400 in OSM vs 406 tile polygons, area IoU 0.985. Sheds, garages
  and roofs are present and not merged.
- Water: ponds and pools 19/20 (features under ~12 m² are dropped); streams 2/2
  within 0.1 m.
- Rail: heavy rail is present at full length; abandoned rail is dropped.
- Coordinate quantisation: 0.2 m.

Vienna centre: 35 % of the road length is missing, almost all of it
`footway=sidewalk` and crossings. The cause is unknown; the street centrelines
remain.

`amenity=parking` and `landuse=retail` mostly have **no** landuse polygon.
`farmyard` shows up as farmland.

Obstacles found only in OSM in the samples:

| Obstacle | Length in samples |
|---|---|
| walls | 1,121 m |
| retaining walls | 390 m |
| fences | 205 m |
| hedges | 23 m |
| gates, lift gates, bollards | not in tiles |

Barrier density in OSM is very low:

| Area | Barrier ways | Estimated tile size |
|---|---|---|
| farmland | 0 | — |
| village | 1 hedge | — |
| small town | 12 | 0.6–0.7 kB/km² |
| Vienna centre (0.1 km²) | 12 | 4–5 kB/km² |

Overpass was unusable during the research: 8 requests to two public instances
got 0 answers (resets, 502/504, 60 s timeouts). This is partly a sandbox proxy
effect.

### 4.2 Mapterhorn DEM (terrarium, 512 px, lossless WebP)

- Real data goes up to z16; z17 returns 404. There are no seams.
- The model is bare earth. A building-footprint test gave a median of +0.08 m
  in Vienna and +0.16 m in Innsbruck. Vertical noise is ~0.2 m.

| Zoom | m/px at 48°N | Vertical step | Bytes per km² |
|---|---|---|---|
| z12 | 12.75 | 0.5 m | ~2 kB |
| z13 | 6.38 | 0.25 m | — |
| z14 | 3.19 | 0.125 m | 25–45 kB |
| z15 | 1.59 | 0.0625 m | 90–136 kB |
| z16 | 0.80 | — | 320–327 kB |

Share of pixels steeper than a threshold, by zoom:

| Place | Threshold | z12 | z14 | z15 | z16 |
|---|---|---|---|---|---|
| Lower Austria farmland | > 50 % | 0.0 % | 0.0 % | 0.1 % | — |
| Melk | > 60 % | 0.9 % | — | 3.2 % | — |
| Innsbruck, 8 m cells | > 60 % | 7.2 % | 8.8 % | 8.9 % | 8.9 % |

At Innsbruck z15 and z16 add almost nothing over z14; the source data is ≈ 3 m
there.

Artefacts:

- Bridges are cut through as terrain, so embankments look like walls where a
  bridge crosses.
- In Vienna, 70 % of the cells steeper than 25 % lie inside or within 4 m of
  building footprints. These are irrelevant or false.

### 4.3 Precache sizes (±700 m windows)

| Source | Size |
|---|---|
| Basemap z15 | 22 kB/km² (village), 30–46 (small town), 36 (mountain), 267 (Vienna) |
| DEM z15 | 89–136 kB/km² |
| DEM z14 | ~45 kB/km² |

## 5. Validation set: five scenes

**Ring simulation.** 16 bearings × 150/300/500 m around the hydrant. The vehicle
is moved to the nearest road within 60 m. "Ratio" = road-mode length ÷ straight
line. Road-mode lengths come from a faithful JS port of `roadRouting`.

**Optimized numbers are INDICATIVE.** They come from the research agent's own
8 m grid approximation with the costs of §6.3, not from the app's router.

**"Notably off-road"** is defined here (this plan's own definition) as > 30 m
and > 10 % of the route off roads and paths.

z15 tile ranges are for a ±700 m window. For scenes 1 and 2 they match the
research. For scenes 3–5 they were computed for this plan. The z14 DEM tiles are
the same ranges with `x >> 1`, `y >> 1`.

These scenes are also the committed test fixtures (§6.14). The fixtures crop
Vienna to ±500 m.

| # | Scene | Anchor | z15 tiles |
|---|---|---|---|
| 1 | Rural pond | Pond: OSM relation 7228761, 48.133078, 15.264769. Vehicle ≈ 48.1300, 15.2725 | x 17772–17774, y 11371–11373 |
| 2 | Melk | Hydrant node 5383895589, 48.2236782, 15.3372010 | x 17779–17780, y 11359–11361 |
| 3 | Persenbeug | Hydrant node 3567101294, 48.1903071, 15.0839766 | x 17756–17757, y 11363–11365 |
| 4 | Vienna centre | Hydrant node 10269061841, 48.2042818, 16.3680048 | x 17872–17874, y 11361–11363 |
| 5 | Innsbruck | Hydrant node 5870424885, 47.2446305, 11.3724783 | x 17418–17419, y 11491–11493 |

### Scene 1: rural pond

- Land use in the bbox: farmland 55 %, residential 22 %, meadow 17 %.
- Screenshots: road mode 1.7 km / 85 hoses (reproduced: 1,727 m); terrain mode
  528 m straight across farmland.
- The cycleway and farm track facts are in §2. Attaching at the track gives
  ≈ 842 m.
- Hydrant ~300 m east (node 4477703437): road mode 295 m; terrain mode 232 m
  through 4 building polygons.

### Scene 2: Melk

- Layout around the hydrant:
  - a double-track railway 24–35 m to the north;
  - one road underpass ~155 m WNW (a rail bridge; the road is not tagged
    tunnel);
  - a 10,000 m² building block north of the tracks;
  - a stream 40 m to the south;
  - a road in a cutting with banks steeper than 60 %, also to the south;
  - farmland beyond.
- Rail is in the tiles: 4.2 km on the surface and 1.8 km flagged `is_tunnel`.
  The app throws it away.
- Ring results over 38 positions:

  | Measure | Result |
  |---|---|
  | road ÷ straight > 1.8 | 23 positions |
  | straight line crosses heavy rail | 24 |
  | straight line crosses buildings | 29 |
  | straight line crosses > 40 % gradient | 29 |
  | median ratio at 150 / 300 / 500 m | 3.06 / 1.89 / 1.68 |
  | worst ratio | 4.76 |

- No position has both a reasonable road route and a clean straight line.
- Indicative optimized: 8 of 38 positions go notably off-road.

### Scene 3: Persenbeug

- The hydrant sits on a terrace above a scarp that drops ~26 m, 100–200 m to the
  S/SE.
- The Danube is 506 m away; its polygon blocks correctly. There is no rail.
- Ring results over 33 positions:

  | Measure | Result |
  |---|---|
  | ratio > 1.8 | 16 positions |
  | worst ratio | 5.29 (151 m straight vs 797 m road) |
  | median ratio at 150 / 300 / 500 m | 2.77 / 1.79 / 1.66 |

- Indicative optimized: 18 of 33 positions go notably off-road.

### Scene 4: Vienna centre

- Buildings cover 42 % of the area.
- Everything with `kind=rail` is one of three things:
  - tram, on the surface; 25 of 47 pieces lie within 4 m of a street line;
  - subway: 12.8 km `is_tunnel`, 314 m on the surface;
  - disused.
- There are `path/corridor` indoor passages and 5.8 km of tunnelled footways.
- 711 of 1513 road features carry `oneway`.
- Ring results over 45 positions:

  | Measure | Result |
  |---|---|
  | ratio > 1.8 | 4 positions |
  | median ratio at 150 / 300 / 500 m | 1.46 / 1.40 / 1.35 |
  | worst ratio | 2.14 |
  | straight line crosses buildings | 43 |

- Indicative optimized:
  - every path is 91–100 % on roads or paths;
  - 0 of 45 go notably off-road;
  - median length is 0.86 of the road route, from cutting corners.
- Only 13.9 % of the area is open ground more than 6 m from a road. Unmapped
  courtyards (no landuse polygon) are 0.7 %.

### Scene 5: Innsbruck

- The hydrant is at 835 m, on the rim of a forested scarp that drops 107 m within
  300 m to the NW.
- Of the window, 41.8 % is steeper than 25 % and 10.6 % steeper than 60 % (79 % of
  the latter is forest).
- Measured gradients (10 m windows):

  | Feature | Share of length |
  |---|---|
  | roads > 8 % | 22.4 % |
  | roads > 15 % | 0.6 % |
  | roads > 30 % | 0 % |
  | paths > 30 % | 9 % (645 m real, 270 m artefact) |
  | steps > 20 % | 64 % |

- Only 8 of 48 ring points had a road within 60 m. With a relaxed rule (150 m,
  tracks allowed) there are 29 positions.
- Case "500 m north", vehicle ~190 m below:

  | Route | Length |
  |---|---|
  | straight | 512 m, 70 % max gradient |
  | grid without slope | 515 m, straight down the scarp |
  | grid with slope rules | 1,367 m on roads and paths |
  | road mode | 1,504 m |

- Over all 29 positions, the slope rules cut the metres routed over ground
  steeper than 60 % from 408 to 25.
- Blocking at 60 %, at 80 %, or not at all gave **identical** lengths: the rising
  penalty alone is enough.
- A z12-only DEM (24 m baseline, no blocking) changed 1 of 29 routes.
- 3D extra length: median 0.1 %; worst 2.3 % on roads and 10.2 % for a straight
  line.
- Height difference on four positions is 177–220 m. That is 18–22 bar static
  against ~6 bar friction, assuming 1.1 bar per 100 m of B hose at 800 l/min.
  Because the vehicle is below, this is a pressure **gain**. Whether it exceeds
  hose ratings is now judged by the pressure rule (§6.13): it gives a warning.

## 6. Design (decisions already made)

### 6.1 Engine

**Chosen:** extend the terrain grid (`gridRouting.ts`) into a weighted cost grid.
It serves `optimized`. Until phase 5 it also serves the transitional `direct`
mode (§6.7); after that, one cost grid remains.

Rejected:

- **Visibility graph.** It is O(n²) in obstacle vertices. Obstacles can only be
  binary, so land-use costs and slope cannot be expressed.
- **Road graph plus shortcut edges.** It cannot reach targets inside fields and
  would still need rasterised land-use costs to price the shortcuts. A light
  variant is kept only to improve road mode: shore targets, and a longer final
  leg priced by the cost model.
- **Hosted routing engines** (ORS, Valhalla, GraphHopper instances).
  Off-network routing is not documented, and free instances have rate or
  commercial limits. This comes from search summaries and is **not fully
  verified**. They also break offline use.
- **Server-side pre-rasterised cost tiles.** Every tuning step would need a
  rebuild, and per-query rules cannot be baked in: escape radius, the target
  pond, bridge rules.

### 6.2 Data for `optimized`

The inputs are Protomaps z15 and Mapterhorn z14. Nothing from Overpass or
`fireyak-data` is required.

The decoder in `obstacleGeometry.ts` is extended to read:

- `roads.kind_detail`, `is_bridge` and `is_tunnel`;
- rail, kept in a separate `rails` array so road mode is unchanged;
- `landuse` polygons;
- `water` polygons and lines;
- `earth` lines with `kind=cliff`.

Type changes in `src/types/obstacles.ts`:

```ts
export interface RoadLine { bbox; points; kind: string; kindDetail: string; isBridge: boolean; isTunnel: boolean }
export interface AreaPolygon { bbox: FeatureBBox; rings: [number, number][][]; kind: string; areaM2: number }
export interface LinearFeature { bbox: FeatureBBox; points: [number, number][]; kind: string; kindDetail: string; isBridge: boolean; isTunnel: boolean }
export interface TileCoverage { requested: number; decoded: number; missing: number; truncated: number }
export interface ObstacleData {
  buildings: BuildingPolygon[];
  roads: RoadLine[];          // as today: rail and ferry excluded; path/corridor filtered by classifyRoad from phase 3 (kept by the decoder in phase 2)
  rails: LinearFeature[];     // kind=rail, every kind_detail
  landuse: AreaPolygon[];
  waterAreas: AreaPolygon[];
  waterLines: LinearFeature[];
  cliffs: LinearFeature[];
  coverage: TileCoverage;
}
```

**Pure decode vs I/O.** Each module is split into a pure part (bytes in, data
out) and a thin I/O part. The pure part can then run under vitest in Node
(§6.14) and in the worker (§6.10).

- `src/mapHandler/obstacleDecode.ts` (pure):
  `decodeObstacleTile(buffer, x, y, z): ObstacleData`. It does not import
  `offlineProtocol`, which pulls in `maplibre-gl` and the Capacitor-backed
  `tileStore`.
- `obstacleGeometry.ts` keeps fetching, the LRU and coverage. It takes an
  injectable `TileFetcher = (source, z, x, y, signal?) => Promise<ArrayBuffer | null>`,
  defaulting to `fetchTileCacheFirst`.
- The DEM is split the same way:
  - `src/helper/demRaster.ts` (pure): `terrariumToElevations(rgba, size)`,
    cross-tile bilinear sampling, `buildHeightRaster`;
  - `demElevation.ts`: image decode via `createImageBitmap` and fetching.

### 6.3 Cost model: one shared module

Create `src/mapHandler/hoseCostModel.ts`. It is pure: no store or map imports,
and it is safe to use in a worker. It exports:

- the cell classes;
- the class factors;
- the classifiers `classifyRoad`, `classifyLanduse`, `classifyWaterLine`;
- `slopeFactor`;
- the warning thresholds used by the UI (§6.8).

Every factor is ≥ 1.0, which keeps A* admissible. **All numbers are starting
values to tune on the scenes.**

| Class | Source | Factor |
|---|---|---|
| `ROAD` | `roads`: any kind except `highway` (motorway), `ferry`, `rail` | 1.0 (today 0.9) |
| `PATH` | `kind=path` with kind_detail path/footway/cycleway/track/pedestrian/sidewalk/crossing; also `kind_detail=track` under any kind | 1.05 |
| `STEPS` | `kind_detail=steps` | 1.5 |
| `BRIDGE` | any passable road/path with `is_bridge` | 1.0. Slope is ignored. No step from `BRIDGE` to a non-`ROAD`/`PATH`/`STEPS`/`BRIDGE` cell |
| `OPEN` | landuse farmland, meadow, grass, park, pitch, pedestrian, cemetery, recreation_ground | 1.25 |
| `UNKNOWN_OPEN` | no landuse polygon, or an unlisted kind (sand, hospital, kindergarten… until tuned) | 1.3 |
| `FOREST` | forest, wood, scrub, orchard | 1.6 |
| `YARD` | residential, commercial, industrial, garden, allotments | 3.0 |
| `RAIL_LANDUSE` | `landuse=railway` | 4 |
| `STREAM` | water line kind_detail stream/ditch/drain, buffered to one cell | 4 |
| `BUILDING_FRINGE` | footprint touches the cell, centre outside | 6 |
| `BUILDING_CORE` | centre inside a footprint | blocked. Inside the **escape radius** (~12 m around origin and target): 30 |
| `BLOCKED` | water polygons (except the target pond's own polygon, see §6.5); water lines river/canal; heavy rail on the surface; motorway on the surface; cliff lines; `landuse=military` | ∞ |

Rail and motorway rules:

- **Heavy rail** means `kind=rail` with `kind_detail` in {rail, light_rail,
  narrow_gauge}, **not** `is_tunnel` and **not** `is_bridge`.
- Tram, subway, disused, and any tunnelled or bridged rail **do not block**.
- A surface motorway is `kind=highway`, not tunnel, not bridge.

Excluded from both graph and grid:

- `ferry`;
- `path/corridor` (indoor passages);
- tunnelled footways and other tunnelled paths (`kind=path` with `is_tunnel`):
  **excluded** (owner decision). Most are underground passages (INFERRED).
  Tunnelled roads stay passable; `building_passage` arrives as a tunnelled
  road or path, so a passage under a building that is tagged as a footway is
  excluded too.

`access` and `oneway` are ignored: the fire service may enter private ground.
The one exception is military ground (owner decision): roads and paths with
`access=military` are excluded from graph and grid, and `landuse=military`
polygons are `BLOCKED`.

**Rasterisation order** (later layers overwrite earlier ones):

1. Default to `UNKNOWN_OPEN`.
2. Landuse in **descending area order**, so nested smaller polygons win (a park
   inside residential).
3. Water polygons → `BLOCKED`, water lines → `STREAM` or `BLOCKED`.
4. Buildings → `FRINGE` or `CORE`.
5. Surface heavy rail, surface motorway and cliffs → `BLOCKED`.
6. Passable non-bridge roads and paths.
7. Bridge roads and paths → `BRIDGE`.

Roads go **last**, so level crossings, underpasses and bridges stay passable.
Bridged rail and motorway are not drawn at all; they do not block the ground
below.

**Step cost** from cell u to neighbour v:

```
cost = step × (F(u) + F(v)) / 2 × slopeFactor(|h[v] − h[u]| / step, onRoad)
```

Averaging the two class factors makes the cost symmetric, so A→B equals B→A and
one Dijkstra serves both directions. Today the code uses `F(v)` only.

### 6.4 Slope

**Height raster.** It is aligned to the grid. It is sampled bilinearly
**across** tile edges, using neighbour tiles and a one-cell halo, then smoothed
3×3.

With only z12 available (existing offline areas), grades are taken over a 24 m
baseline (`ceil(24 / cellM)` cells) instead of per step.

**Factor** (piecewise linear in grade g = |Δh| / horizontal; symmetric up and
down):

| g | factor |
|---|---|
| ≤ 8 % | 1.0 |
| 25 % | 1.7 |
| 50 % | 4.0 |
| 80 % | 8.0 |
| ≥ 100 % | 12.0 (cap) |

On `ROAD`, `PATH` and `STEPS` cells the factor is capped at ×1.3. On `BRIDGE`
cells it is 1.0.

There is **no hard block**. The Innsbruck evidence shows the rising penalty is
enough. Not blocking also avoids false walls at the Melk cutting and at Vienna's
building edges.

**Constants.** Add `TERRAIN_ROUTING_ZOOM = 14` in `offline/tileMath.ts`, next to
`TERRAIN_MAX_ZOOM = 12`, which stays as the display zoom. z15 is not needed
(§4.2). Storage cost is ≈ 25–45 kB/km².

**Pressure.** Friction and uphill loss stay in the existing post-route
calculation (`calculatePumpPosition.ts`). The downhill static-pressure check is
new (§6.13).

**Reported metres** are the 3D length of the final polyline. List, label and
pump calculation all use this one number.

### 6.5 Search and endpoints

**Searches**

- **Nearby list:** one-to-many Dijkstra from the origin, with early exit once
  every target cell or goal set is settled.
- **Single path:** A* with the octile heuristic × 1.0. For a goal set, the
  heuristic is the octile distance to the set's bbox.
- **Heap:** a typed-array binary heap (`Float64Array` keys, `Int32Array` cells,
  grown by doubling).

**Reuse**

- Memoise the last solve per `(gridId, originCell)` (cost and prev arrays), so
  the selected marker's path after the list search needs no new solve.
- Keep one routing context per **origin-centred window**:
  - list: origin ± (1500 m + 150 m);
  - single path: bbox of the endpoints + `max(150 m, 0.25 × straight distance)`.
- If the solved path touches the window edge, enlarge the window once (×1.5) and
  re-solve.
- Do not build a new context per call.

**Ponds** (areas with an outline)

- The goal is a **set**: all passable cells 8-adjacent to an outline cell.
- The first goal cell popped wins.
- The endpoint is the exact nearest point of the outline to that cell
  (`nearestPointOnOutline`).
- A mapped suction point within 30 m stays the **only** goal.
- The pond's own water polygon stays blocked. The goal cells lie outside it, so
  "except the target pond" only has to keep the goal-adjacency test from
  treating that polygon as an ordinary obstacle.

**Road mode with ponds**

- Sample the shore every ~20 m as multiple targets; `routeFromOrigin` is
  already one-to-many.
- Allow a final leg of up to `POND_SHORE_SNAP_M = 250`, priced by the cost model
  (before phase 3, by `effectiveDistanceMeters`).
- Pick the cheapest arrival.

**Outline source order**

1. Static extract outline (`element.outline`), or the session cache.
2. The Protomaps `water` polygon that contains the marker (from the decoded
   tiles).
3. The marker point.

Overpass is still requested in the background for the highlight. A late answer
triggers the silent recompute of §6.9. **Routing never awaits it.**

### 6.6 Smoothing

Cost-aware string pulling over the cell chain:

- `chain[0]` and `chain[last]` are replaced by the **true** origin and target
  before smoothing starts.
- A shortcut i→j is accepted only if all of these hold:
  - the line cost along a supercover line ≤ the path cost between i and j
    × 1.02 + 2 m;
  - it crosses no `BLOCKED` cell;
  - it crosses no non-escape `BUILDING_CORE` cell;
  - it intersects **no building edge**. This is an exact segment/segment test
    with a bbox prefilter, plus a containment test for the endpoints. It
    replaces the point sampling at `gridRouting.ts:282-297`.
- Then run Douglas–Peucker at ~1.5 m. A vertex may be removed only if the new
  segment passes the same tests.

### 6.7 Settings: two modes in the end state

**End state** (from phase 5): two modes.

- **`optimized`**, the default.
- **`roads`**.

The terrain-only mode `direct` (today's `clampHosesToRoads = false`) exists only
as a **transitional** value while `optimized` is behind the dev flag (phases
3–4). It is removed in phase 5.

```ts
// phases 3–4
export type HoseRoutingMode = 'optimized' | 'roads' | 'direct';
// from phase 5
export type HoseRoutingMode = 'optimized' | 'roads';
// settingsStore: hoseRouting: HoseRoutingMode (replaces clampHosesToRoads)
// nearbyRouting: RoutingOptions { mode: HoseRoutingMode } (replaces clampToRoads)
```

**Preferences and migration.**

- The new key is `hose_routing`.
- The mapping is a pure function in the new `src/helper/hoseRoutingSetting.ts`:

  ```ts
  resolveHoseRouting(stored, phase): { mode; shouldPersist }
  ```

  It has a spec and is called from `loadSettings` in `composable/settings.ts`.

| Stored state | Phases 3–4 | From phase 5 |
|---|---|---|
| `hose_routing = 'optimized'` | `optimized` with the dev flag, else `direct` | `optimized` |
| `hose_routing = 'roads'` | `roads` | `roads` |
| `hose_routing = 'direct'` | `direct` | `optimized` |
| no `hose_routing`, `clamp_hoses_to_roads = 'true'` | `roads` | `roads` |
| no `hose_routing`, `clamp_hoses_to_roads = 'false'` or absent | `direct` | `optimized` |
| any other value | `direct` | `optimized` |

When the value is written back:

- **Phases 3–4:** the migrated value is **not** written back. Only an explicit
  choice is saved.
- **From phase 5:** the default is final. `loadSettings` writes `hose_routing`
  once (`shouldPersist`) and removes `clamp_hoses_to_roads`.

**UI: back to a toggle.** With two modes, a select adds nothing.

- The existing toggle (`SettingsView.vue:63-73`) stays: on → `roads`,
  off → `optimized`.
- The i18n keys stay `settings.map.clampToRoads.{label,description}`, with new
  texts:

| Key | en | de |
|---|---|---|
| `label` | Keep hose route on roads | Schlauchweg nur auf Straßen und Wegen |
| `description` | Off: the route weighs roads, fields, slopes and obstacles. On: roads and paths only, with short connections at both ends. | Aus: Die Route wägt Straßen, Felder, Steigungen und Hindernisse ab. Ein: nur Straßen und Wege, mit kurzen Anbindungen an beiden Enden. |

The en label is today's text. The de label changes from "Schlauchweg an Straßen
ausrichten".

**Phases 3–4 (transitional).**

- The toggle keeps today's behaviour: on → `roads`, off → `direct`.
- With `VITE_HOSE_ROUTING_OPTIMIZED=1` or in dev, an extra toggle "Optimized
  routing (preview)" (`settings.map.hoseRoutingPreview.{label,description}`, en
  and de) makes the off state `optimized`.
- No production user sees a change.

**Removed in phase 5:**

- `'direct'` in the type;
- the preview toggle and its keys;
- every `clampToRoads` branch;
- the legacy terrain-only cost path:
  - `GRID_ROAD_FACTOR`, `GRID_OPEN_FACTOR`, `GRID_BUILDING_FACTOR`,
    `GRID_BUILDING_FRINGE_FACTOR` (`gridRouting.ts:15-31`);
  - the four-class `CLASS_FACTOR` table (`:38-48`).

One cost grid remains, driven by `hoseCostModel.ts`.

`weightedDistance.ts` is deleted too once no caller remains. Today its callers
are `nearbyRouting.ts:172,191,222`. The label keeps the road-only comparison
(§6.8).

### 6.8 UI: two independent visual channels

The route line uses **dash = off-road** and **colour = steepness**:

| Section | Look |
|---|---|
| on road or path, grade ≤ 25 % | solid blue `#3388ff` |
| off-road | dashed blue |
| steep: > 25 % over ≥ 10 m | amber (solid or dashed by off-road) |
| very steep: > 50 % over ≥ 10 m | red, with small tick marks across the line |

**Implementation**

- Keep one GeoJSON source per line (`selected-path`, `pump-line`). Split the
  route into `LineString` runs with properties `{ offRoad: boolean; steep: 0 | 1 | 2 }`.
- Use two line layers:
  - `…-layer`, filter `offRoad == false`;
  - `…-offroad-layer`, filter `offRoad == true`, constant `line-dasharray`.
- Both use data-driven `line-color` via `['match', ['get', 'steep'], …]`. Do not
  rely on data-driven dash arrays.
- Ticks: a symbol layer with `symbol-placement: 'line'`, `symbol-spacing` ~12 px
  and a tick image registered with `map.addImage`, filtered to `steep == 2`.

**Route classification:** a new pure helper, `src/helper/routeProfile.ts`.

- Resample the polyline at 5 m and take grades over 10 m windows.
- Merge runs and drop runs shorter than 10 m.
- Off-road:
  - grid modes: the cell class along the segment is not
    `ROAD`/`PATH`/`STEPS`/`BRIDGE`;
  - road mode: the snap legs;
  - before the grid has classes: `isNearAnyRoad` (`weightedDistance.ts:136`)
    with 6 m.
- With only z12 DEM, at most the amber class is shown.

**Warnings.** Two slope triggers and one pressure trigger:

- **"Not recommended"** when any of these holds:
  - any stretch > 50 % for ≥ 10 m;
  - more than 50 m in total above 25 %;
  - the estimated static pressure at the lowest point of the line is ≥ 100 %
    of `maxHosePressure` (§6.13).
- **"Check pressure"** (amber) when that static pressure is ≥ 75 % of
  `maxHosePressure`.

The chips appear on:

- the nearby list item (`NearbyMarker.vue`);
- the map label;
- the pump panel (`SupplyPipeCalculation.vue`).

**Label**

```
1,367 m · ~69 B-Schläuche · ↑197 m · 340 m querfeldein
```

- The arrow is signed (↑ or ↓).
- The road-only length is added (`· Straße 1,504 m`) when it differs by > 15 %.
- Metres use the locale's thousands separator.

**Other UI**

- Always label the result as an estimate ("ca.", "Schätzung").
- Coverage chips: "Hindernisse (Zäune) unbekannt" (always, until phase 8);
  "Kartendaten unvollständig" when coverage is partial.
- One-time note: "Querfeldein-Abschnitte vor Ort prüfen".

All thresholds are starting values.

The steep display and the warnings apply to every mode that exists at the
time:

- in phase 1, the road graph and the terrain grid;
- from phase 5, `optimized` and `roads`.

They ship in phase 1, before `optimized` exists.

### 6.9 Never block on remote data

**Budget**

- The router may await only local reads and CDN tile fetches (basemap, DEM).
- The total budget is `ROUTING_DATA_BUDGET_MS = 1500`, enforced with an
  `AbortSignal` passed to `fetchTileCacheFirst`.
- It never awaits Overpass.
- It then routes on whatever is present and returns the coverage:

  ```ts
  { basemap: 'full' | 'partial' | 'none'; dem: …; barriers: … }
  ```

**Missing vs empty**

- `decodeTile` returns `{ status: 'ok' | 'missing', data }`.
- A missing tile is **not** kept in the decode LRU. Today it is
  (`obstacleGeometry.ts:83-93`).

**Late arrivals**

- Late tiles and outlines are written to the cache.
- They emit `routingDataArrived` on an `EventTarget` in a new
  `src/mapHandler/routingData.ts`.
- The visible path is recomputed silently: the label updates in place and the
  line gets a short width pulse (~600 ms), with no camera refit.
- The nearby list updates the metres in place and re-sorts on its next search
  tick, not under the user's finger (OPEN).

**Precaching.** Only CDN sources are precached. Precaching Overpass was
rejected. Priorities:

1. The selected route or pump-calculation window.
2. A 2 km ring around the GPS position, refreshed after moving > 500 m.
3. After a map move at zoom ≥ 14 and 1.5 s idle, and after the marker fetch;
   Wi-Fi only.

**Cache store.** A new IndexedDB DB, `FireRoutingCache` (module
`src/offline/routingCache.ts`), separate from downloaded areas (`tileStore`):

- LRU with a **byte** budget: default 50 MB, user setting `routingCacheMb`.
  Basemap bytes vary 12× with density: a 2 km ring is ~0.3 MB in a village and
  ~3.4 MB in central Vienna.
- TTL: 30 days for basemap, 180 days for DEM.
- At most 3 concurrent requests per source.
- No prefetch when offline or when `saveData` is set.

Lookup order in `fetchTileCacheFirst`:

1. `tileStore`
2. `routingCache`
3. network

The network result is written to `routingCache` for routing and prefetch
requests. Map browsing keeps today's rule.

### 6.10 Performance

**Adaptive cell size**

| Window | Cell |
|---|---|
| single path ≤ 1.2 km | 4 m |
| single path ≤ 2.5 km | 6 m |
| nearby list | 8 m |

- Raise the cell cap to ~400k.
- Replace the per-cell point-in-polygon rasterisation (`gridRouting.ts:120-144`)
  with a **scanline polygon fill** (even-odd, holes respected). Fringe = cells
  touched by an edge (supercover) but not filled.

**Web Worker** for the `optimized` solve:

- The worker decodes the MVT and the DEM and keeps its own LRU.
- Capacitor plugins (native `tileStore` on the Filesystem) are not reachable
  from a worker (INFERRED). So the main thread fetches the bytes cache-first and
  **transfers** the `ArrayBuffer`s; the worker only decodes and solves.
- Where `OffscreenCanvas` 2D is unavailable in workers, fall back to
  main-thread decode.

**All timing figures are ESTIMATES** (cold nearby list up to ~1 s on a mid-range
phone) and must be measured in phase 0 and phase 6.

### 6.11 Safeguards

**Thin building data.** Some regions, mostly outside Austria, map residential
land use with few buildings.

- Per z15 tile, compute residential area (residential/commercial/industrial
  landuse) and building area.
- Flag the tile as "buildings incomplete" when residential area > 20 % of the
  tile and building area / residential area < 0.05.
- The thresholds are ESTIMATES. All five scenes must stay unflagged, and one
  poorly mapped sample still has to be picked (OPEN).
- On a flagged tile in the window: `coverage.basemap = 'partial'`, show a chip,
  and route that request in `roads` mode, with the reason shown.

**Every silent fallback becomes visible.** `RouteResult.fallback` takes one of:

- `cellCap`
- `tileCap`
- `tooFar` (> 3 km straight)
- `noRoadNearby`
- `gridUnreached`
- `thinBuildings`

Each value maps to a short chip text.

### 6.12 Result type

```ts
export interface HoseRoute {
  points: GeoPoint[];
  meters: number;               // length of `points`: 2D until phase 4, then 3D; the ONE number shown everywhere
  segments: { from: number; to: number; offRoad: boolean; steep: 0 | 1 | 2 }[];
  climbM: number | null;        // signed height(target) − height(origin)
  metersOver25: number; metersOver50: number; maxGradePct: number | null;
  staticPressureMaxBar: number | null;          // §6.13
  pressureLevel: 'ok' | 'caution' | 'warning' | null;
  roadOnlyMeters: number | null;
  demZoom: number | null;
  fallback: RouteFallback | null;
  coverage: RoutingCoverage;
}
```

### 6.13 Downhill pressure rule

**What exists today.**

The pump-calculation store is `src/store/pumpCalculationSettings.ts`. Its
Preferences keys are `pumpCalc_*` (`:6-14`), and it saves on every change.

| Setting | Default | Line | Edited in |
|---|---|---|---|
| `tubeLength` | 20 m | `:17` | `SettingsView.vue:79-88` |
| `inputPressure` (min. inlet pressure at a booster pump) | 1.5 bar | `:18` | `SupplyPipeCalculation.vue` |
| `outputPressure` (pump outlet pressure) | 8 bar | `:21` | `SupplyPipeCalculation.vue` |
| `pressureLost` (friction per 100 m) | 1.0 bar | `:22` | `SupplyPipeCalculation.vue` (flow select) |
| `targetPressure` (nozzle) | 5 bar | `:26` | `SupplyPipeCalculation.vue` |
| `tubeDiameter` | 75 mm | `:29` | `SettingsView.vue:90-99` |
| `hoseName` | `B` | `:30` | `SettingsView.vue:101-110` |

How the line starts:

- The source pressure is the hydrant's `fire_hydrant:pressure` when the water
  source is a pressurised hydrant (`parseHydrantPressure`,
  `pumpCalculation.ts:493-498`; `sourcePressure`, `:490`).
- Otherwise the line starts at `outputPressure`
  (`calculatePumpPosition.ts:55`).

**No hose pressure rating exists.**

**New setting.** `maxHosePressure`:

- default **16 bar**;
- Preferences key `pumpCalc_maxHosePressure`;
- stored in the same store and edited in the pump-calculation section of
  `SettingsView.vue` (`:74-110`), next to hose length, diameter and name;
- i18n `settings.pumpCalculation.maxHosePressure`: en "Max. hose working
  pressure (bar)", de "Max. Betriebsdruck der Schläuche (bar)".

16 bar is the working pressure of pressure hoses under DIN 14811 (test
pressure 24 bar). The owner confirmed it as the default.

**Rule.** This is static pressure, with no flow. A closed branch is the worst
case.

```
p_static(lowest) = p_source + 0.1 bar/m × (h_source − h_min)
caution  when p_static ≥ 0.75 × maxHosePressure   (12 bar with the default)
warning  when p_static ≥ 1.00 × maxHosePressure   (16 bar) → "not recommended"
```

The inputs:

- **`p_source`:** the hydrant's mapped pressure for a pressurised hydrant (same
  `parseHydrantPressure`, moved to the new pure `src/helper/hosePressure.ts`);
  otherwise `outputPressure`, default 8 bar, for the pump at the source. No new
  default is invented.
- **`h_source`:** the height at the water-source end of the line. For nearby
  routes that is the route's target. For the pump line it is the suction point.
- **`h_min`:** the lowest height on the line downstream of the source.
- **Pump line with booster pumps:** each stretch is evaluated from its pump,
  with the pressure the pump calculation assigns there.

Heights come from the same resampled profile as the steep display
(`routeProfile.ts`).

**What this means in metres of drop below the source:**

| Source | `p_source` | Caution (12 bar) from | Warning (16 bar) from |
|---|---|---|---|
| pump at the source (`outputPressure` default) | 8 bar | 40 m | 80 m |
| hydrant, 6 bar mapped | 6 bar | 60 m | 100 m |
| hydrant, 4 bar mapped | 4 bar | 80 m | 120 m |

In general, drop = (threshold − `p_source`) / 0.1 bar/m.

**Check against Innsbruck** (scene 5).

- The four positions with the vehicle below the hydrant drop 177–220 m. That is
  17.7–22 bar from height alone.
- Even with `p_source = 0` this is ≥ 16 bar, so it gives a **warning**.
- With the 8 bar default it is 25.7–30 bar.

**Uphill lines** are already handled. The pump/relay calculation subtracts the
height gain and friction and places booster pumps
(`calculatePumpPosition.ts:69-81` and the placement loop after it). The pressure
rule adds nothing for uphill lines; the label only shows the signed height
difference.

**Display**

- `caution`: an amber chip, "Druck prüfen".
- `warning`: the "not recommended" chip (§6.8). The two slope-based triggers
  are unchanged.

### 6.14 Tests and fixtures

**Runner: vitest** (decided). The exact config is in phase 0.

- Spec files sit **next to** the source: `src/mapHandler/gridRouting.ts` →
  `src/mapHandler/gridRouting.spec.ts`.
- Scene specs over fixtures are named `*.scenes.spec.ts`.
- Environment: Node.
- Shared test-only helpers live in `src/testing/`, which app code may not
  import (eslint rule, phase 0).

**Testable without the app shell.** Modules under test import only pure
modules. I/O goes through injected fetchers (§6.2). Scene specs that drive
`nearbyRouting.ts` before phase 2 mock `@/offline/offlineProtocol` with
`vi.mock`, so `maplibre-gl` and the Capacitor tile store are never loaded.

**DEM in Node.** `createImageBitmap` and canvas are missing in Node, so specs
decode the WebP fixtures with a WASM decoder dev dependency. `@jsquash/webp` **works** (tried in phase 0, 14 ms per tile),
with one catch: its package entry also loads the encoder, which pulls
`wasm-feature-detect` 1.10 (uses `import.source`, a syntax error on Node 22).
`src/testing/routingFixtures.ts` therefore imports `@jsquash/webp/decode.js`
directly and passes the WASM from disk to `init`. It feeds the pure `terrariumToElevations`. If
that does not work, the fetch script stores the DEM fixtures re-encoded as
lossless PNG, decoded with `pngjs`, at a larger size.

**Fixtures: committed as test data** (proposal; one item is OPEN, below).

```
src/mapHandler/__fixtures__/routing/
  README.md
  1-rural-pond/scene.json
  1-rural-pond/basemap/15/<x>/<y>.mvt
  1-rural-pond/dem/14/<x>/<y>.webp
  1-rural-pond/dem/12/<x>/<y>.webp      (scenes 1 and 5 only, for the z12 fallback)
  2-melk/…  3-persenbeug/…  4-vienna/…  5-innsbruck/…
```

**Why this location.**

- It sits next to the routing code its specs test.
- Vite bundles only modules reachable from `src/main.ts`, and specs read
  fixtures with `node:fs` relative to `import.meta.url` (never `import`). So
  the tiles never become modules and never reach `dist/`.
- `public/` is the only folder copied verbatim; fixtures must never go there.
- Capacitor copies only `dist` (`capacitor.config.ts:6`), so the files stay out
  of the native assets.
- Safeguards:
  - the eslint `no-restricted-imports` rule;
  - the phase-0 check that `dist/` has no `__fixtures__` path.
- A top-level `test/fixtures/` would work just as well. It was not chosen,
  only to stay consistent with specs alongside the source.

**`scene.json`** holds:

- the anchor;
- named cases (origin and target, e.g. `pond`, `hydrantEast`, `north500`);
- the ring positions **already moved to the nearest road** as in the research,
  so tests do not depend on that rule;
- the pond outline as GeoJSON (scene 1);
- the tile lists;
- the fetch date.

Expected values live in the spec files as tolerant ranges, not in the JSON.

**Contents and size.** Only what tests need:

| Scene | Basemap z15 | Basemap bytes | DEM z14 tiles | DEM z12 |
|---|---|---|---|---|
| 1 | ±700 m: x 17772–17774, y 11371–11373 | 131 kB (MEASURED) | x 8886–8887, y 5685–5686 (4) | 2221/1421 |
| 2 | ±700 m: x 17779–17780, y 11359–11361 | 184 kB (MEASURED) | x 8889–8890, y 5679–5680 (4) | — |
| 3 | ±700 m: x 17756–17757, y 11363–11365 | 120 kB (MEASURED) | x 8878, y 5681–5682 (2) | — |
| 4 | **cropped to ±500 m**: x 17873–17874, y 11362–11363 (4 instead of 9) | ≈ 0.7 MB (ESTIMATE: 4/9 of the measured 1,598 kB) | x 8936–8937, y 5680–5681 (4) | — |
| 5 | ±700 m: x 17418–17419, y 11491–11493 | 151 kB (MEASURED) | x 8709, y 5745–5746 (2) | 2177/1436 |

The DEM and cropped ranges were computed for this plan.

| Part | Size |
|---|---|
| basemap | ≈ 1.3 MB |
| DEM z14, 16 tiles × ~68 kB | ≈ 1.1 MB |
| DEM z12, 2 tiles | ESTIMATE ~0.2 MB |
| JSON | < 0.1 MB |
| **total** | **≈ 2.6–2.8 MB** |

Because of the crop, scene-4 specs use the 150 m and 300 m rings only (32
positions). The 500 m figures stay in §5 as the research record.

**README in the fixtures folder.** It records:

- the source URLs (without the key);
- the fetch date and the tile ranges;
- the regeneration command;
- attribution: "© OpenStreetMap contributors, ODbL. Vector tiles: Protomaps.
  Terrain: Mapterhorn (per-source attribution at mapterhorn.com/attribution)";
- that the files are test data, not app assets.

**Regeneration.** Run `node scripts/fetch-routing-fixtures.mjs [--scene <id>]`.

- The key comes from `VITE_PROTOMAPS_API_KEY` in the environment and is never
  written to a file.
- Re-fetching will change the data slightly over time, which is why the specs
  use ranges.
- **This plan document, not the fixtures, is the record of the research.** The
  fixtures are a test snapshot.

**OPEN: redistribution terms.** It is not yet confirmed that Protomaps' terms
allow redistributing these few tiles in a public repository. Check Mapterhorn's
per-source licences at the same time.

Until both are confirmed:

- the tile files are gitignored (`src/mapHandler/__fixtures__/routing/**/*.mvt`,
  `**/*.webp`); the README and the `scene.json` files are committed;
- every `*.scenes.spec.ts` is wrapped in `describe.skipIf(!fixturesPresent)`;
- unit specs always run;
- developers fetch the fixtures locally with the script.

**What stays manual, and why.**

- Map rendering: MapLibre layers, dashes, colours, ticks and label placement.
  This needs WebGL and visual judgement.
- The worker on a device: Capacitor WebViews, `OffscreenCanvas` availability,
  real timings.
- Precache behaviour: network type, `saveData`, IndexedDB quotas on iOS, and
  timing while moving.
- Settings and panel UI flows.

The repo's `verify` skill (headless app run) can cover parts of the UI checks.

## 7. Phases

Each phase is a separate, mergeable PR, and the order matters. What's New
entries follow AGENTS.md §6. If an `unreleased` entry for the same feature
already exists, update it instead of adding a new one. English texts are given
below; each entry also needs its German text.

**Acceptance is by spec files.** From phase 0 on, every phase lists the spec
files it adds or changes and the cases they must contain. Scene numbers are
written as tolerant ranges (§6.14). A phase is done when `npm test` is green in
CI and the listed manual checks are done. The debug view is for tuning, not for
acceptance.

### Phase 0: test runner, fixtures, debug view

**Files**

| File | Status |
|---|---|
| `package.json`, `package-lock.json` | changed: `vitest` dev dependency; `test`, `test:watch` and `typecheck` scripts |
| `vitest.config.ts` | new |
| `tsconfig.node.json` | changed: `include` gets `vitest.config.ts` |
| `eslint.config.mjs` | changed: fixture/vitest import guard |
| `.prettierignore` | changed: `src/**/__fixtures__/` |
| `.github/workflows/ci.yml` | new |
| `.github/workflows/release.yml` | changed: test step in `prepare` |
| `AGENTS.md` | changed (**required**): §7 and related places |
| `CLAUDE.md` | changed: it repeats "no test suite" |
| `src/composable/modalBreakpointWatcher.ts`, `src/views/SettingsView.vue` | changed: fix the two existing type errors so `typecheck` is green |
| `scripts/fetch-routing-fixtures.mjs` | new |
| `src/mapHandler/__fixtures__/routing/**` | new: README, `scene.json` per scene, tiles |
| `src/testing/routingFixtures.ts` | new: test-only helpers |
| `src/views/RoutingDebugView.vue`, `src/router/index.ts` | new / changed |

**Runner and config.** These are the exact changes. They were tried in a scratch
copy of `558308a` (Node 22, vitest 5.1.0). In that trial:

- a sample `src/helper/areaShore.spec.ts` ran green;
- `eslint` passed on the spec and on `vitest.config.ts`;
- `vue-tsc` type-checked the spec, including its `vitest` import, with no new
  errors;
- `vite build` contained no spec code.

- `package.json`:
  - `devDependencies`: `"vitest": "^5.1.0"`. In the trial, 5.1.0 resolved
    against the repo's `vite` 7.3.6.
  - `scripts`:

    ```json
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "vue-tsc --noEmit --skipLibCheck --composite false -p tsconfig.json"
    ```

    **Implemented with `--composite false`:** `tsconfig.json` sets `composite: true`,
    and once the two errors below are fixed, `vue-tsc` then reports ten
    declaration-emit errors (TS2742/TS4058/TS4094/TS7056 in
    `pumpCalculation.ts` and `pumpCalculationSettings.ts`, about inferred types
    from `maplibre-gl`). They are masked while other errors exist. `--noEmit`
    does not need declaration output, so the flag removes them without touching
    app code.

    `vue-tsc` is already a dev dependency, but no script runs it today, and
    `vite build` does not type-check.
- `vitest.config.ts` is kept separate from `vite.config.ts`, so tests do not load
  VitePWA or ViteFonts:

  ```ts
  import { defineConfig } from 'vitest/config';
  import { fileURLToPath, URL } from 'node:url';

  export default defineConfig({
  	resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  	test: { include: ['src/**/*.spec.ts'], environment: 'node' }
  });
  ```

- `tsconfig.json` needs **no change**:
  - `include: ["src/**/*.ts", …]` already type-checks `*.spec.ts`;
  - specs import `describe`, `it`, `expect` and `vi` from `'vitest'`
    explicitly, so no `vitest/globals` type entry is needed;
  - `types: ["node"]` already covers `node:fs` in fixture loaders.
- `tsconfig.node.json`: add `vitest.config.ts` to `include` (today only
  `vite.config.ts`).
- `vite.config.ts` needs **no change**:
  - the production build only bundles modules reachable from `src/main.ts`, so
    spec files, `src/testing/` and `__fixtures__/` never enter `dist/`;
  - Capacitor copies only `webDir: 'dist'` (`capacitor.config.ts:6`);
  - the Workbox precache globs run over `dist/`.

  In the trial, `vite build` contained no spec content.
- `eslint.config.mjs`: linting needs no change. `**/*.{js,mjs,cjs,ts,tsx}`
  already matches `*.spec.ts` and `vitest.config.ts`, and in the trial
  `eslint` passed on both. Add one config object that keeps app code from
  importing test material:

  ```js
  {
  	files: ['src/**/*.{ts,vue}'],
  	ignores: ['src/**/*.spec.ts', 'src/testing/**'],
  	rules: {
  		'no-restricted-imports': ['error', { patterns: ['**/__fixtures__/**', '@/testing/*', 'vitest'] }]
  	}
  }
  ```

- `.prettierignore`: add `src/**/__fixtures__/`, so lint-staged does not
  reformat the fixture JSON.
- **Type errors today.** With `vue-tsc --noEmit --skipLibCheck`, `558308a`
  reports two errors (MEASURED with vue-tsc 3.2.5):
  - `src/composable/modalBreakpointWatcher.ts:12` (`$el` on an Ionic component
    ref);
  - `src/views/SettingsView.vue:146` (`fill="primary"` on a button).

  Phase 0 fixes both. Without `--skipLibCheck`, four more errors come from
  `node_modules` typings.

**CI.** Today no workflow runs on pull requests. `main.yml` only builds on a
release or by hand, and `dev-builds.yml` builds native apps on pushes to
`main`. Proposed changes:

- New `.github/workflows/ci.yml`. It reuses the action SHAs already pinned in
  `main.yml`:

  ```yaml
  name: CI
  on:
    pull_request:
    push:
      branches: [main]
  permissions:
    contents: read
  jobs:
    check:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
          with:
            persist-credentials: false
        - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
          with:
            node-version: 22
            cache: 'npm'
        - run: npm ci --ignore-scripts
        - run: npx eslint .
        - run: npm run typecheck
        - run: npm test
  ```

- `release.yml`, `prepare` job: add a `Test` step (`run: npm test`) right
  after "Install dependencies". A red test then stops the release before
  anything is tagged. `main.yml` runs in parallel with the native builds, so it
  is not a useful gate.
- Cloudflare Pages previews do not run tests. That is acceptable, because
  `ci.yml` covers the PR.

**AGENTS.md: required change, in this phase.**

- §7: replace "No test suite exists…" with:
  - unit tests run with vitest via `npm test`;
  - spec files sit next to the source (`foo.ts` → `foo.spec.ts`) in the Node
    environment, for pure modules;
  - routing scene fixtures live in `src/mapHandler/__fixtures__/routing/`
    (README there) and must never be imported from app code;
  - run `npm test` (and `npm run typecheck`) before committing changes to
    tested modules.
- Also add `npm test` / `npm run typecheck` to §4, Vitest to §2 "Code Quality",
  and `ci.yml` to the §3 workflow table.
- `CLAUDE.md` mentions "§7's note that there is no test suite"; update that
  sentence too.

**Fixtures.** See §6.14 for layout, sizes, README and licence. The fetch script:

- reads the Protomaps key from `VITE_PROTOMAPS_API_KEY` in the environment;
  **the key is never written to a file**;
- fetches exactly the tiles listed in each `scene.json`;
- prints the total size.

**Debug view.** A tuning tool, not the acceptance mechanism.

- Route `/debug/routing`, registered only when `import.meta.env.DEV` or
  `VITE_ROUTING_DEBUG=1`.
- It has a scene picker and draggable origin and target.
- It draws every mode that exists at that point:
  - phases 0–2: road and terrain;
  - phases 3–4: also `optimized`;
  - from phase 5: `optimized` and `roads`.

  Each mode shows its length, timing and coverage.
- It overlays the cost raster (canvas → MapLibre `image` source).
- It runs the §5 ring simulation and prints the ratio table.
- In `npm run dev` it can read the fixtures through the dev server's `/src/…`
  paths (INFERRED); preview builds use live tiles.

**Specs**

- `src/testing/routingFixtures.ts` (helper, not a spec): `loadScene(id)`,
  `fixtureFetcher(scene)` (a `TileFetcher` reading `node:fs`), and
  `fixturesPresent`.
- Phase 0 also added `src/mapHandler/routingDebug.ts` (+ spec): pure helpers
  of the debug view. The debug view reads the app's live/offline tile pipeline,
  not the fixture tiles (that needs the injectable fetchers of phase 2). It
  loads `scene.json` files through `import.meta.glob`.
- `src/testing/routingFixtures.spec.ts`:
  - every tile listed in each `scene.json` exists and decodes (MVT layers
    present; DEM decodes to 512×512);
  - the total fixture size is ≤ 3.5 MB;
  - like all fixture-driven specs, it is skipped when `!fixturesPresent`.
- `src/helper/areaShore.spec.ts`:
  - `nearestPointOnOutline` on a square, a multipolygon and open member lines;
  - `isInsideOutline` with a hole;
  - `distanceToOutline` is 0 inside.
- `src/mapHandler/roadRouting.spec.ts` (synthetic lines):
  - nodes merge within 2 m but not at 3 m;
  - T-junction repair joins a side street that ends mid-segment within 6 m;
  - no route when nothing lies within 100 m;
  - `meters` equals the length of the `routePath` polyline.
- `src/mapHandler/gridRouting.spec.ts` (synthetic, characterising today):
  - building cells cost 30 and fringe cells 4;
  - one `it.fails` case documents the known defect: a smoothed segment from the
    true endpoint crosses an L-shaped building. Phase 1 turns it into a passing
    `it`.
- `src/mapHandler/nearbyRouting.scenes.spec.ts`:
  - uses `vi.mock('@/offline/offlineProtocol', …)` to serve the fixture
    fetcher, so `maplibre-gl` and the Capacitor tile store are never loaded;
  - the whole file is skipped when `!fixturesPresent`;
  - baseline cases:

    | Case | Expected |
    |---|---|
    | scene 1 pond, road | 1,600–1,850 m |
    | scene 1 pond, terrain | 680–740 m (measured 708 m; the screenshot's 528 m cannot be reproduced: the shore is 645 m from the research vehicle) |
    | scene 1 hydrant node 4477703437 (300 m), road | 430–490 m (measured 462 m) |
    | scene 1 hydrant node 4477703437 (300 m), terrain | 350–410 m (measured 381 m); the screenshot's 295 m / 232 m used an unrecorded vehicle position |
    | scene 2 ring medians at 150 / 300 m | within ±10 % of §5 |

**Manual:** `npm run build`, then check that `dist/` contains no `__fixtures__`
path and that its size is unchanged against `main`.

**What's New:** none (tooling only).

### Phase 1: fixes without new data, steep and pressure warnings for the existing modes

**Files**

- `gridRouting.ts`, `nearbyRouting.ts`, `roadRouting.ts`, `obstacleGeometry.ts`
- `waterSourceAccess.ts`, `markerHandler.ts`
- `demElevation.ts` plus new pure `src/helper/demRaster.ts`
- `offline/tileMath.ts`
- new `src/helper/polygonGeometry.ts` (exact segment/polygon tests)
- new `src/helper/routeProfile.ts`
- new `src/helper/hosePressure.ts`
- `src/store/pumpCalculationSettings.ts` (`maxHosePressure`)
- `SettingsView.vue`
- `MainMap.vue`, `pumpCalculation.ts`, `NearbyMarker.vue`, `SupplyPipeCalculation.vue`
- `src/locales/{en,de}.json`
- the spec files below

**Changes**

1. **Exact building test and true endpoints.** Smoothing starts from the true
   origin and target. `exactLineOfSight` becomes a segment/edge intersection
   test (§6.6), via `segmentIntersectsPolygon` in `polygonGeometry.ts`.
2. **One length.** `computeNearbyDistances` returns the length of the
   **smoothed polyline** per target. Road mode already does (§3.2); terrain
   mode needs path reconstruction and smoothing per reached target, ≤ 30. Label,
   list and pump calculation then agree exactly. If smoothing 30 targets is
   measured too slow, smooth the top 10 and show the rest with "≈".
3. **Surface fallbacks** (§6.11). This covers the grid → road downgrade
   (`nearbyRouting.ts:216-221`), the tile cap (`obstacleGeometry.ts:54-59`),
   > 3 km (`:211`) and "no road within 100 m".
4. **Missing vs empty** (§6.9). Do not cache missing tiles. Add
   `coverage.basemap`. `getObstaclesForBounds` takes an optional injected
   `TileFetcher`.
5. **Pond shore chosen by routing.**
   - `resolveAccessPoint` returns
     `AccessTarget = { kind: 'point'; point } | { kind: 'shore'; outline; fallback: GeoPoint }`.
   - Add `sampleShore(outline, stepM)` in `areaShore.ts`.
   - Grid mode: shore cells as targets (§6.5).
   - Road mode: shore samples every 20 m and `POND_SHORE_SNAP_M = 250`.
6. **Remove the Overpass wait from routing.**
   - `resolveAccessPoint` stops awaiting `getAreaOutline`; it starts it in the
     background.
   - `getNearbyMarkers` no longer awaits `preloadPondOutlines`
     (`markerHandler.ts:672-674`); it fires and forgets.
   - Add the Protomaps water polygon under the marker as the second outline
     source.
   - `OUTLINE_WAIT_MS` stays only if a non-routing caller still needs it.
7. **Early exit and memoisation** in `solveTerrain` (§6.5). Stop re-solving in
   `gridRoutePath`.
8. **Steep display and warnings for the modes that exist now** (road graph and
   terrain grid; §6.8, §6.13).
   - Move the pure terrarium decode and the cross-tile bilinear sampling into
     `demRaster.ts`. `demElevation.ts` keeps the image decode and fetching.
   - Add `sampleElevationsBlended(points, zoom)`.
   - Add `TERRAIN_ROUTING_ZOOM = 14`. Try z14 within the budget, else fall back
     to z12 (amber only).
   - Fix the comment at `demElevation.ts:14`.
   - Raise the DEM LRU to 16 tiles (ESTIMATE: 16 MB).
   - New setting `maxHosePressure` (default 16 bar) and the pressure rule
     (§6.13). Move `parseHydrantPressure` from `pumpCalculation.ts:493-498` to
     `hosePressure.ts`.

These terrain-mode fixes are not throw-away work. Endpoint handling, exact
building tests, shore goals, early exit and memoisation carry over into the
single cost grid that remains after phase 5.

**Specs**

- `src/helper/polygonGeometry.spec.ts`. `segmentIntersectsPolygon` cases:
  - crossing an edge;
  - touching a vertex;
  - running along an edge;
  - fully inside;
  - inside a hole (no hit);
  - bbox prefilter rejection.
- `src/mapHandler/gridRouting.spec.ts`:
  - the phase-0 `it.fails` case now passes;
  - property test: 200 seeded random building layouts × endpoints, and no
    output segment of `pathTo` intersects any building edge;
  - the early-exit solve equals the full solve for the queried targets;
  - a second query from the same origin cell reuses the memoised solve (spy
    counts one solve);
  - reported `meters` equals the polyline length (±0.01 m).
- `src/mapHandler/obstacleGeometry.spec.ts`:
  - a fetcher returning `null` gives a `missing` status and the tile is not
    cached; once the fetcher returns bytes, the tile decodes;
  - more than 32 tiles sets `coverage.truncated`.
- `src/mapHandler/waterSourceAccess.spec.ts`:
  - a suction point within 30 m is the only goal; one at 31 m is not;
  - outline source order is extract → water polygon under the marker → point;
  - with `getAreaOutline` mocked to never resolve, `resolveAccessPoint`
    resolves at once (fake timers).
- `src/helper/areaShore.spec.ts` (extended), `sampleShore`:
  - spacing ≤ 20 m;
  - a pond under 20 m perimeter still yields ≥ 3 samples;
  - multipolygon members are sampled.
- `src/mapHandler/roadRouting.spec.ts` (extended): with shore targets, a 250 m
  final leg is used when it is the cheapest arrival.
- `src/helper/demRaster.spec.ts`:
  - terrarium decode of known RGB triplets;
  - a plane spread over 4 synthetic tiles is reproduced exactly at tile edges
    (no clamping seam).
- `src/helper/routeProfile.spec.ts`:

  | Profile | Expected |
  |---|---|
  | 40 m at 30 % | one amber run |
  | 8 m at 55 % | no red (below the 10 m minimum) |
  | 12 m at 55 % | red run + "not recommended" |
  | 60 m at 26 % | "not recommended" |
  | 45 m at 26 % | no chip |
  | z12-only input at 70 % | amber, never red |
  | off-road | runs from `isNearAnyRoad` (6 m) |
  | short runs | adjacent same-class runs merge |
- `src/helper/hosePressure.spec.ts`:
  - `parseHydrantPressure`: `'6'` → 6, `'suction'` → null, `'0'` → null,
    absent → null;
  - the §6.13 threshold table, exact at its edges: pump 8 bar → 39 m ok,
    40 m caution, 80 m warning; hydrant 4 bar → 80 m / 120 m;
  - an uphill-only profile → `ok` (no rule applies);
  - the lowest point downstream of the source is used, not the end point.
- `src/mapHandler/nearbyRouting.scenes.spec.ts` (updated):

  | Case | Expected |
  |---|---|
  | scene 1 pond, road | 750–900 m; ends within 1 m of the outline |
  | scene 1 hydrant, terrain | 0 building-edge intersections; 300–430 m (see the notes below) |
  | all scenes, every ring target | list metres = polyline metres (±0.5 m) |
  | scene 5 "500 m north", terrain | red run and "not recommended" |
  | scene 5 "500 m north", terrain | pressure `warning` (drop 177–220 m) |

**Implemented (phase 1 notes).** Where the code differs from the text above:

- Scene 1 numbers (research vehicle 48.1300, 15.2725): pond road 790 m (range
  750–900, via the farm track), pond terrain 680 m (range 645–720, was 708 m as
  a cell chain), hydrant road 462 m (unchanged), hydrant terrain 403 m with 0
  building-edge intersections. The hydrant terrain range is **300–430 m**, not
  232–295 m: the straight line alone is 300 m from this vehicle position. It
  grew from 381 m because the line no longer squeezes past walls (next point).
- Grid: fringe cells are now found exactly (cell sides against the outline),
  and a step whose centre-to-centre segment touches a footprint is priced like a
  building cell (×30). Without this, the cell chain itself could clip a corner
  where smoothing has to fall back to single steps, and the "no segment touches
  a building" property could not hold.
- Smoothing is the greedy string pulling with the exact test; the extra
  Douglas–Peucker pass is not needed (the pulled line has no redundant
  vertices) and was left out.
- Road mode with shore samples attaches each sample to **every** road within
  250 m (the three cheapest by network cost + straight leg are priced), not to
  the nearest edge per component: the farm track and the cycleway are one
  component, so per-component snapping never reached the track.
- A late Overpass outline is passed to the caller through an
  `onOutlineArrived` callback of `resolveAccessPoint` (silent redraw, no refit);
  the `routingData.ts` event target stays with phase 7. The Protomaps water
  polygon lookup waits at most 1.5 s; the z14 DEM attempt has its own 1.5 s
  budget before z12.
- The pump panel shows every distance along the drawn 2D line (the 3D-based
  pump placement is mapped onto it), so panel, label and list show one number.
- Not in phase 1: the "fences unknown" chip and the one-time cross-country
  note (they belong to `optimized`, phase 5).

**Manual** (needs a real browser):

- Steep layers and chips render correctly on the map.
- With Overpass blocked in DevTools, the path appears within ~1.5 s.
- The `maxHosePressure` input persists across an app reload.

**What's New**

- `fix`: "Hose routes to a hydrant no longer cut through buildings, and the
  list and map show the same length."
- `fix`: "Routes to fire water ponds now end at the best reachable shore point."
- `improvement`: "Steep stretches of a hose route are highlighted, with a
  warning when the route is not recommended."
- `feature`: "Set the maximum working pressure of your hoses; long downhill
  lines warn when it could be exceeded."

### Phase 2: decode the extra tile layers and add the cost model (no behaviour change)

**Files**

- `src/types/obstacles.ts`
- new pure `src/mapHandler/obstacleDecode.ts`, split out of
  `obstacleGeometry.ts` (§6.2)
- new `src/mapHandler/hoseCostModel.ts`
- `RoutingDebugView.vue`, to show the classes
- the spec files below

**Changes**

- Extend the decoder (§6.2). `roads` keeps excluding rail and ferry and now also
  `path/corridor`; rail goes to `rails`.
- Add the cost-model module with classifiers, class factors and `slopeFactor`
  (§6.3, §6.4). It is not used for routing yet.
- In the debug view, list unknown landuse kinds seen per scene.

**Specs**

- `src/mapHandler/hoseCostModel.spec.ts`:
  - one case per row of the §6.3 class table (kind / kind_detail / flags →
    class and factor);
  - heavy rail blocks only for {rail, light_rail, narrow_gauge} on the
    surface. Tram, subway, disused, `is_tunnel` and `is_bridge` do not block;
  - a motorway on a bridge or in a tunnel does not block;
  - `ferry` and `path/corridor` are excluded;
  - an unknown landuse kind maps to `UNKNOWN_OPEN`;
  - every factor is ≥ 1.0;
  - `slopeFactor` curve points: 0 → 1.0, 0.08 → 1.0, 0.25 → 1.7, 0.5 → 4.0,
    0.8 → 8.0, 1.0 → 12, 1.5 → 12;
  - `slopeFactor` is monotonic and symmetric in the sign of the grade;
  - the road, path and steps cap is 1.3 at any grade; on a bridge it is 1.0.
- `src/mapHandler/obstacleDecode.spec.ts` (fixtures):
  - scene 4: every `kind=rail` feature is tram, subway or disused;
  - scene 2: surface `kind_detail=rail` features exist and tunnel pieces
    carry `isTunnel`;
  - scene 3: a water polygon contains a point in the Danube;
  - scene 1: farmland is the largest landuse class in the window;
  - `kind=cliff` lines decode from `earth` where present;
  - `is_bridge` and `is_tunnel` are parsed as booleans.
- `src/mapHandler/nearbyRouting.scenes.spec.ts`: road and terrain lengths
  equal the phase-1 values (stored as an inline snapshot rounded to 1 m). The
  only allowed difference is a listed set of scene-4 cases affected by
  removing `path/corridor`.

**Implemented (phase 2 notes).** Where the code differs from the text above:

- `path/corridor` stays in `roads` for now. Dropping it in the decoder moved two
  scene-4 road-mode ring cases (487 to 483 m and 569 to 565 m), and phase 2 must not change
  any route. `classifyRoad` already returns `'excluded'` for it, as it does for
  tunnelled `kind=path` and `access=military`; **phase 3 filters `roads` with
  `classifyRoad` when it builds the graph and the grid**, which is where the scene-4 change
  then lands (the lengths are pinned in `nearbyRouting.scenes.spec.ts`, "lengths as after
  phase 1": 5 scenes x road/terrain x every ring and case, rounded to 1 m, unchanged).
- `ObstacleData.water` is now `waterAreas: WaterPolygon[]`, where `WaterPolygon`
  extends `AreaPolygon` with the `tile` id the outline merge needs. `RoadLine` also has
  `access` (optional), needed for the military rule. `LinearFeature` is also what rails,
  water lines and cliffs use.
- Coverage: `BasemapCoverage` keeps its phase-1 shape and gains
  `layers: Record<'buildings'|'roads'|'landuse'|'water'|'earth', { tiles, features }>`
  (tiles of the decoded ones that had the layer, and raw features read). Protomaps omits
  empty layers, so `tiles` below the decoded count is normal. `TileCoverage` from the sketch
  was not needed.
- Water lines carry the water kind in `kind` (`river`, `stream`, `drain`), not in
  `kind_detail` as §4.1 says; `classifyWaterLine(kind, kindDetail)` reads both. `kind_detail`
  of a water polygon (`lake`, `river`, `basin`) is not used. Water points (fountains)
  are dropped.
- `hoseCostModel.ts` also exports `classifyRail`, `classifyWaterArea`, `CELL_CLASS`
  (stable numeric ids), `CLASS_FACTOR`, `isPassable`, `isOnRoadClass`, the landuse and water
  tables, `BUILDING_CORE_ESCAPE_FACTOR` (30) and `ESCAPE_RADIUS_M` (12). A classifier
  returns a class, `'excluded'` (not in graph or grid) or `'none'` (draws nothing, blocks
  nothing: tram, subway, bridged or tunnelled heavy rail, bridged or tunnelled motorway).
  `path/*` details other than the §6.3 list (`bridleway`, `pier`) are `PATH`. A bridged
  `path/steps` is `BRIDGE`. `slopeFactor(grade, cellClass?)` takes the class that governs the step.
  The warning thresholds are re-exported as `WARNING_THRESHOLDS` from the constants that
  `routeProfile.ts` and `hosePressure.ts` already own, so there is one value each.
- Landuse kinds seen in the scenes without a factor yet (`UNTUNED_LANDUSE_KINDS`, priced
  `UNKNOWN_OPEN`): dam, dog_park, grassland, hospital, kindergarten, pier, platform,
  playground, sand, school, university. Biggest by area: hospital, university, school.
- Debug view: `classSummary` (in `routingDebug.ts`) sums area per class for landuse and
  water, length per class for roads, rail, water lines and cliffs, and lists unknown
  landuse kinds (new ones marked NEW). The view shows it for the window around the
  markers.
- Specs: `hoseCostModel.spec.ts` (92), `obstacleDecode.spec.ts` (19),
  `hoseCostModel.scenes.spec.ts` (9, fixtures: every road/rail/landuse/water kind
  seen must be listed in the spec's tables), plus the lengths snapshot above. The test MVT
  encoder now writes boolean property values.

**Manual:** none.

**What's New:** none.

### Phase 3: optimized mode in the grid (no slope), settings enum, behind a dev flag

**Files**

- `gridRouting.ts`, possibly split out as `costGrid.ts`
- new `src/mapHandler/cellHeap.ts`
- `nearbyRouting.ts`, `roadRouting.ts`
- new `src/helper/hoseRoutingSetting.ts`
- `settingsStore.ts`, `composable/settings.ts`, `SettingsView.vue`
- `markerHandler.ts`, `MainMap.vue`, `pumpCalculation.ts`
- `src/locales/{en,de}.json`: the dev preview item
- the spec files below

**Changes**

- Add the classes and rasterisation order (§6.3), the escape radius, and
  scanline fill.
- Goal sets and A* (§6.5).
- Cost-aware smoothing (§6.6).
- Settings enum and migration, phases 3–4 column (§6.7):
  - type `'optimized' | 'roads' | 'direct'`;
  - effective default `direct`;
  - the production toggle maps on → `roads`, off → `direct`;
  - the preview item appears only with `VITE_HOSE_ROUTING_OPTIMIZED=1` or in
    dev, so Cloudflare previews can enable it.
- Road mode: price the final leg with the cost model; this is the "light"
  variant from §6.1.

**Specs**

- `src/mapHandler/cellHeap.spec.ts`:
  - 10,000 seeded random pushes pop in non-decreasing order;
  - the heap grows past its initial capacity;
  - equal keys are handled.
- `src/mapHandler/costGrid.spec.ts` (or `gridRouting.spec.ts`):
  - scanline fill of a square, a concave polygon and a polygon with a hole
    gives exactly the cells whose centre a reference point-in-polygon test
    puts inside;
  - fringe = edge-touched cells minus filled cells;
  - order: a road drawn over heavy rail leaves the crossing cell passable;
  - order: a nested smaller landuse polygon wins;
  - bridged rail is not drawn;
  - escape radius: a core cell 11 m from an endpoint is finite (30); at 13 m
    it is blocked.
- `src/mapHandler/gridRouting.spec.ts`:
  - symmetry: on 100 seeded random grids, cost A→B = cost B→A (±1e-9);
  - A* cost = Dijkstra cost on the same 100 cases (admissibility);
  - goal set: the returned goal is the minimum-cost goal cell;
  - the endpoint equals `nearestPointOnOutline` of that cell;
  - a suction point within 30 m overrides the goal set;
  - cost-aware smoothing: the property test (no building-edge intersection,
    no blocked cell) passes;
  - smoothed cost ≤ unsmoothed cost × 1.02 + 2 m;
  - Douglas–Peucker never removes a vertex whose removal would break those
    tests.
- `src/helper/hoseRoutingSetting.spec.ts`: every row of the §6.7 migration
  table, phases 3–4 column, including "migrated value is not persisted" (the
  `shouldPersist` flag is false).
- `src/mapHandler/gridRouting.scenes.spec.ts` (`optimized`, fixtures,
  indicative targets):

  | Scene | Expected |
  |---|---|
  | 1, pond | 528–700 m; ends within 1 m of the outline; 0 building-edge intersections |
  | 1, hydrant | ≤ 295 m; 0 intersections |
  | 2, all 38 ring positions | 0 crossings of surface heavy rail outside road or bridge cells (the underpass ~155 m WNW counts as a road cell) |
  | 2, off-road | 5–11 positions notably off-road (research: 8) |
  | 3 | no route vertex or segment inside the Danube polygon |
  | 3, the 151 m / 797 m case | optimized < 0.8 × road |
  | 4, rings 150 / 300 m (32 positions) | removing all tram features leaves every length unchanged (±0.5 m) |
  | 4, ratio optimized / road | median 0.80–1.00 (research 0.86); every position 0.70–1.15 |
  | 4, off-road | 0 positions notably off-road |

**Implemented (phase 3 notes).** Where the code differs from the text above:

- Modules: `costGrid.ts` (pure rasteriser: scanline fill, supercover lines, the §6.3
  order, `routableRoads`), `cellHeap.ts` (typed heap with the old heap's sift rules, so
  the `direct` grid pops equal keys in the same order and its routes did not move), and
  `gridRouting.ts` serving both models (`direct` unchanged, `optimized` new). Cell size
  stays 8 m and the cap 250k (phase 6).
- Raster details the plan leaves open: paths and steps are drawn before roads (the cheaper
  class wins a shared cell); a building fringe never overwrites a `BLOCKED` cell (a house on
  the shore must not open the lake); a diagonal step may not cut the corner of an
  impassable cell, so 4-connected supercover walls (rail, rivers, cliffs) stay watertight.
  A step whose centre line touches a footprint is impassable (phase-1 rule, now with the
  escape factor 30 inside the escape zone instead of a plain ×30). The `BRIDGE` step rule
  waits for phase 4, which lists it with slope.
- Escape zone: every cell whose centre is within 12 m of an endpoint; a `BUILDING_CORE` in
  it costs 30, and the endpoint cell itself costs 30 whatever its class (a point on a
  blocked cell can still start or end). Other blocked cells stay blocked in the zone. The
  zone is fixed when a field is set up: the list's one-to-many Dijkstra includes every
  point target's zone, and a single path reuses that field (no A*) when its target is one
  of them, so list and line agree; otherwise A* runs with the two endpoints' zones. A route
  to one list target could pass another target's zone at ×30; accepted (rare, priced).
- Windows (§6.5): `optimized` uses bbox + max(150 m, 0.25 × the farthest straight
  distance) for list and line alike and re-solves once in a window ×1.5 larger when a
  route touches the edge (16 m) or a target is `gridUnreached`. Without this, Melk's north
  ring could not reach the underpass. `direct` and `roads` keep bbox + 150 m.
- Off-road for `optimized` (§6.8): a point is on road when its cell is `ROAD`/`PATH`/
  `STEPS`/`BRIDGE` **or** within the 6 m of a road line the other modes use. With 8 m cells
  the class alone marks every corner cut and every centreline near a cell edge as off-road
  (Melk: 32 instead of 15 notably off-road positions).
- Road mode: a pond's final shore leg is priced by `lineCost` over the cost grid (straight
  line, per-cell length × factor), with the pond's own cells within 12 m of the shore point
  priced as open ground; a leg through water, rail or a building is not used. Snap legs to
  points keep `effectiveDistanceMeters`. Scene 1 pond (road) is unchanged at 790 m.
- `routableRoads` (`classifyRoad` ≠ `excluded`) filters `roads` once per routing context,
  so the road graph, both grids, the weighted heuristic and the off-road test all lose
  ferries, `path/corridor`, tunnelled paths and military access. Scene 4 moves (the
  phase-2 note named the neighbouring values): road rings 483 → 479 m and 569 → 565 m
  (corridors), and the last 300 m ring 644 → 708 m in road mode and 581 → 598 m in terrain
  mode (tunnelled footways). Every other pinned length is unchanged.
- Settings: `settingsStore.hoseRouting` (default `direct`) replaces `clampHosesToRoads`
  (kept as a getter for the toggle) plus `hoseRoutingPreview`. `resolveHoseRouting`
  implements both columns of the table. `saveHoseRouting` writes `hose_routing` and keeps
  `clamp_hoses_to_roads` in step until phase 5, so a downgraded app still agrees on
  `roads`. The preview item: en "Optimized routing (preview)", de "Optimierte Route
  (Vorschau)". A mode change redraws the selected marker's line (`MainMap.vue`).
- Thin buildings (§6.11): the decoder records per tile `{ tileM2, residentialM2,
  buildingM2 }`; `coverage.thinBuildingTiles` counts flagged tiles
  (`isThinBuildingTile`). Only `optimized` acts on it (roads, `fallback: 'thinBuildings'`,
  `basemap: 'partial'`), so production is unchanged. No tile of the five scenes is
  flagged (residential tiles have building/residential ratios above 0.1). A poorly mapped
  sample is still OPEN.
- Smoothing: greedy cost-aware pulling plus the gated Douglas–Peucker (`simplifyGated`);
  as in phase 1 the pass rarely removes anything, because pulling already took the
  farthest valid vertex.
- Measured `optimized` numbers (no slope), against the table above:

  | Scene | Measured | Plan | Note |
  |---|---|---|---|
  | 1, pond | 687 m, on the outline, 0 contacts | 528–700 m | |
  | 1, hydrant | 454 m (road 462 m), 0 contacts | ≤ 295 m | the straight line from this vehicle is 300 m; spec: ≤ road mode |
  | 2, rail | 0 off-road crossings over 38 positions | 0 | crossings only at roads (≤ 8 m) |
  | 2, off-road | 15 of 38 | 5–11 | no slope: the stream, cutting and farmland south are crossed straight; phase 4 |
  | 3, Danube | 0 contacts | 0 | |
  | 3, 151/797 m | 151 m (0.19 × road) | < 0.8 × road | |
  | 3, off-road | 24 of 33 | research 18 | scarp, phase 4 |
  | 4, tram removed | all 30 equal | ±0.5 m | the fixtures have 30 ring positions at 150/300 m, not 32 |
  | 4, ratio | median 0.93, min 0.60, max 1.00 | 0.80–1.00; each 0.70–1.15 | three 300 m positions cross a park lawn (OPEN 1.25) where road mode follows its paths (PATH 1.05) |
  | 4, off-road | 4 of 30 | 0 | the same park crossings |
  | 5, 500 m north | 515 m, straight down the scarp | phase 4 | |

  Specs keep tolerant ranges around these values and say where phase 4 must tighten them.
- Node timings (4-core 2.1 GHz Xeon, Node 22), largest fixture window (scene 1, 3 × 3
  z15 tiles, 307 × 304 = 93k cells): decode 28 ms, build the `optimized` grid 19–76 ms
  (cold first), full Dijkstra 53–86 ms, A* to the farthest case 4–20 ms (`direct`: build
  8–14 ms, full Dijkstra 34–52 ms). Vienna (41k cells, 2,251 buildings): build 37–46 ms,
  list of 30 smoothed routes 9 ms (`direct` build 176–202 ms).
- Specs: `cellHeap.spec.ts` (5), `costGrid.spec.ts` (21), `gridRouting.spec.ts` (+17:
  symmetry and A* on 100 seeded grids, goal sets, suction override, smoothing property on
  200 scenes, `simplifyGated`), `hoseRoutingSetting.spec.ts` (21), `gridRouting.scenes.spec.ts`
  (19, fixtures), plus thin-buildings cases in `hoseCostModel.spec.ts`,
  `hoseCostModel.scenes.spec.ts` and `obstacleDecode.spec.ts`, a shore-leg case in
  `roadRouting.spec.ts` and an `optimized` raster case in `routingDebug.spec.ts`.

**Manual:** in a preview build with the flag, the preview item switches modes
and the route redraws.

**What's New:** none. The production UI is unchanged.

### Phase 4: slope in the cost

**Files**

- `demRaster.ts`: `buildHeightRaster(bounds, cellM, tiles)` (pure: blends
  across tiles, adds a halo, smooths 3×3)
- `demElevation.ts`: fetch wrapper
- `gridRouting.ts` / `costGrid.ts`, `hoseCostModel.ts`
- `nearbyRouting.ts`, `routeProfile.ts`
- the spec files below

**Changes**

- Add the slope factor to the step cost (§6.4), the bridge class rules and
  the z12 fallback baseline.
- Reported metres become the 3D polyline length in all modes.
- `HoseRoute.climbM` feeds the label.

**Specs**

- `src/helper/demRaster.spec.ts` (extended):
  - the height raster of a synthetic plane matches the plane at every cell,
    across tile edges;
  - 3×3 smoothing leaves a plane unchanged;
  - the z12 baseline uses `ceil(24 / cellM)` cells.
- `src/mapHandler/costGrid.spec.ts` (extended):
  - the step cost with slope is symmetric (u→v = v→u);
  - a `BRIDGE` cell ignores slope;
  - a step `BRIDGE` → `OPEN` is rejected;
  - on a synthetic ramp the router takes a 15 % switchback instead of a 70 %
    direct line when the detour is under ~2×.
- `src/helper/routeProfile.spec.ts` (extended): the 3D length of a known
  inclined line is correct to 0.1 %.
- `src/mapHandler/gridRouting.scenes.spec.ts` (extended, `optimized`):

  | Scene | Expected |
  |---|---|
  | 5, "500 m north" | 1,200–1,500 m (research 1,367 m); no run steeper than 60 % longer than 10 m |
  | 5, all 29 positions | total metres over ground steeper than 60 % ≤ 40 m (research 25) |
  | 5, blocking at 60 % / 80 % vs none | every length within ±2 % (research: identical) |
  | 5, z12-only DEM | ≤ 3 of 29 routes differ by > 5 % from z14 (research: 1) |
  | 2, ring positions south of the hydrant | ≥ 80 % of route length on `ROAD`/`PATH`/`BRIDGE` cells (the cutting road stays usable) |
  | 4, rings 150 / 300 m | every length within 5 % of the phase-3 snapshot (building-edge artefacts do not push routes) |
  | all scenes, road-mode routes | 3D extra length ≤ 3 % (research median 0.1 %) |

**Manual:** none.

**What's New:** none while it is behind the flag.

### Phase 5: UI completion, optimized becomes the default, direct is removed

**Files**

- `MainMap.vue`: the layers of §6.8
- `pumpCalculation.ts`: the `pump-line` source gets segment features
  (`pumpLineFeatures`, `pumpCalculation.ts:236-252`)
- `NearbyMarker.vue`, `SupplyPipeCalculation.vue`
- new `src/helper/routeLabel.ts` (pure label formatter)
- `settingsStore.ts`, `composable/settings.ts`, `hoseRoutingSetting.ts`
- `SettingsView.vue`
- `src/locales/{en,de}.json`
- `gridRouting.ts`, `nearbyRouting.ts`, and `weightedDistance.ts` if it has no
  callers left
- the spec files below

**Changes**

- Off-road dashes.
- The road-only comparison, which means a second solve in `roads` mode for the
  selected route only.
- Coverage chips and estimate labelling.
- The one-time note, stored as a Preferences flag.
- **Two modes from now on** (§6.7):
  - remove `'direct'` from the type;
  - remove the preview item and the `settings.map.hoseRoutingPreview` keys;
  - the toggle maps off → `optimized`;
  - new `settings.map.clampToRoads.description` text (and the de label);
  - migrate stored `'direct'` and legacy `'false'`/absent to `optimized`, and
    write the key once.
- **Delete the legacy terrain-only cost path:**
  - `GRID_ROAD_FACTOR`, `GRID_OPEN_FACTOR`, `GRID_BUILDING_FACTOR`,
    `GRID_BUILDING_FRINGE_FACTOR` (`gridRouting.ts:15-31`);
  - the four-class `CLASS_FACTOR` table (`:38-48`);
  - any `clampToRoads` branch.

  One cost grid remains, driven by `hoseCostModel.ts`.

**Specs**

- `src/helper/hoseRoutingSetting.spec.ts`: switch to the "from phase 5" column
  of §6.7:
  - `'direct'` → `optimized`;
  - `clamp='false'` → `optimized`;
  - `clamp='true'` → `roads`;
  - an unknown value → `optimized`;
  - `shouldPersist` is true exactly once.
- `src/helper/routeLabel.spec.ts`:

  | Input | Output |
  |---|---|
  | 1,367 m / 20 m hoses / +197 m, de | `1.367 m · ~69 B-Schläuche · ↑197 m` |
  | negative climb | `↓` |
  | road-only differs by 16 % | road-only length appended |
  | road-only differs by 14 % | nothing appended |
  | any route with off-road metres | off-road metres shown |

- `src/mapHandler/gridRouting.scenes.spec.ts`: drop the terrain/`direct`
  baselines from phases 0–2. All phase-3/4 cases now run through the default
  mode.
- `src/mapHandler/gridRouting.spec.ts`: delete the specs that only covered the
  removed four-class factors.

**Manual:**

- The map shows dashed, amber and red runs in scene 5 (debug view).
- The label is readable on a phone.
- The settings toggle works.
- One preview round with the owner's unit before the merge.

**What's New**

- `feature`: "Hose routes now weigh roads, fields, slopes and obstacles;
  off-road and steep stretches are marked on the line."
- If a "steep stretches" entry from phase 1 is still `unreleased`, merge the
  two.

### Phase 6: Web Worker and adaptive cell size

**Files**

- new `src/workers/hoseRouting.worker.ts` (thin message shell)
- new `src/mapHandler/hoseRoutingCore.ts` (pure solve entry used by worker
  and main thread)
- `nearbyRouting.ts` becomes the main-thread facade (fetch and transfer bytes)
- `costGrid.ts`, `demElevation.ts`
- the spec files below

**Changes**

- Adaptive cell size, cap 400k (§6.10).
- Run the solve in the worker; fall back to the main thread.

**Specs**

- `src/mapHandler/hoseRoutingCore.spec.ts`:
  - `chooseCellSize(windowM, purpose)` returns 4 / 6 / 8 m at the §6.10
    boundaries;
  - above 400k cells it returns `cellCap`;
  - the message payload round-trips via `structuredClone`.
- `src/mapHandler/gridRouting.scenes.spec.ts`: runs through `hoseRoutingCore`
  with adaptive cells. All phase-3/4/5 ranges still hold, and lengths stay
  within 3 % of the 8 m results.

**Manual** (the worker cannot be exercised in Node):

- On one mid-range Android and one iPhone (Capacitor WebView), the worker
  starts and the `OffscreenCanvas` fallback works.
- No main-thread task > 50 ms during a nearby search (Performance panel).
- Cold nearby-list and single-path times, written into this plan.

**What's New:** only if the speed-up is noticeable: `improvement`: "Hose routes
are calculated faster."

### Phase 7: routing cache, non-blocking contract, precache, offline DEM z14

**Files**

- new `src/offline/routingCache.ts` (IndexedDB adapter)
- new pure `src/offline/routingCacheIndex.ts` (budget, LRU, TTL decisions)
- new pure `src/offline/precachePolicy.ts`
- `offlineProtocol.ts`
- new `src/mapHandler/routingData.ts`
- `MainMap.vue`, `markerHandler.ts`, `nearbyWaterSource.ts`
- `tileDownloader.ts`: `zooms: number[]` instead of `zMax`
- `offline/tileMath.ts`: `tilesForZooms`, `tileCountForZooms`
- `offlineAreasStore.ts`: terrain job zooms `[0..12, 14]`
- `offlineAreaActions.ts`: per-zoom size estimate
- `SettingsView.vue`: cache budget
- `src/locales/{en,de}.json`
- the spec files below

**Changes**

- Everything in §6.9.
- Existing offline areas get z14 on their next refresh: the `tileStore.has()`
  check in `downloadTiles` skips tiles already present.

**Specs**

- `src/offline/routingCacheIndex.spec.ts`:
  - eviction keeps the byte total ≤ budget and evicts least-recently-used
    first;
  - basemap expires after 30 days and DEM after 180 days;
  - a 20 km drive simulation (synthetic tile stream) never exceeds the budget.
- `src/offline/precachePolicy.spec.ts`:
  - the ring refreshes after 500 m of movement, not 499 m;
  - priority 3 needs zoom ≥ 14, 1.5 s idle and Wi-Fi;
  - nothing is fetched when offline or with `saveData`;
  - at most 3 requests run per source.
- `src/offline/tileMath.spec.ts`: `tilesForZooms([0..12, 14])` equals the sum
  of the per-zoom counts and skips z13.
- `src/mapHandler/routingData.spec.ts` (fake timers): with a fetcher that
  answers after 5 s, the router returns within 1.5 s with `coverage.basemap =
  'partial'`, and `routingDataArrived` fires once the tile lands.

**Manual** (browser and device behaviour):

- With Overpass blocked and "Slow 3G", the route appears with a chip, then
  updates silently.
- Prefetch does not run on cellular.
- iOS IndexedDB quota behaviour.
- Re-downloading an offline area adds z14, and routing offline inside it shows
  `dem: 'full'`.

**What's New**

- `improvement`: "Hose routes appear immediately and work better offline; map
  data along your way is cached in the background."
- `improvement`: "Offline areas now include finer elevation data for routing."

### Phase 8 (optional): barrier extract in `fireyak-data`

**Scope.** Barriers only:

- lines `barrier=fence|wall|hedge|retaining_wall|guard_rail|city_wall`;
- nodes `barrier=gate|lift_gate|swing_gate|kissing_gate|stile|entrance`.

Everything else is already in the tiles. The **expected value is LOW**: OSM maps
garden fences sparsely, so the gain is mainly town walls and retaining walls.

**Constraints**

- `export-config.json` has `"linear_tags": false`. A separate
  `export-config-barriers.json` with `linear_tags: true` is needed, with
  attributes `type`/`id` only (no version or timestamp). The attribute whitelist
  `barrier`, `access`, `entrance` is applied with an `osmium tags-filter
  --remove-tags` pass, or by `tippecanoe -y` as below.
- No extra planet pass: merge the barrier expressions into the existing
  `osmium tags-filter` (`build.sh:67`) and split afterwards.
- One output format only: PMTiles at a single zoom, z14. No FlatGeobuf twin,
  which is estimated at 5–8 GB at planet scale.
- Behind `BUILD_BARRIERS=1`, weekly rather than daily. The water sources upload
  first.
- A hard size gate before upload (`BARRIER_MAX_BYTES`): abort the barrier upload
  above the bucket budget.

**Proposed commands**

```bash
# 2. one planet pass for both extracts (build.sh:67 extended)
osmium tags-filter "$PLANET" \
    nwr/emergency=fire_hydrant nwr/emergency=water_tank nwr/emergency=suction_point \
    nwr/emergency=fire_water_pond nwr/amenity=fire_station \
    w/barrier=fence,wall,hedge,retaining_wall,guard_rail,city_wall \
    n/barrier=gate,lift_gate,swing_gate,kissing_gate,stile,entrance \
    --overwrite -o "$WORK/combined.osm.pbf"
# split (cheap: filtered file is small)
osmium tags-filter "$WORK/combined.osm.pbf" \
    nwr/emergency=fire_hydrant,water_tank,suction_point,fire_water_pond nwr/amenity=fire_station \
    --overwrite -o "$FILTERED"
if [ "${BUILD_BARRIERS:-0}" = "1" ]; then
  osmium tags-filter "$WORK/combined.osm.pbf" nw/barrier --overwrite -o "$WORK/barriers.osm.pbf"
  osmium export "$WORK/barriers.osm.pbf" -c /etc/osmium-export-config-barriers.json \
      -f geojsonseq --overwrite -o "$WORK/barriers.geojsonseq"
  tippecanoe -o "$OUT/barriers.pmtiles" -l barriers -Z14 -z14 \
      -y barrier -y access -y entrance --no-tile-size-limit --force "$WORK/barriers.geojsonseq"
  size=$(stat -c %s "$OUT/barriers.pmtiles")
  [ "$size" -le "${BARRIER_MAX_BYTES:-1500000000}" ] || { log "barriers.pmtiles too large ($size)"; rm -f "$OUT/barriers.pmtiles"; }
fi
```

The commands are a proposal and are untested. Two points need checking:

- The split passes must **not** use `-R` (`--omit-referenced`). `osmium export`
  needs the member ways and nodes of pond relations and barrier ways, and
  tags-filter keeps referenced objects only without `-R`.
- Measure whether the combined first pass is still as fast as today's filter.
  Planet-scale ways with `barrier=*` are many more than water sources, so the
  intermediate file grows (ESTIMATE: a few GB at planet scale).

**Budget context.** This is the owner's Cloudflare R2 free plan. The pricing
figures are recalled, **NOT verified**: 10 GB storage, 1 M Class A and 10 M
Class B operations per month.

- The bucket currently holds 2.48 GB.
- The two data files are ~1.27 GB.
- The rest is presumably an old `fireyak-data/` prefix (owner to check).

**Size estimates (ESTIMATED)**

| Region | Size |
|---|---|
| Austria | low tens of MB |
| DACH | a few hundred MB |
| planet | 0.5–2 GB, uncertain by ~2× |

The first Austria build gives the real figure.

**Build time.** Today's daily run takes ~4 h on the owner's machine; the two
planet passes dominate. Estimated extra time:

| Region | Extra time |
|---|---|
| Austria / DACH | 5–20 min |
| planet on a NAS | 30–90 min or more |

**Rollout:** Austria → DACH → planet.

**App side** (a separate phase 8b, only if the extract proves useful):

- Read `barriers.pmtiles` z14 through the `offline://` pipeline.
- Barrier lines → `BLOCKED`; gates/entrances on a barrier → passable.
- `coverage.barriers` becomes `full` or `partial`.
- Specs for phase 8b:
  - `obstacleDecode.spec.ts`: barrier lines and gate nodes decode from a small
    synthetic tile;
  - `hoseCostModel.spec.ts`: a barrier line is `BLOCKED`, a gate on it is
    passable;
  - a synthetic-grid case in `gridRouting.spec.ts` routes through the gate.

  The pipeline itself (other repository, no test runner) stays manual: check
  the first Austria build's size and spot-check it against openstreetmap.org.

**What's New**

- Phase 8: none (data only).
- Phase 8b: `improvement`: "Hose routes now avoid mapped walls and fences."

## 8. Files touched (overview)

Spec files sit next to their source file and are listed in each phase. They are
summarised in the second-to-last row.

| File | Phases |
|---|---|
| `src/mapHandler/gridRouting.ts` (+ new `costGrid.ts`, `cellHeap.ts`) | 1, 3, 4, 5 (legacy factors removed), 6 |
| `src/mapHandler/nearbyRouting.ts` | 1, 3, 4, 5, 6, 7 |
| `src/mapHandler/roadRouting.ts` | 1, 3 |
| `src/mapHandler/obstacleGeometry.ts`, new `obstacleDecode.ts`, `src/types/obstacles.ts` | 1, 2 |
| `src/mapHandler/hoseCostModel.ts` (new) | 2–4 |
| `src/mapHandler/hoseRoutingCore.ts` (new), `src/workers/hoseRouting.worker.ts` (new) | 6 |
| `src/mapHandler/waterSourceAccess.ts`, `markerHandler.ts` | 1, 3, 7 |
| `src/mapHandler/routingData.ts` (new) | 7 |
| `src/helper/demElevation.ts`, new `demRaster.ts`, `src/offline/tileMath.ts` | 1, 4, 6, 7 |
| `src/helper/polygonGeometry.ts`, `routeProfile.ts`, `hosePressure.ts` (all new) | 1, 4, 5 |
| `src/helper/hoseRoutingSetting.ts` (new), `src/helper/routeLabel.ts` (new) | 3, 5 |
| `src/helper/weightedDistance.ts` | 5 (deleted if unused) |
| `src/offline/offlineProtocol.ts`, `tileDownloader.ts`, new `routingCache.ts`, `routingCacheIndex.ts`, `precachePolicy.ts` | 7 |
| `src/store/offlineAreasStore.ts`, `src/composable/offlineAreaActions.ts` | 7 |
| `src/store/pumpCalculationSettings.ts` | 1 (`maxHosePressure`) |
| `src/store/settingsStore.ts`, `src/composable/settings.ts`, `src/views/SettingsView.vue` | 1, 3, 5, 7 |
| `src/components/MainMap.vue`, `src/composable/pumpCalculation.ts` | 1, 3, 5, 7 |
| `src/components/NearbyMarker.vue`, `SupplyPipeCalculation.vue` | 1, 5 |
| `src/locales/{en,de}.json` | 1, 3, 5, 7 |
| `src/composable/modalBreakpointWatcher.ts`, `src/views/SettingsView.vue` (existing type errors) | 0 |
| `src/views/RoutingDebugView.vue` (new), `src/router/index.ts` | 0 (and kept current in later phases) |
| `scripts/fetch-routing-fixtures.mjs` (new), `src/mapHandler/__fixtures__/routing/**` (new), `src/testing/routingFixtures.ts` (new) | 0 |
| `package.json`, `package-lock.json`, `vitest.config.ts` (new), `tsconfig.node.json`, `eslint.config.mjs`, `.prettierignore` | 0 |
| `.github/workflows/ci.yml` (new), `.github/workflows/release.yml` | 0 |
| `AGENTS.md` (§2, §3, §4, §7), `CLAUDE.md` | 0 |
| `*.spec.ts` / `*.scenes.spec.ts` next to the files above | 0–7 |
| `src/assets/whats-new.json` | 1, 5, (6), 7 |
| `fireyak-data`: `build.sh`, `export-config-barriers.json` (new), `Dockerfile` (COPY) | 8 |

## 9. Limits and honest caveats

- **No extract can fix invisible obstacles.** Unmapped fences, gardens, crops,
  locked gates and parked cars do not exist for the router, and the barrier
  extract (phase 8) only adds what OSM has, which is little.
- `landuse=residential` covers whole blocks. ×3 is a proxy for "yards and
  fences", not knowledge.
- Culverted streams look open. A stream line costs ×4, but a culvert under a
  field is not visible as a culvert.
- Paths carry no surface or difficulty data. A steep hiking path costs the same
  as a pavement apart from the slope factor.
- Bridges and underpasses sit on a 2-D raster. The bridge class and the drawing
  order handle common cases, but a path passing under a road bridge shares cells
  with it. The DEM cuts bridges as terrain (§4.2).
- The samples were small and all in Austria, which is a best case for building
  completeness. §6.11 exists for other regions, with untested thresholds. The
  fixtures are Austrian too, so green scene specs prove nothing about other
  regions.
- The optimized numbers so far come from an **approximation** by the research
  agent, not from the app. The phase 3/4 scene specs use them as tolerant
  targets, not as truth. If the real router lands outside a range, check the
  case before tuning to it.
- The pressure rule is static. It ignores friction (which only lowers
  pressure), pressure surges and hose ageing.
- Everything shown is an estimate. The UI must say so (§6.8).

## 10. Open questions

**Decided by the owner** (recorded here so the history stays readable):

- Tunnelled footways and paths are excluded (§6.3).
- The slope thresholds for amber, red and the "not recommended" chip are
  accepted as the starting values, and 16 bar is the default maximum hose
  working pressure (§6.13).
- `access=military` roads and `landuse=military` block; every other `access`
  value stays passable (§6.3).

**Still open:**

1. **Why do the Vienna tiles lack sidewalks** (35 % of road length)? Is it
   Protomaps generalisation, or an OSM tagging pattern (sidewalks mapped as
   `footway=sidewalk` on separate ways)?
2. **R2:** the real pricing and limits, and what the stale ~1.2 GB prefix is.
3. **Fixture redistribution:** do Protomaps' terms (and Mapterhorn's per-source
   licences) allow the routing fixtures in a public repository? Until
   confirmed, the tiles stay gitignored and scene specs skip (§6.14).
4. How should "Wi-Fi only" work on the web build? `navigator.connection` is
   missing in Safari, so either treat unknown as "no prefetch" or allow it.
5. Should the nearby list re-sort after a silent recompute, or only update the
   metres?
6. Precaching raises Protomaps API request volume. Check the key's plan limits.

## 11. Risks

- **Performance on low-end phones.** The worker and adaptive cells are
  mitigations, but the numbers are not measured yet (phase 6).
- **False confidence.** A tidy dashed line through a fenced garden looks
  authoritative. Mitigations: estimate labelling, the one-time note, and the
  coverage chips.
- **Losing the straight-across mode.** Some users relied on the terrain mode as
  a shortest-line estimate. `optimized` gives a similar line on open land, and
  the label shows the road-only length when the two differ, but the "lower
  bound" number itself is gone after phase 5.
- **Window clipping.** Detours longer than the window margin are impossible. The
  edge-touch re-solve (§6.5) mitigates this, but a very long detour can still be
  cut.
- **DEM artefacts** at bridges and building edges can push routes. They are
  bounded by the road cap (×1.3) and the bridge class; the phase 4 scene specs
  check this.
- **Settings migration** could misread or overwrite user choices. Phases 3–4
  never persist migrated values; phase 5 writes once. Every case of the §6.7
  table is a spec case.
- **Pressure warnings in hilly regions.** With a pump at the source, a 40 m
  drop already shows a caution. That may be noisy where such drops are normal;
  the threshold follows the user's `maxHosePressure`.
- **Test tolerances.** If the ranges are too tight, specs flap after a fixture
  refresh; if too loose, regressions slip through. Re-check the ranges whenever
  fixtures are regenerated, and keep the research figures in §5 as the
  reference.
- **Type-check baseline.** `typecheck` is red today (2 errors in `src`), so
  phase 0 must fix them before CI can require the step.
- **Fixture licence.** If the redistribution terms are not confirmed, scene
  specs run only where a developer fetched the fixtures, and CI covers unit
  specs only.
- **Storage growth:** the routing cache plus DEM z14 in offline areas. Use the
  byte budget and show the estimates in the UI.
- **CDN quota or rate limits** from precaching. Limit concurrency to 3, use
  Wi-Fi only, and respect `saveData`.
- **Worker support.** `OffscreenCanvas` 2D in workers on older iOS WebViews is
  recalled as available from iOS 16.4 and is not verified. The fallback path
  must work.
- **Pipeline.** A barrier build could push the R2 bucket over its free limits.
  The size gate and the weekly cadence mitigate this.
