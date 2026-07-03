# Plan: Full Offline Mode (Phases 4a + 4b)

Detailed implementation plan for the offline features outlined in
`project-review-improvements.md` §4.1/§4.2. Written 2026-07-03.

**Goal:** a fire brigade pre-downloads its district once and FireYak is fully
usable without connectivity: base map renders, water source markers show,
marker info opens, nearby-sources works, and edits made offline are synced to
OSM later.

**Prerequisites (already planned/implemented in the phase 1–3 stack):**

- Overpass instance pool + POST + bbox clamp (`feature/overpass-reliability`)
- `fetchedAt` per node, DB v2, freshness registry (`feature/cache-freshness`)
- Network/offline detection groundwork (`feature/fetch-error-feedback`)

**Decided approach for tiles:** own tile store + `maplibregl.addProtocol`
(Option B — see §4.1b of the review plan). Tile source is the existing
`api.protomaps.com` endpoint; PMTiles extracts are a later refinement if
quota/terms ever require it.

---

## Part 1 — Phase 4a: Offline data areas + edit queue

### 1.1 Data model (IndexedDB, bump `FireMarker` DB to v3)

New object stores:

```
offlineAreas   keyPath: 'id' (autoIncrement)
  { id, name, bounds: {south, west, north, east},
    createdAt, lastRefreshedAt,
    includeSatellite: boolean, includeTerrain: boolean,
    nodeCount, tileCount, sizeBytes,
    status: 'downloading' | 'ready' | 'error' | 'refreshing',
    progress: { done, total } }

pendingEdits   keyPath: 'localId' (autoIncrement)
  { localId, action: 'create' | 'update' | 'delete',
    elementType: 'node',
    osmId,            // negative temp ID for creates (-1, -2, …)
    baseVersion,      // OSM version the edit was based on (update/delete)
    tags, lat, lon,
    createdAt, status: 'pending' | 'uploading' | 'conflict' | 'error',
    errorMessage? }
```

Marker nodes themselves stay in the existing `fireMarker` store. **Pruning
rule change:** the startup prune (§2.2 of the review plan) must skip nodes
whose coordinates fall inside any `offlineAreas.bounds` — membership is
computed by bounds check, no per-node area bookkeeping needed.

### 1.2 Area data download (`src/offline/areaDataDownloader.ts`)

- Input: bbox (drawn on map or radius around a point, see §1.5).
- Split the bbox into chunks no larger than the Overpass clamp (0.25°×0.25°
  to stay well inside it), fetch sequentially through the existing
  `fetchMarkerData` instance pool with a small delay (~1 s) between chunks to
  be polite to Overpass.
- Per chunk: `storeMapNodes` (sets `fetchedAt`), update
  `offlineAreas.progress`.
- Chunk failure → retry ×2, then mark the area `error` with resume support
  (store the chunk index; "Retry" continues, doesn't restart).
- Refresh = same flow; reconcile deletions per chunk with the existing
  truncation-guarded `reconcileDeletedNodes`.

### 1.3 Offline edit queue (`src/offline/editQueue.ts`)

Current behavior: `markerEditStore.saveMarker()` / `deleteMarker()` upload a
changeset immediately via `osm-api` and fail hard offline.

- **Enqueue path:** when offline (or upload fails with a network error),
  write a `pendingEdits` record instead of failing:
  - create → temp negative `osmId`, insert node into `fireMarker` cache so it
    renders immediately (optimistic).
  - update → apply new tags/position to the cached node, keep `baseVersion`.
  - delete → soft-delete in cache (existing `__deleted` flag), enqueue.
- **Sync engine** (runs on: app start, network regained, manual "Sync now"):
  - Process queue in FIFO order; group into one changeset per sync run
    (comment: "FireYak offline sync").
  - Creates: after OSM returns the real ID, remap the cached node
    (delete temp-ID record, store under real ID) and update any later queue
    entries referencing the temp ID.
  - Updates/deletes: fetch current version first; if server version !=
    `baseVersion` → mark `conflict`, do NOT auto-overwrite. Conflict UI lets
    the user view server state and choose "apply mine anyway" / "discard".
  - Deleting an already-deleted node → treat as success, drop the entry.
- **UI:** badge with pending count (e.g. on the settings FAB / in
  SettingsView), a "Pending changes" list (per entry: type icon, tags
  summary, retry / discard), toast on successful sync.
- Queue entries and their cached nodes are exempt from pruning.

### 1.4 Network status service (`src/composable/networkStatus.ts`)

- Add `@capacitor/network` (works on web too, wraps `navigator.onLine` +
  events; on native also reports connection type for the Wi-Fi-only rule).
- Exposes `isOnline`, `connectionType`, and an `onOnline(cb)` hook used by
  the sync engine and the offline banner (fold the phase-2 banner logic into
  this composable if it used bare `navigator.onLine`).

### 1.5 UI — offline area management

- **Settings → "Offline areas"** (`src/views/OfflineAreasView.vue`, route
  `/settings/offline-areas`):
  - List of areas: name, size, node/tile counts, last refresh, status,
    progress bar while downloading; actions: refresh, rename, delete.
  - "Add area" → map picker mode: reuse `MainMap` with a rectangle overlay
    the user pans/zooms into place ("download current view"), plus a radius
    preset around the fire station/current location (2/5/10 km). Show the
    size estimate before starting (see Part 2 §2.6).
  - Per-area toggles at creation: include satellite, include terrain
    (default off).
- Refresh policy: manual always; "auto-refresh on Wi-Fi when older than 30
  days" as a per-area toggle (native checks `connectionType === 'wifi'`).
- i18n: all new strings in `src/locales/en.json` + `de.json`.

---

## Part 2 — Phase 4b: Offline map tiles

### 2.1 Tile store abstraction (`src/offline/tileStore.ts`)

```ts
interface TileStore {
	get(source: string, z: number, x: number, y: number): Promise<Blob | null>;
	put(source: string, z: number, x: number, y: number, data: Blob): Promise<void>;
	deleteArea(areaId: number): Promise<void>;
	sizeBytes(): Promise<number>;
}
```

- **Web:** IndexedDB (separate DB `FireTiles`, store `tiles`, key
  `"{source}/{z}/{x}/{y}"`, value `{ blob, contentType, fetchedAt, areaIds:
  number[] }`). Call `navigator.storage.persist()` when the first area is
  downloaded to opt out of best-effort eviction.
- **Native:** Capacitor Filesystem under `Directory.Data`
  (`offline-tiles/{source}/{z}/{x}/{y}.bin`) with a lightweight IDB index for
  `areaIds`/size bookkeeping — avoids WKWebView IndexedDB size pressure on
  iOS.
- `areaIds` is the ref-count: deleting an area removes its id from each tile
  and deletes tiles whose list becomes empty (overlapping areas share tiles).

### 2.2 Custom protocol (`src/offline/offlineProtocol.ts`)

- Register once at app start: `maplibregl.addProtocol('offline', handler)`.
- URL scheme: `offline://{source}/{z}/{x}/{y}` with `source ∈ {protomaps,
  satellite, terrain}`.
- Handler: tile store hit → return blob; miss → fetch from the real network
  URL (template per source); if the tile lies inside a downloaded area,
  write-through into the store (keeps areas warm); network failure + no
  cached tile → return empty tile response (MapLibre renders gaps instead of
  erroring).
- **Style change in `MainMap.vue` (`getProtomapsStyle`)**: the `protomaps`
  source switches from the TileJSON `url:` form to an explicit
  `tiles: ['offline://protomaps/{z}/{x}/{y}']` template with hardcoded
  `minzoom: 0, maxzoom: 15` and attribution — one code path for online and
  offline. (TileJSON metadata can't be fetched offline, so it must be
  inlined.) Same pattern for the satellite and terrain sources when enabled.
- **Glyphs & sprites:** MapLibre allows custom protocols for these too.
  Route `glyphs`/`sprite` through `offline://assets/...` with write-through
  caching; the area download additionally prefetches the sprite JSON/PNG
  (@1x + @2x) and the glyph ranges actually used by the style's fonts
  (`Noto Sans Regular/Medium/Italic`, ranges 0–255 at minimum plus the
  ranges for the app locales).

### 2.3 Tile math (`src/offline/tileMath.ts`)

- Slippy tile helpers: `lngLatToTile(z)`, `tilesForBounds(bounds, zMin,
  zMax)` (iterator, not array — z15 lists can be large), `tileCount(bounds,
  zMin, zMax)` for estimates.
- Zoom ranges: protomaps vector z0–15 (MapLibre overzooms past 15); satellite
  raster capped at z17 (size!); terrain DEM z0–12 (Mapterhorn maxzoom
  actually used by hillshade/terrain — verify at implementation time).

### 2.4 Tile download manager (`src/offline/tileDownloader.ts`)

- Enumerate tiles for the area bounds per enabled source, skip tiles already
  in the store (just add the `areaId` ref), fetch with a concurrency limit
  of ~6 and abort support (pause/cancel from the UI).
- Progress reporting into `offlineAreas.progress` (tile phase after data
  phase); resumable: persist the last completed z-level/index.
- Handle 429/5xx from the tile CDN with exponential backoff.
- Update `sizeBytes` incrementally (`blob.size`).

### 2.5 Offline degradation of online-only features

- Address search (Photon): disable the search bar input with an inline
  "unavailable offline" hint when `!isOnline`.
- Photos (Panoramax/Mapillary/Commons): hide the gallery section with a hint
  instead of empty loading states.
- Elevation (Open-Meteo) in the supply-pipe calculator:
  - offline default: flat-terrain estimate with a clearly visible
    "elevation ignored (offline)" label;
  - stretch goal: if the area includes terrain, decode elevations from the
    downloaded Terrarium-encoded DEM tiles (`elevation = (R*256 + G + B/256)
    - 32768`) in `src/helper/elevationData.ts` as an offline provider.
- OSM edits: covered by the edit queue (Part 1).

### 2.6 Size estimation (shown before download)

- Vector: `tileCount(z0–15) × ~45 KB` average; satellite `tileCount(z0–17) ×
  ~25 KB`; terrain `tileCount(z0–12) × ~35 KB`. Calibrate the averages with
  a few real districts during implementation and show a range, not a fake
  exact number.
- Typical 20×20 km district, vector only: ~800–900 tiles ≈ 30–50 MB.

### 2.7 Protomaps quota & terms

- Validated 2026-07-03: hosted API is free for non-commercial use, soft limit
  1M tile requests/month; offline pre-fetching neither explicitly allowed nor
  forbidden. Action item before release: short email to Protomaps describing
  the pattern (open-source emergency-services app, per-user district
  prefetch). Fallback path if needed: self-generated PMTiles extracts from
  the free daily builds (`pmtiles extract`), served per district — the
  `TileStore`/protocol abstraction keeps this swappable.

---

## Part 3 — Implementation order & branch plan

Stacked branches continuing the phase 1–3 stack:

| #   | Branch                          | Content                                                               | Depends on |
| --- | ------------------------------- | --------------------------------------------------------------------- | ---------- |
| 1   | `feature/network-status`        | §1.4 `@capacitor/network` composable, fold in offline banner           | phase 2    |
| 2   | `feature/offline-areas-data`    | §1.1 DB v3, §1.2 area data downloader, §1.5 management UI (data only)  | 1          |
| 3   | `feature/offline-edit-queue`    | §1.3 queue + sync engine + conflict UI + badge                         | 1          |
| 4   | `feature/offline-tile-store`    | §2.1 store, §2.2 protocol + style switch, §2.3 math (write-through only)| 1          |
| 5   | `feature/offline-tile-download` | §2.4 downloader wired into areas UI, §2.6 estimates, glyphs/sprites    | 2 + 4      |
| 6   | `feature/offline-degradation`   | §2.5 search/photos/elevation degradation                               | 1          |

Branch 4 is intentionally shippable before 5: switching the style to the
`offline://` protocol with write-through caching already makes previously
viewed areas render offline, without any download UI.

## Part 4 — Testing checklist

- Airplane-mode walkthrough on Android + iOS + PWA: map renders in a
  downloaded area, markers tap-able, nearby-sources works, edit → queued →
  badge → sync after reconnect.
- Create-offline → sync → verify real OSM ID replaces temp ID and the marker
  survives a cache refresh.
- Conflict path: edit a node offline, change it on osm.org meanwhile, sync →
  conflict entry, both resolutions work.
- Overlapping areas: delete one, shared tiles must survive; delete both,
  store size returns to ~0.
- Download interruption (kill app mid-download) → resume works.
- iOS storage: verify Filesystem-backed tiles survive OS storage pressure;
  web: verify `navigator.storage.persist()` is requested.
- Quota sanity: one district download stays in the low thousands of tile
  requests (log the count in dev builds).
