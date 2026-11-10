# Hose routing: optimized mode, slope, steep-section warnings, non-blocking data

> **Code references.** Every `file:line` below points to
> `origin/feature/110-pond-shore` at commit `558308a`, the branch this work lands on.
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

1. Add a third mode, **`optimized`**: a weighted cost grid built from Protomaps z15
   and the Mapterhorn DEM at z14. It is to become the default.
2. Fix the defects of the two existing modes.
3. Price slope into the cost.
4. Show steep and off-road sections on the route line, with a warning.
5. Never block routing on Overpass.
6. Optional, last: a barrier extract in `fireyak-data`.

## 2. Owner's screenshots → verified cause

All four come from scene 1 (§5). The pond numbers come from the screenshots.
The hydrant numbers come from the research brief. Which screenshot showed which
hydrant mode is INFERRED from that brief.

| # | Screenshot | Verified cause |
|---|---|---|
| 1 | Pond, road mode: 1.7 km / 85 hoses | The only road within `MAX_SNAP_M = 100` (`roadRouting.ts:27`) of the shore point is a cycleway that leads away from the village. The farm track that comes within 198 m is out of snap range. A faithful JS port of `roadRouting` gave 1,727 m. Attaching at the track would give ≈ 842 m. The graph itself is healthy: 11 components, the main one 56.6 km, no broken track stubs. Also, the shore point is fixed **before** routing as the straight-line nearest outline point (`waterSourceAccess.ts:86`), so the router cannot pick a better point on the shore. |
| 2 | Pond, terrain mode: 528 m straight across farmland | The behaviour is as designed: the grid has no land-use classes, and all non-road, non-building cells cost `GRID_OPEN_FACTOR = 1.0` (`gridRouting.ts:22`). String pulling then draws a straight line. The number is a fair lower bound but not a recommendation. |
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
  hose ratings is for the owner to confirm (§10).

## 6. Design (decisions already made)

### 6.1 Engine

**Chosen:** extend the terrain grid (`gridRouting.ts`) into a weighted cost grid.
It is shared by `optimized` and `direct`.

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
  roads: RoadLine[];          // as today: rail and ferry excluded; path/corridor excluded from phase 2
  rails: LinearFeature[];     // kind=rail, every kind_detail
  landuse: AreaPolygon[];
  waterAreas: AreaPolygon[];
  waterLines: LinearFeature[];
  cliffs: LinearFeature[];
  coverage: TileCoverage;
}
```

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
| `BLOCKED` | water polygons (except the target pond's own polygon, see §6.5); water lines river/canal; heavy rail on the surface; motorway on the surface; cliff lines | ∞ |

Rail and motorway rules:

- **Heavy rail** means `kind=rail` with `kind_detail` in {rail, light_rail,
  narrow_gauge}, **not** `is_tunnel` and **not** `is_bridge`.
- Tram, subway, disused, and any tunnelled or bridged rail **do not block**.
- A surface motorway is `kind=highway`, not tunnel, not bridge.

Excluded from both graph and grid:

- `ferry`;
- `path/corridor` (indoor passages);
- tunnelled footways: OPEN question. The proposal is to exclude them, because
  most are underground passages (INFERRED).

`access` and `oneway` are ignored: the fire service may enter private ground. A
possible exception is `access=military` (OPEN).

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

**Pressure** stays in the existing post-route calculation
(`calculatePumpPosition.ts`).

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

### 6.7 Settings

```ts
export type HoseRoutingMode = 'optimized' | 'roads' | 'direct';
// settingsStore: hoseRouting: HoseRoutingMode (replaces clampHosesToRoads)
// nearbyRouting: RoutingOptions { mode: HoseRoutingMode } (replaces clampToRoads)
```

**Preferences.** The new key is `hose_routing`. Migration happens in
`composable/settings.ts`, in memory only:

| Stored state | Mode used |
|---|---|
| `hose_routing` present | that value |
| else `clamp_hoses_to_roads === 'true'` | `roads` |
| else (`'false'` or absent) | `DEFAULT_HOSE_ROUTING` |

`DEFAULT_HOSE_ROUTING` is `'direct'` until phase 5, then `'optimized'`.

The migrated value is **not** written back. Only an explicit choice is
persisted, so users who never chose get the new default when it flips. The old
key is removed when the new one is saved.

**Modes**

- `direct` = today's terrain behaviour with the phase-1 fixes. It is labelled as
  a lower bound.
- The toggle becomes a three-way select. Keys: `settings.map.hoseRouting.label`,
  `.description` and `.options.{optimized,roads,direct}`, plus `.directHint`, in
  en and de. Remove `settings.map.clampToRoads.*`.
- `optimized` becomes the default only after phase 5.

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

**"Not recommended" chip.** Shown when any of these holds:

- any stretch > 50 % for ≥ 10 m;
- more than 50 m in total above 25 %;
- |Δh| between the ends > `HEIGHT_WARN_M`. The placeholder is 50 m (= 5 bar
  static); the owner sets the real value (§10).

The chip appears on:

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

The steep display and the warning apply to **all three modes**. They ship in
phase 1, before `optimized` exists.

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
  roadOnlyMeters: number | null;
  demZoom: number | null;
  fallback: RouteFallback | null;
  coverage: RoutingCoverage;
}
```

## 7. Phases

Each phase is a separate, mergeable PR, and the order matters. What's New
entries follow AGENTS.md §6. If an `unreleased` entry for the same feature
already exists, update it instead of adding a new one.

### Phase 0: fixtures, debug view, test decision

**Files**

| File | Status |
|---|---|
| `scripts/fetch-routing-fixtures.mjs` | new |
| `src/views/RoutingDebugView.vue` | new |
| `src/router/index.ts` | changed |
| `.gitignore` | changed |

**Fixtures**

- The script downloads the z15 basemap and the z14 + z12 DEM tiles for the five
  scenes (§5) into `dev-fixtures/routing/<scene>/{z}/{x}/{y}.{mvt,webp}`.
- It reads the Protomaps key from the `VITE_PROTOMAPS_API_KEY` environment
  variable. **The key is never written to a file.**
- Fixtures are gitignored by default. Committing them is OPEN: about 2–4 MB
  (ESTIMATE), and the Protomaps terms must be checked.

**Debug view**

- Route `/debug/routing`, registered only when `import.meta.env.DEV` or
  `VITE_ROUTING_DEBUG=1`.
- It has a scene picker and draggable origin and target.
- It draws all modes at once, each with its length, timing and coverage.
- It overlays the cost raster (canvas → MapLibre `image` source).
- It has a "ring" button that runs the §5 ring simulation and prints the ratio
  table.
- A fixture switch makes `fetchTileCacheFirst` read from `dev-fixtures` (dev
  only).

**Test decision (OWNER)**

- **Option A:** add `vitest` as a dev dependency, for the pure modules only:
  `hoseCostModel`, raster fill, solve, smoothing, `routeProfile`, settings
  migration, `areaShore`. Then update AGENTS.md §7.
- **Option B:** no test runner. Use the debug view, a
  `window.__routingHarness` that logs the scene checks of §7 as a table, and a
  manual checklist in the PR.

**Acceptance**

- The debug view reproduces today's numbers:

  | Check | Expected |
  |---|---|
  | scene 1 pond, road mode | ≈ 1.7 km |
  | scene 1 pond, terrain mode | ≈ 528 m |
  | scene 1 hydrant, road / terrain | 295 m / 232 m |

- The Melk ring medians are within ±10 % of §5.

**What's New:** none (dev only).

### Phase 1: fixes without new data, and the steep display for existing modes

**Files**

- `gridRouting.ts`, `nearbyRouting.ts`, `roadRouting.ts`, `obstacleGeometry.ts`
- `waterSourceAccess.ts`, `markerHandler.ts`
- `demElevation.ts`, `offline/tileMath.ts`
- new `src/helper/routeProfile.ts`
- `MainMap.vue`, `pumpCalculation.ts`, `NearbyMarker.vue`, `SupplyPipeCalculation.vue`
- `src/locales/{en,de}.json`

**Changes**

1. **Exact building test and true endpoints.** Smoothing starts from the true
   origin and target. `exactLineOfSight` becomes a segment/edge intersection
   test (§6.6).
2. **One length.** `computeNearbyDistances` returns the length of the
   **smoothed polyline** per target. Road mode already does (§3.2); terrain
   mode needs path reconstruction and smoothing per reached target, ≤ 30. Label,
   list and pump calculation then agree exactly. If smoothing 30 targets is
   measured too slow, smooth the top 10 and show the rest with "≈".
3. **Surface fallbacks** (§6.11). This covers the grid → road downgrade
   (`nearbyRouting.ts:216-221`), the tile cap (`obstacleGeometry.ts:54-59`),
   > 3 km (`:211`) and "no road within 100 m".
4. **Missing vs empty** (§6.9). Do not cache missing tiles. Add
   `coverage.basemap`.
5. **Pond shore chosen by routing.**
   - `resolveAccessPoint` returns
     `AccessTarget = { kind: 'point'; point } | { kind: 'shore'; outline; fallback: GeoPoint }`.
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
8. **Steep display and warning for road and direct mode** (§6.8).
   - Export `decodeTerrariumTile` and `pointToTileCoord`.
   - Add `sampleElevationsBlended(points, zoom)`, which blends neighbour tiles
     at edges.
   - Add `TERRAIN_ROUTING_ZOOM = 14`. Try z14 within the budget, else fall back
     to z12 (amber only).
   - Fix the comment at `demElevation.ts:14`.
   - Raise the DEM LRU to 16 tiles (ESTIMATE: 16 MB).

**Acceptance**

| Scene | Check |
|---|---|
| 1, pond, road mode | ≤ ~900 m, attaches via the farm track (research: ≈ 842 m), ends on the shore |
| 1, hydrant, direct | no segment intersects a building (exact test, logged in the harness); length between 232 and 295 m |
| any | list metres = label metres (to the metre) for 10 random targets per scene |
| 5, "500 m north", direct | red section shown and "not recommended" chip |
| all, routing | does not wait on Overpass: with Overpass blocked in DevTools, the path appears within the 1.5 s budget |

**What's New**

- `fix`: "Hose routes to a hydrant no longer cut through buildings, and the
  list and map show the same length."
- `fix`: "Routes to fire water ponds now end at the best reachable shore point."
- `improvement`: "Steep stretches of a hose route are highlighted, with a
  warning when the route is not recommended."

### Phase 2: decode the extra tile layers and add the cost model (no behaviour change)

**Files**

- `src/types/obstacles.ts`
- `obstacleGeometry.ts`
- new `src/mapHandler/hoseCostModel.ts`
- `RoutingDebugView.vue`, to show the classes

**Changes**

- Extend the decoder (§6.2). `roads` keeps excluding rail and ferry and now also
  `path/corridor`; rail goes to `rails`.
- Add the cost-model module with classifiers and factors (§6.3, §6.4).
- In the debug view, list unknown landuse kinds seen per scene.

**Acceptance**

- Road and direct results are identical to phase 1 on all scenes. The only
  exception is the removal of `path/corridor` from road mode; check that Vienna
  changes only where indoor passages were used.
- Per-scene class histograms match §4.1. For example, scene 1 is ~55 % `OPEN`
  from farmland.
- Decode time per tile is logged.

**What's New:** none.

### Phase 3: optimized mode in the grid (no slope), settings enum, behind a dev flag

**Files**

- `gridRouting.ts`, possibly split out as `costGrid.ts`
- `nearbyRouting.ts`, `roadRouting.ts`
- `settingsStore.ts`, `composable/settings.ts`, `SettingsView.vue`
- `markerHandler.ts`, `MainMap.vue`, `pumpCalculation.ts`
- `src/locales/{en,de}.json`

**Changes**

- Add the classes and rasterisation order (§6.3), the escape radius, and
  scanline fill.
- Goal sets and A* (§6.5).
- Cost-aware smoothing (§6.6).
- Settings enum and migration (§6.7). Default `direct`.
- Show `optimized` in the select only when `VITE_HOSE_ROUTING_OPTIMIZED=1` or in
  dev, so Cloudflare previews can enable it.
- Road mode: price the final leg with the cost model; this is the "light"
  variant from §6.1.

**Acceptance (optimized, indicative targets)**

| Scene | Check |
|---|---|
| 1, pond | between ~528 m and ~700 m; ends on the shore; crosses no building |
| 1, hydrant | ≤ 295 m; no segment intersects a building |
| 2 | no route crosses surface heavy rail except along a road (the underpass ~155 m WNW, level crossings); ~8 of 38 positions notably off-road (± a few) |
| 3 | no route enters the Danube polygon; the 151 m / 797 m case is clearly shorter than road mode |
| 4 | trams never block: deleting tram features changes no route; optimized within ~15 % of road mode per position (research median 0.86); 0 of 45 notably off-road |
| settings | a stored `clamp_hoses_to_roads='true'` loads as `roads`; `'false'`/absent loads as the default and is not persisted |

**What's New:** none while it is behind the flag. If the settings select ships
visibly with only `roads`/`direct`, add an `improvement` entry that names the
renamed option.

### Phase 4: slope in the cost

**Files**

- `demElevation.ts`: `getHeightRaster(bounds, cellM, zoom)`, which blends
  across tiles, adds a halo and smooths 3×3.
- `gridRouting.ts` / `costGrid.ts`, `hoseCostModel.ts`
- `nearbyRouting.ts`, `routeProfile.ts`

**Changes**

- Add the slope factor (§6.4), the bridge class rules and the z12 fallback
  baseline.
- Reported metres become the 3D polyline length in all modes.
- `HoseRoute.climbM` feeds the label.

**Acceptance**

| Scene | Check |
|---|---|
| 5, "500 m north" | no straight descent of the scarp; length ~1.2–1.5 km (research 1,367 m) |
| 5, all 29 positions | metres over > 60 % ≤ ~25 m in total (research: 408 → 25) |
| 5, blocking test | turning blocking on at 60 % or 80 % changes no length (research) |
| 2 | the road in the cutting is still used; its banks do not act as walls for the road itself |
| 4 | building-edge steepness artefacts do not change any route vs phase 3 by > 5 % |
| 3D | extra length for road routes ≤ ~2–3 % (research median 0.1 %) |
| z12 only | at most ~1 in 29 Innsbruck routes differs from z14 (research) |

**What's New:** none while it is behind the flag.

### Phase 5: UI completion, then optimized becomes the default

**Files**

- `MainMap.vue`: the layers of §6.8
- `pumpCalculation.ts`: the `pump-line` source gets segment features
  (`pumpLineFeatures`, `pumpCalculation.ts:236-252`)
- `NearbyMarker.vue`, `SupplyPipeCalculation.vue`
- `src/locales/{en,de}.json`
- `settingsStore.ts`: `DEFAULT_HOSE_ROUTING = 'optimized'`

**Changes**

- Off-road dashes.
- The road-only comparison, which means a second solve in `roads` mode for the
  selected route only.
- Coverage chips and estimate labelling.
- The one-time note, stored as a Preferences flag.
- Remove the dev flag.

**Acceptance**

- All checks from phases 3 and 4 still pass.
- In scene 5, a route shows dashed, amber and red runs where expected.
- The label format matches §6.8.
- A user with `clamp_hoses_to_roads='true'` still gets `roads`.

**What's New:** `feature`: "New route mode that weighs roads, fields, slopes and
obstacles; off-road and steep stretches are marked on the line."

### Phase 6: Web Worker and adaptive cell size

**Files**

- new `src/workers/hoseRouting.worker.ts`
- `nearbyRouting.ts` becomes the main-thread facade (fetch and transfer bytes)
- `costGrid.ts`, `demElevation.ts`

**Changes**

- Adaptive cell size, cap 400k (§6.10).
- Run the solve in the worker; fall back to the main thread.

**Acceptance**

- No main-thread task > 50 ms during a nearby search (Performance panel).
- Cold nearby list and single path times are measured on one mid-range Android
  and one iPhone and written into this plan.
- Results agree with phase 5 within 3 % on all scenes; finer cells may change
  them slightly.

**What's New:** only if the speed-up is noticeable: `improvement`: "Hose routes
are calculated faster."

### Phase 7: routing cache, non-blocking contract, precache, offline DEM z14

**Files**

- new `src/offline/routingCache.ts`
- `offlineProtocol.ts`
- new `src/mapHandler/routingData.ts`
- `MainMap.vue`, `markerHandler.ts`, `nearbyWaterSource.ts`
- `tileDownloader.ts`: `zooms: number[]` instead of `zMax`
- `offline/tileMath.ts`: `tilesForZooms`, `tileCountForZooms`
- `offlineAreasStore.ts`: terrain job zooms `[0..12, 14]`
- `offlineAreaActions.ts`: per-zoom size estimate
- `SettingsView.vue`: cache budget
- `src/locales/{en,de}.json`

**Changes**

- Everything in §6.9.
- Existing offline areas get z14 on their next refresh: the `tileStore.has()`
  check in `downloadTiles` skips tiles already present.

**Acceptance**

- With Overpass blocked and the network throttled to "Slow 3G", a route appears
  within ~1.5 s with a coverage chip, then updates silently when the tiles land.
- The cache byte total stays ≤ budget after a 20 km drive simulation.
- No prefetch runs on cellular or with `saveData`.
- Offline inside a re-downloaded area, `dem` coverage is `full` at z14.

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

**What's New**

- Phase 8: none (data only).
- Phase 8b: `improvement`: "Hose routes now avoid mapped walls and fences."

## 8. Files touched (overview)

| File | Phases |
|---|---|
| `src/mapHandler/gridRouting.ts` (+ new `costGrid.ts`) | 1, 3, 4, 6 |
| `src/mapHandler/nearbyRouting.ts` | 1, 3, 4, 6, 7 |
| `src/mapHandler/roadRouting.ts` | 1, 3 |
| `src/mapHandler/obstacleGeometry.ts`, `src/types/obstacles.ts` | 1, 2 |
| `src/mapHandler/hoseCostModel.ts` (new) | 2–4 |
| `src/mapHandler/waterSourceAccess.ts`, `markerHandler.ts` | 1, 3, 7 |
| `src/mapHandler/routingData.ts` (new) | 7 |
| `src/helper/demElevation.ts`, `src/offline/tileMath.ts` | 1, 4, 6, 7 |
| `src/helper/routeProfile.ts` (new) | 1, 4, 5 |
| `src/offline/offlineProtocol.ts`, `routingCache.ts` (new), `tileDownloader.ts` | 7 |
| `src/store/offlineAreasStore.ts`, `src/composable/offlineAreaActions.ts` | 7 |
| `src/store/settingsStore.ts`, `src/composable/settings.ts`, `src/views/SettingsView.vue` | 3, 5, 7 |
| `src/components/MainMap.vue`, `src/composable/pumpCalculation.ts` | 1, 3, 5, 7 |
| `src/components/NearbyMarker.vue`, `SupplyPipeCalculation.vue` | 1, 5 |
| `src/locales/{en,de}.json` | 1, 3, 5, 7 |
| `src/workers/hoseRouting.worker.ts` (new) | 6 |
| `src/views/RoutingDebugView.vue` (new), `src/router/index.ts`, `scripts/fetch-routing-fixtures.mjs` (new) | 0 |
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
  completeness. §6.11 exists for other regions, with untested thresholds.
- The optimized numbers so far come from an **approximation** by the research
  agent, not from the app. Phase 3/4 acceptance compares against them as
  targets, not as truth.
- Everything shown is an estimate. The UI must say so (§6.8).

## 10. Open questions

1. **When does `optimized` become the default?** Proposed: at the end of
   phase 5, after one preview round with the owner's unit.
2. **vitest yes or no?** See phase 0.
3. **Tunnelled footways:** exclude (proposed) or treat as paths?
4. **Thresholds** for amber, red and the chip, and especially `HEIGHT_WARN_M`.
   The owner should give the hose pressure rating, so the static gain on
   downhill lines (Innsbruck: 18–22 bar) can be judged.
5. **Should `direct` mode survive** once `optimized` is the default? It is
   useful as a lower bound, but it is a third option to explain.
6. **Why do the Vienna tiles lack sidewalks** (35 % of road length)? Is it
   Protomaps generalisation, or an OSM tagging pattern (sidewalks mapped as
   `footway=sidewalk` on separate ways)?
7. **R2:** the real pricing and limits, and what the stale ~1.2 GB prefix is.
8. Should `access=military` block?
9. Should the routing fixtures be committed (size, Protomaps terms) or stay
   gitignored?
10. How should "Wi-Fi only" work on the web build? `navigator.connection` is
    missing in Safari, so either treat unknown as "no prefetch" or allow it.
11. Should the nearby list re-sort after a silent recompute, or only update the
    metres?
12. Precaching raises Protomaps API request volume. Check the key's plan limits.

## 11. Risks

- **Performance on low-end phones.** The worker and adaptive cells are
  mitigations, but the numbers are not measured yet (phase 6).
- **False confidence.** A tidy dashed line through a fenced garden looks
  authoritative. Mitigations: estimate labelling, the one-time note, and the
  coverage chips.
- **Window clipping.** Detours longer than the window margin are impossible. The
  edge-touch re-solve (§6.5) mitigates this, but a very long detour can still be
  cut.
- **DEM artefacts** at bridges and building edges can push routes. They are
  bounded by the road cap (×1.3) and the bridge class; check them in phase 4.
- **Settings migration** could misread or overwrite user choices. Never persist
  migrated values (§6.7).
- **Storage growth:** the routing cache plus DEM z14 in offline areas. Use the
  byte budget and show the estimates in the UI.
- **CDN quota or rate limits** from precaching. Limit concurrency to 3, use
  Wi-Fi only, and respect `saveData`.
- **Worker support.** `OffscreenCanvas` 2D in workers on older iOS WebViews is
  recalled as available from iOS 16.4 and is not verified. The fallback path
  must work.
- **Pipeline.** A barrier build could push the R2 bucket over its free limits.
  The size gate and the weekly cadence mitigate this.
