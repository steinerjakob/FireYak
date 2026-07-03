# Plan: Project Review — Data Fetching, Storage, UI/UX & Features

Review date: 2026-07-03 (branch `feature/upload-to-panoramax`, v2.13.0).
Scope: Overpass data fetching reliability, IndexedDB storage, UI/UX improvements, feature roadmap.

---

## 1. Data Fetching (Overpass API) — Review & Fixes

Current state (`src/mapHandler/overPassApi.ts`, `src/mapHandler/markerHandler.ts`):
cache-first with fire-and-forget background refresh, abort of superseded area
queries, primary (`overpass-api.de`) + fallback (`overpass.private.coffee`),
`null` return on failure so cached markers are never falsely deleted, and a
truncation guard (2000 elements) before reconciling deletions. This is a solid
foundation — the issues below are the likely causes of "Overpass sometimes
does not respond properly".

### 1.1 Use POST instead of GET with `encodeURI` (high priority)

- `fetch(baseUrl + '?data=' + encodeURI(query))` leaves `=`, `;`, `[`, `]`, `,`
  unencoded. Some proxies/instances mangle these; long queries can also hit URL
  length limits. Overpass officially recommends POST.
- Fix: `fetch(baseUrl, { method: 'POST', body: new URLSearchParams({ data: query }), signal })`.
- Apply to both `fetchWithFallback` and `fetchNodeById`.

### 1.2 Per-attempt timeout instead of one shared timeout (high priority)

- `AREA_QUERY_TIMEOUT_MS` (20 s) spans primary **and** fallback. If the primary
  hangs for 19 s, the fallback gets ~1 s → guaranteed failure exactly when the
  fallback is most needed.
- Fix: give each attempt its own timeout (e.g. 12 s primary, 12 s fallback) via
  `AbortSignal.any([userSignal, AbortSignal.timeout(ms)])`, keeping the outer
  "superseded by newer request" abort separate from the per-attempt timeout.

### 1.3 Handle 429/504 properly, add more fallbacks

- No `Retry-After` handling; a 429 from overpass-api.de currently just falls
  through to the single fallback.
- Add a small instance pool tried in order:
  `overpass-api.de` → `overpass.private.coffee` → `maps.mail.ru/osm/tools/overpass`
  (and/or `overpass.osm.jp`). Skip an instance for N minutes after a 429
  (simple in-memory cool-down map).
- Give `fetchNodeById` the same fallback chain (currently single-instance).
- Fix stale doc comment on `fetchMarkerData` (claims private.coffee is primary).

### 1.4 Freshness-based refresh instead of refetch on every moveend

- Today every debounced `moveend` fires a background Overpass query even when
  the area was fetched seconds ago — wasted load, more rate-limiting, more
  perceived flakiness.
- Fix: keep a "fetched areas" registry (bbox or slippy-tile keys at a fixed
  zoom, with `fetchedAt`). Skip the background refresh if the whole view was
  fetched within a TTL (e.g. 15 min). Pairs with the `fetchedAt` field in §2.1.
- Optionally pad the requested bbox by ~25 % so small pans stay within an
  already-fetched area.

### 1.5 Surface failures to the user (see also §3.1)

- `getMarkersForView` swallows all errors; on a failed fetch of an uncached
  area the spinner disappears and the map is silently empty.
- Fix: expose a `markerFetchFailed` ref next to `isLoadingMarkers`, show a
  toast/banner ("Water source data temporarily unavailable — showing cached
  data") with a retry button.

### 1.6 Guard very large bboxes

- The `zoom <= 9` guard doesn't cap area on wide desktop windows. Consider an
  area cap (e.g. max ~0.5° × 0.5°) or clamping the query bbox, so single
  queries can't time out server-side (`[timeout:15]`) on huge viewports.

---

## 2. Data Storage (IndexedDB) — Review & Fixes

Current state (`src/mapHandler/databaseHandler.ts`): single `fireMarker` store,
keyPath `id`, compound `lat, lon` index, soft-delete flag (`__deleted`),
reconcile-based hard delete. Works, but:

### 2.1 Add `fetchedAt` timestamp per node (DB version 2)

- Enables: the freshness TTL from §1.4, a "data age" indicator in the UI
  (§3.2), and cache pruning (§2.2).
- Migration: bump `openDB('FireMarker', 2)`, in `upgrade` add a `fetchedAt`
  index; existing rows get `fetchedAt = 0` (treated as stale).

### 2.2 Prune the cache

- The DB currently grows unboundedly as users pan around. Add a periodic prune
  (on app start): delete nodes with `fetchedAt` older than e.g. 90 days,
  and/or cap total row count (delete oldest first). Never prune nodes the user
  created/edited offline (once §5.2 exists).

### 2.3 Known quirks (low priority, document or fix opportunistically)

- The compound-key `IDBKeyRange.bound([s,w],[n,e])` over-scans: for compound
  keys the range is lexicographic, so all longitudes are included for interior
  latitudes. Correctness is saved by the `boundsContains` post-filter; at
  current data volumes this is fine. If it ever gets slow, switch to a
  geohash/tile-key index.
- The extra `store.createIndex('id', 'id')` is redundant (id is the keyPath) —
  drop it in the v2 upgrade.
- `id` collisions between nodes and ways are theoretically possible (OSM node
  and way ID spaces overlap). Consider `type/id` composite keys in v2, or
  accept the risk (collision odds are tiny for this dataset).

### 2.4 Token storage

- OSM/Panoramax tokens go through `@capacitor/preferences` (plain storage).
  Consider `capacitor-secure-storage` (Keychain/Keystore) on native. Low
  urgency — OSM tokens are limited-scope — but worth a note.

---

## 3. UI/UX Improvements

### 3.1 Error & offline feedback (highest UX priority)

- Toast/banner when Overpass fetch fails for an uncached area (see §1.5).
- Offline banner (navigator.onLine + Capacitor Network plugin): "Offline —
  showing cached water sources".

### 3.2 Cache transparency

- Show "data updated X min/days ago" for the visible area (needs §2.1), e.g.
  small chip near the attribution or in marker info.

### 3.3 Marker filtering & legend

- Filter chips (or a section in the layer selector modal): hydrants /
  suction points / water tanks / ponds / fire stations.
- A small legend explaining the marker icons (pillar vs. underground vs. wall
  hydrants are not obvious to new users).

### 3.4 Map interactions

- Long-press on the map to add a marker at that exact spot (today the + FAB
  drops the ghost marker at the screen center and it must be dragged).
- GPS accuracy circle around the user-location dot
  (`position.coords.accuracy` is already available in the watch callback).
- Distinguish non-functional sources visually (greyed icon for
  `disused:emergency=*` / negative `couplings`/status tags) — critical info in
  an emergency.

### 3.5 Operational niceties for firefighters

- Keep screen awake while the nearby-sources panel or supply-pipe calculation
  is active (`@capacitor-community/keep-awake`).
- Nearby sources: radius selector (500 m / 1 km / 2 km / 5 km) and type filter;
  currently hardcoded 2000 m in `getNearbyMarkers`.
- High-contrast / big-touch-target consideration (gloves, night, rain) — audit
  FAB sizes and list row heights.

### 3.6 Housekeeping

- README "For developers" table still says "Leaflet + marker clustering" —
  it's MapLibre GL now; Photos section doesn't mention Panoramax/Mapillary.
- ⚠️ `id_rsa_github_actions` / `.pub` sit untracked in the repo root — move
  them out of the repo and add a `.gitignore` rule so they can never be
  committed.

---

## 4. Additional Features (roadmap candidates)

### 4.1 Offline region download — data **and** map tiles (biggest operational win)

Goal: a brigade pre-downloads its district once and the app is **fully usable
offline**: base map renders, markers show, marker info opens, nearby-sources
works. Builds directly on §1.4/§2.1.

**a) Water source data**

- Draw/select a bbox (or circle around the fire station) → fetch all water
  sources via chunked Overpass queries → store in IndexedDB with `fetchedAt`
  and an `offlineArea` tag so pruning (§2.2) never evicts them.

**b) Base map tiles (required for "fully offline")**

Decided approach: **own tile store + MapLibre `addProtocol`** (pre-warming the
workbox caches was rejected — Cache Storage is subject to browser eviction,
`maxEntries: 500` is far too low for a district, and it couples offline
guarantees to the service worker).

- Enumerate slippy tile coordinates for the bbox (z0–z15, Protomaps vector
  maxzoom; MapLibre overzooms beyond that) and download each tile into
  IndexedDB (web) / Capacitor Filesystem (native).
- Tile source: the existing `api.protomaps.com` endpoint (same
  `VITE_PROTOMAPS_API_KEY`). Terms validated 2026-07-03 (protomaps.com/about,
  /api, docs): free for non-commercial use, soft limit 1 M tile requests per
  month — a district download (~800–900 tiles) is negligible against that, and
  offline pre-fetching is neither explicitly allowed nor forbidden. Their
  officially sanctioned offline path is extracting regions from the free daily
  planet builds (`pmtiles extract`, ODbL/OSM attribution) — i.e. the PMTiles
  refinement below. Recommended: email Protomaps to bless the prefetch
  pattern; switch to self-generated PMTiles extracts if usage grows.
- Register a custom protocol (e.g. `offline://`) via `maplibregl.addProtocol`
  that serves from local storage first and falls back to the network.
  Deterministic, eviction-safe, works identically in PWA and native builds.
- The map style's `protomaps` source must point at the `offline://` URL scheme
  in all flavors so online and offline rendering share one code path.
- Possible later refinement: download a single **PMTiles extract** per area
  and serve it with the `pmtiles` protocol from a local file — simplest
  bookkeeping, but requires an extract source (Protomaps API extracts or
  self-hosted), so it is not part of the initial implementation.
- Size estimate: vector tiles for a typical district bbox at z0–z15 are on
  the order of tens of MB — show the estimate before download and a progress
  bar during (tile count is known upfront).
- Also cache the **glyphs and sprites** (protomaps.github.io basemaps-assets)
  — without fonts, labels silently disappear offline.
- Satellite (ESRI raster) and terrain/hillshade (Mapterhorn) are optional
  per-area toggles; raster imagery is ~10× the size, default off.

**c) Graceful degradation of online-only features**

- Address search (Photon), elevation profile (Open-Meteo), and photo sources
  (Panoramax/Mapillary/Commons) need the network. Detect offline and disable
  these controls with a short hint instead of failing silently.
- Supply-pipe calculation: still allow it offline without elevation data
  (flat-terrain estimate, clearly labeled) or read elevations from downloaded
  terrain DEM tiles if the terrain layer was included in the area download.

**d) UI & management**

- Settings → "Offline areas": list of downloaded areas with name, size,
  last-refresh date; actions: refresh (re-fetch data + changed tiles),
  delete, and "include satellite/terrain" toggles per area.
- Refresh over Wi-Fi only by default (native: check connection type via
  Capacitor Network plugin).

### 4.2 Offline edit queue

- Edits/creates made without connectivity are queued locally and pushed as an
  OSM changeset when back online. (Store pending ops in a second IndexedDB
  store; badge in the UI showing pending count.)

### 4.3 Favorites / recent sources

- Star a hydrant (stored locally) and a "recently viewed" list — quick access
  to the sources a brigade actually uses for drills.

### 4.4 Survey / inspection mode

- One-tap "confirmed still exists" that updates `survey:date` on the node —
  low-friction way for brigades to keep OSM data fresh, distinct from full
  editing.

### 4.5 Routing instead of straight-line path

- The nearby-source path is a straight line; use a routing API (OSRM/Valhalla
  public instances or openrouteservice) for actual driving/walking distance,
  which also makes the B-hose estimate more realistic. Cache routes; fall back
  to straight line offline.

### 4.6 Hydrant density heat/coverage view (later)

- Visual coverage check for planning: circles of e.g. 150 m around hydrants to
  spot supply gaps in the district.

---

## 5. Suggested Implementation Order

| Phase | Items                                                                              | Rationale                                                                          |
| ----- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1     | §1.1 POST, §1.2 per-attempt timeouts, §1.3 fallback pool, §1.5+§3.1 error feedback | Directly addresses "Overpass sometimes doesn't respond"; small, low-risk changes   |
| 2     | §2.1 fetchedAt (DB v2), §1.4 freshness TTL, §2.2 pruning, §3.2 data age            | Cuts Overpass load (fewer failures) and makes cache trustworthy                    |
| 3     | §3.3 filters+legend, §3.4 long-press add, §3.5 keep-awake + nearby radius          | Fast UX wins                                                                       |
| 4a    | §4.1a+d offline **data** areas, §4.2 offline edit queue                            | Flagship feature groundwork; depends on phase 2                                    |
| 4b    | §4.1b offline **map tiles** (`addProtocol` tile store), §4.1c offline degradation  | Completes "fully offline"; largest single work item, ship after 4a proves the flow |
| 5     | §4.3–§4.6                                                                          | Nice-to-haves, prioritize by user feedback                                         |
