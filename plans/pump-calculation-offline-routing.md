# Offline-ready pump calculation: DEM elevation, routed supply line, hose-count labels

## Context

The supply-pipe (pump) calculation currently depends on two things that break or degrade offline, and its polyline ignores the routing work already shipped on this branch:

1. **Elevation** comes only from the Open-Meteo API (`src/helper/elevationData.ts`); offline it falls back to flat terrain. Yet the app already downloads Mapterhorn **terrarium DEM tiles** (`offline://terrain/{z}/{x}/{y}`, webp, 512 px, maxzoom 12) for hillshade/3D — nothing decodes them into numbers. (Decoding was a documented stretch goal in `plans/offline-mode-implementation.md`.)
2. **The pump polyline** draws straight segments between suction point → waypoints → fire object, while the nearby-marker flow already routes along terrain/roads via `getRoutedPath()` (`src/mapHandler/nearbyRouting.ts:206`) honoring the `clampHosesToRoads` setting (`src/store/settingsStore.ts:49`).
3. Pump-to-pump hose counts exist only inside marker popups; they should be visible **between each pump marker** on the map.
4. The pump math in `src/helper/calculatePumpPosition.ts` has several defects (see D).

Decisions: **DEM-first elevation with Open-Meteo fallback** (flat terrain as last resort); **keep the manual pressure-loss setting** and delete the unused flow-rate table; hose length/diameter/name become user settings (E).

## A. Offline elevation from DEM tiles

**New file `src/helper/demElevation.ts`:**
- `getDemElevations(points: GeoPoint[]): Promise<ElevationPoint[] | null>` — returns `null` if *any* needed tile is unavailable (caller falls back to the API; no mixing of sources).
- Group points by z12 web-mercator tile (512 px tiles → ~19 m/px at Austrian latitudes, finer than Open-Meteo's 90 m DEM). Fetch bytes via `fetchTileCacheFirst('terrain', 12, x, y)` from `src/offline/offlineProtocol.ts` (cache-first, works offline).
- Decode webp with `createImageBitmap(new Blob([buf]))` → draw to `OffscreenCanvas` (fallback: hidden `<canvas>`) → `getImageData`. Terrarium decode: `elevation = r*256 + g + b/256 - 32768`.
- **Bilinear interpolation** between the 4 surrounding pixels (20 m elevation raster vs ~19 m pixels — nearest-neighbor would stair-step).
- Small LRU of decoded tiles (e.g. 8 × `Float32Array(512*512)` ≈ 8 MB) so a several-km supply line doesn't re-decode per point.

**Modify `src/helper/elevationData.ts` → `getElevationDataForPoints`:**
- New chain: DEM tiles → Open-Meteo (only if online) → flat fallback. `elevationIgnored: true` only for the flat case (existing "elevation ignored" UI keeps working).

## B. Routed pump polyline (same algorithm + setting as NearbyMarker)

**Modify `src/composable/pumpCalculation.ts`:**
- Keep `updatePolyline()` as the instant straight-line draw (responsive while dragging), then kick an async `updateRoutedPolyline()`:
  - For each consecutive pair in `[suctionPoint, ...wayPoints, targetPoint]`, call `getRoutedPath(a, b, { clampToRoads: useSettingsStore().clampHosesToRoads })` — identical to `MainMap.vue:795` (`showPathToSelectedMarker`).
  - Per-leg fallback to the straight segment when `getRoutedPath` returns `null` (leg > 3 km straight-line, or unroutable — routers fail open by design). Waypoints naturally subdivide long lines.
  - Concatenate legs into module-level `routedPathPoints: GeoPoint[]`; guard stale async results with a request token; write to the existing `pump-line` GeoJSON source.
- `calculatePumpRequirements()` uses `routedPathPoints` (falling back to the marker chain) instead of `distanceBetweenMultiplePoints` on straight lines → distance/elevation/pump positions reflect the real hose path. Everything downstream (`getPumpLocationMarkers`, popups, `calculationResult`) works unchanged since it consumes `ElevationPoint[]`.

**Add `resamplePolyline(points: GeoPoint[], stepM = ELEVATION_RASTER): { distanceM: number; points: GeoPoint[] }` to `src/helper/distanceCalculation.ts`:**
- Walks the polyline emitting points every `stepM` meters plus the endpoint. Replaces the pump flow's use of `distanceBetweenMultiplePoints`, which duplicates junction points (wasted elevation lookups) and returns km while everything downstream is meters. Routed grid legs are ~8 m spaced, so resampling to the 20 m raster also shrinks the point count.

## C. Hose-count labels between pump markers

**In `src/composable/pumpCalculation.ts`:**
- Convert the `pump-line` source data to a `FeatureCollection`: the LineString + one Point feature per segment.
- Segments come from cumulative distances after calculation: boundaries at `0, pump1.distanceFromStart, …, realDistance`. Per segment: `tubes = Math.ceil(segmentDistance / pumpStore.tubeLength)`; anchor the Point at the along-path midpoint of the segment (points are ~20 m spaced with known cumulative distance, so walk the resampled path).
- Add a `pump-line-label-layer` **symbol layer** in `setMap()`, copying the proven pattern from `MainMap.vue:1134` (`selected-path-label-layer`): `filter: ['==', ['geometry-type'], 'Point']`, `text-field: ['get', 'label']`, `text-offset [0,-0.9]`, `text-allow-overlap`, halo paint. Label text like `~7 B-Schläuche` via existing key `pumpCalculation.pump.tubes` + the configurable hose name (E).
- Labels cleared together with the line in the existing `watch(isActive)` cleanup and whenever markers move (recalculation invalidates them).

## D. Pump calculation review fixes (`src/helper/calculatePumpPosition.ts` + composable)

1. **`Math.round` → `Math.ceil` for hose counts** (`calculatePumpPosition.ts:111`, `pumpCalculation.ts:303` `updateTargetMarker`, `SupplyPipeCalculation.vue` `targetMarkerInfo`/`tubeCount`, and for consistency `NearbyMarker.vue:36` + `MainMap.vue` `formatPathDistance`). Rounding down under-provisions hoses — 55 m ≠ 2 B-tubes.
2. **`||` → `??` bug**: `prevElevation = lastPump?.elevation || elevations[0].elevation` (`pumpCalculation.ts:299`) treats elevation `0` (sea level / flat fallback) as missing.
3. **Non-progress guard** in the pump-placement backtrack (`calculatePumpPosition.ts:91-135`): on a cliff-steep segment where one 20 m step drops pressure from output below input, `pumpPlacementIndex` can land on the previous pump's index again → infinite loop (the pump point's stored pressure is never reset to `outputPressure`). Track the last placed pump index; if the backtrack doesn't advance past it, place at the current point instead.
4. **Delete the unused `flowRateAndPressureLostTable`** (decision: keep manual pressure-loss setting). Note: the flow-rate `ion-select` in `SupplyPipeCalculation.vue:153-168` already hardcodes the same value pairs and stays as-is.
5. **Drop pointless `async`** from `calculatePumpPosition`/`getPumpLocationMarkers` (no awaits) and the `console.log('Full Distance')` in the composable.
6. Move `usePumpCalculationStore()` out of the per-pump loop body (`calculatePumpPosition.ts:89`) — hoist to function top.

## E. Configurable hose settings (length, diameter, name)

**`src/store/pumpCalculationSettings.ts`:**
- `tubeLength` already exists (default 20 m) but has no UI. Add `tubeDiameter = 75` (mm) and `hoseName = 'B'` (short designation, e.g. European B-hose). Persist both via the existing Capacitor-Preferences pattern (`pumpCalc_*` keys, `loadSettings()` + auto-save `watch`).
- Diameter is stored/displayed but not yet used in the friction math — the manual pressure-loss setting covers that (per the earlier decision); it's ready for a future table wired by diameter+flow.

**`src/views/SettingsView.vue`:** new "Pump calculation" section (`ion-list-header` + items, following the existing Map section pattern): number inputs for hose length (m) and diameter (mm), text input for hose name. Bind directly to the pump store (it auto-saves), no `useSettings` composable changes needed.

**Replace every hardcoded `B-` prefix with `hoseName` from the store:**
- `src/components/NearbyMarker.vue:37` (`getBTubes`), `src/components/SupplyPipeCalculation.vue` (`pumpPositionInfo`, `targetMarkerInfo`, template line 207), `src/helper/calculatePumpPosition.ts:151` (pump popup), `src/composable/pumpCalculation.ts:311` (target popup), `MainMap.vue` `formatPathDistance`, and the new segment labels from section C.
- New i18n keys under `settings.pumpCalculation.*` (section title, hose length/diameter/name labels) in `en.json`/`de.json`.

## F. Validation against doctrine (HLFS `doc/f-iv_lernu_loeschwasserfoerderung_v003.pdf` + NÖ practice)

The app's per-20-m pressure simulation is the automated form of the doctrine's *grafisches Verfahren* (PDF Abb. 5) and its core physics already match:

| Doctrine | App | Verdict |
|---|---|---|
| `p_geo = H_geo / 10 m` (0.1 bar per m rise/fall, signed) | `pressure -= delta / 10` | ✅ matches |
| Friction proportional to hose length | `segment3D * pressureLost` (per-meter) | ✅ matches (3D length is even more accurate than map distance) |
| Min. input pressure `p_e ≥ 1.5 bar` at every booster pump | `inputPressure` default 1.5, pump placed before pressure falls below it | ✅ matches |
| Pump spacing @800 l/min, p_v 6.5 bar → ~640–650 m (Ablesetafel) | reproduced when output = 8 bar | ✅ matches |

Deviations to fix:

1. **Friction values (PDF Tab. 2)**: doctrine B-hose per 100 m: 400→**0.3**, 600→**0.6**, 800→**1.0**, 1000→**1.4**, 1200→**2.0**, 1600→**4.0** bar. The flow-rate select in `SupplyPipeCalculation.vue` uses 0.2/0.7/1.1/1.7/2.5/4.5 → align option values with Tab. 2 (drop the non-doctrine 200 l/min entry); default `pressureLost` 1.1 → **1.0**. (NÖ rule of thumb "B ≈ 1 bar/100 m @ 800 l/min" confirms.)
2. **Default output pressure 10 → 8 bar**: doctrine relay examples and the Ablesetafel assume `p_a = 8 bar` (10 bar is the DIN EN 1028 nominal maximum, not the planning value). Stays user-configurable.
3. **Nozzle pressure at the target is missing**: doctrine requires the *Brandstellenstrecke* to end with `p_St ≈ 5 bar` (Mehrzweckstrahlrohr; NÖ adds ~1 bar for the Verteiler) — the app only guarantees 1.5 bar at the fire object. New setting `targetPressure` (default **5 bar**) in the pump store + supply-pipe form; in `calculatePumpPosition` the pressure floor for the **final** point becomes `targetPressure` instead of `inputPressure` (same backtrack-and-place-pump mechanism). Target popup/panel then shows available vs. required pressure.
4. **`p_a = p + p_e`** (PDF §3.3): a booster pump adds its Förderdruck *on top of* the incoming 1.5 bar, so subsequent stretches get p_v = 8 bar (800 m spacing in Abb. 5), not 6.5 bar. After placing a booster pump, resume with `outputPressure + inputPressure` (the first pump at the suction point starts at plain `outputPressure`). Today's behavior is ~20 % conservative — doctrinally wrong, so fix it.
5. **Reserve material (PDF §9.1)**: 1 reserve B-hose per 100 m of line, 1 reserve pump per 4 pumps → show as "+N reserve" next to the hose/pump totals in `SupplyPipeCalculation.vue` (display only, not added to per-segment labels).

**Doctrine test cases for verification** (flat inputs, checkable by hand):
- PDF Beispiel 1: Q 800 (p_R 1.0), p_a 10, p_e 1.5, H_geo +15 m evenly → first pump at ~700 m.
- PDF Abb. 5: Q 800, p_a 8, flat → first pump ~650 m, subsequent spacing ~800 m (validates fix 4).
- Final stretch: with `targetPressure` 5 bar, flat, p_a 8 → last pump ≤ 300 m before the fire object.

## Files touched

- **new** `src/helper/demElevation.ts`
- `src/helper/elevationData.ts` — DEM-first chain
- `src/helper/distanceCalculation.ts` — `resamplePolyline`
- `src/composable/pumpCalculation.ts` — routed line, labels, resampled calc, fixes
- `src/helper/calculatePumpPosition.ts` — fixes (D)
- `src/store/pumpCalculationSettings.ts` — new `tubeDiameter`, `hoseName` settings (E)
- `src/views/SettingsView.vue` — new pump-calculation settings section (E)
- `src/components/SupplyPipeCalculation.vue` — hose-name usage, `Math.ceil` (D/E)
- `src/components/NearbyMarker.vue`, `src/components/MainMap.vue` — `Math.ceil` + hose-name consistency
- `src/locales/en.json` / `de.json` — `settings.pumpCalculation.*` keys; segment label reuses `pumpCalculation.pump.tubes`

## Verification

1. `npm run build` (type-check) + lint.
2. Dev server → supply-pipe page: place suction point and fire object across a building block; the line must follow roads/terrain like the nearby-marker path; toggle **clamp to roads** in settings and re-drag → geometry changes accordingly; add/drag/remove waypoints → per-leg re-routing.
3. Run the calculation: pump markers appear on the routed path; a `~N B-…` label sits between each consecutive pair (suction→pump1, pump1→pump2, …, lastPump→target); counts match popup values and use ceil.
4. Elevation: online with DEM reachable → values close to previous Open-Meteo numbers (spot-check a known slope); force DEM failure (block tiles.mapterhorn.com) → API fallback; DevTools offline **with** a downloaded area covering the line → real elevations from cached DEM (not flat, no "elevation ignored" hint); offline **without** cached tiles → flat fallback + hint, as today.
5. Leave/re-enter the supply-pipe route → all layers/labels cleaned up and restored (`restoreMapState`).
6. Settings: change hose length/diameter/name in Settings → tube counts and all `B-…` texts update accordingly (e.g. rename to `C`); values survive an app reload (Preferences persistence).