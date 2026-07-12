# Offline area review & editable download settings

> Extracted from `plans/offline-first-water-sources.md` Step 3 (region detail view) and expanded:
> besides reviewing what area a download covers, users can now **change the download settings**
> (satellite / terrain / auto-refresh) of an existing area after the fact.

## Context

Offline areas (`src/store/offlineAreasStore.ts`, list UI in `src/views/OfflineAreasView.vue`) can
currently only be renamed, refreshed, retried, cancelled, or deleted via an action sheet. Users
cannot see *what area* a download covers, and the three download options chosen in the add modal
(`includeSatellite`, `includeTerrain`, `autoRefreshOnWifi`) are frozen at creation — the only way
to change them is delete + re-download.

Scope of this plan:

1. **Per-area detail page** — mini-map showing the covered bounds + full metadata.
2. **Editable download settings** on that page — toggle satellite/terrain tiles and Wi-Fi
   auto-refresh on an existing area, including downloading newly enabled sources and freeing
   tiles of disabled ones.

**Non-goals**: editing the *bounds* of an existing area (workaround: delete + recreate; possible
follow-up), coverage overlay on the main map (stays in the parent plan, Step 2), per-status
styling.

## Step 1 — Shared composable + byte formatter

- **`src/composable/offlineAreaActions.ts`** extracted from `OfflineAreasView.vue`:
  `formatCount`, `formatDate`, `progressValue`, `downloadDetail`, `statusLine`
  (lines ~213–299), `promptRename`, `confirmDelete`, `showOfflineToast` (lines ~353–395) —
  reused by both views. `OfflineAreasView` keeps its action sheet (`openActions`) but calls the
  composable's helpers.
- Also move the **size-estimate helpers** there (or into `src/offline/tileMath.ts`):
  `AVG_TILE_BYTES` and the bytes-for-bounds estimate currently inline in `OfflineAreasView.vue`
  (lines ~432–456) — Step 3 reuses them to show the additional download size when enabling a
  source.
- **New helper** `formatBytes(bytes, locale)` in `src/helper/helper.ts` (none exists).

## Step 2 — Route + detail view

- **Route** in `src/router/index.ts` (after the existing `/settings/offline-areas` entry at
  line 46): `/settings/offline-areas/:id` → lazy `src/views/OfflineAreaDetailView.vue`.
- **`src/views/OfflineAreaDetailView.vue`**:
  - `await store.init()` in `onMounted` (idempotent) — the view must work on a cold-start deep
    link, not only when navigated from the list.
  - Back button (`default-href="/settings/offline-areas"`), title = area name. Area via
    `computed` lookup in `store.areas` by `Number(route.params.id)`; redirect back
    (`router.replace`) if missing (deleted). **Delete-race note**: the Delete action navigates
    back itself *and* nulls the computed, which also fires the missing-area redirect — use a
    `deleting` flag (or navigate before `removeArea` resolves) so only one navigation runs;
    `router.replace` keeps a double-fire harmless.
  - **Read-only mini-map** (~40vh): `maplibregl.Map({ interactive: false })` with an
    **`offline://`-based style** (NOT the add-modal picker's direct-API style — the detail page
    must render offline inside a downloaded region). Mirror `MainMap.vue:328–387`:
    `offline://assets/fonts/...` glyphs, `offline://assets/sprites/v4/{flavor}` sprite,
    `offline://protomaps/{z}/{x}/{y}` tiles + `protomapsLayers` with light/dark flavor from
    `useDarkMode()` (`src/composable/darkModeDetection.ts`). On load: GeoJSON polygon of
    `area.bounds`, fill (~0.12 opacity, primary color) + 2px line layers, `fitBounds` with
    padding 32, `duration: 0`. Destroy the map `onUnmounted`.
  - **Metadata rows**: status line, water sources (`nodeCount`), map tiles (`tileCount`),
    storage (`formatBytes(sizeBytes)`), created, last refreshed (or "never"). Progress bar while
    downloading/refreshing (reactive via store). Satellite/terrain/auto-refresh are NOT
    read-only rows — they are the editable toggles of Step 3.
  - **Actions**: Refresh (disabled offline/downloading), Rename, Delete (navigate back), Retry
    on `error`, Cancel while `isDownloading(id)` — all via `useOfflineAreasStore` + the Step 1
    composable.
- **`src/views/OfflineAreasView.vue`**: list items become `button :detail="true"` navigating to
  the detail route; the ellipsis action-sheet button gets `@click.stop`.

## Step 3 — Editable download settings

New "Download settings" section on the detail page with three toggles, backed by a new store
action.

### Store: `updateAreaSettings(id, patch)` in `offlineAreasStore.ts`

- **`autoRefreshOnWifi`**: just `persist(id, { autoRefreshOnWifi })`; when turning it **on**,
  also `void checkAutoRefresh()` so an already-overdue area refreshes immediately.
- **Enabling `includeSatellite` / `includeTerrain`**: `persist` the flag, then
  `runDownload(id, false)` (the resume path). Verified this works as "download only the new
  source":
  - Data phase no-ops: `downloadAreaData` starts at `lastCompletedChunk + 1`
    (`src/offline/areaDataDownloader.ts:110`), which equals `countChunks` for a `ready` area —
    the loop body never runs.
  - Tile phase: `tileResume` carries over on non-refresh runs
    (`offlineAreasStore.ts:172`), so already-downloaded sources fast-forward; only the newly
    enabled source starts at 0. `combinedTotal` is recomputed via `totalTilesFor` from the
    already-patched flags (`runDownload` re-reads the area from `areas.value`).
  - Guards: no-op when `isDownloading(id)`; UI disables the source toggles while
    downloading/refreshing and requires `isOnline` to *enable* (disabling works offline).
  - Accepted quirks (document in a code comment): the success path bumps `lastRefreshedAt`
    (`offlineAreasStore.ts:253`) even though no Overpass data was refetched; status passes
    through `downloading`, so the parent plan's coverage gate treats the area as uncovered for
    the duration of the source download (same regression window as a refresh).
- **Disabling a source**: confirm via alert first ("removes the downloaded satellite/terrain
  tiles"), then:
  - New `TileStore` method **`deleteAreaSource(areaId, source): Promise<{ refsRemoved: number;
    bytesFreed: number }>`** in both implementations in `src/offline/tileStore.ts` — same
    cursor over the `areaIds` multiEntry index as `deleteArea`, but skip keys that don't start
    with `` `${source}/` `` (key format `${s}/${z}/${x}/${y}`, `tileStore.ts:42`). `bytesFreed`
    counts only fully deleted blobs — tiles shared with an overlapping area keep their other
    refs and survive, matching `deleteArea` semantics.
  - Then `persist(id, { includeSatellite/includeTerrain: false, tileResume: <minus that
    source's key>, tileCount: tileCount - refsRemoved, sizeBytes: max(0, sizeBytes -
    bytesFreed) })`.
  - **Known imprecision** (note in code): `sizeBytes` accumulates only genuinely-new bytes at
    download time, and `bytesFreed` excludes shared tiles, so the counter can drift slightly
    across enable/disable cycles with overlapping areas. Acceptable for a storage *display*;
    a full recount is a follow-up if it ever matters.
  - Don't allow disabling while `isDownloading(id)` (the tile task iterates `tileJobsFor` from
    a snapshot; racing a delete against in-flight puts would resurrect refs).

### UI

- Section header `offlineAreas.detail.downloadSettings`; toggle labels reuse the add-modal keys
  `offlineAreas.add.includeSatellite` / `.includeTerrain` / `.autoRefresh` (+ its hint).
- **Satellite is not user-downloadable** (decided 2026-07-12): Esri's terms don't permit
  offline storage of World Imagery tiles, so the satellite toggle is removed from the add
  modal and shown in the detail view only when `area.includeSatellite` is already true —
  a removal-only escape hatch for legacy areas. The `includeSatellite` plumbing
  (store/tileStore) stays.
- **Terrain hint**: new key `offlineAreas.add.includeTerrainHint` ("Needed for the offline pump
  calculation — terrain tiles provide the elevation data.") rendered as the note line under the
  terrain toggle (same `<h3>`/`<p class="wrap-note">` label pattern as the existing auto-refresh
  row) in **both** the detail settings section and the add modal.
- Under each disabled source toggle, show the **estimated additional download** for enabling it
  (Step 1's shared estimate helpers + `formatBytes`), e.g. "≈ 30–50 MB".
- Progress bar (already on the page) reflects the source download; toggle stays disabled until
  it finishes.

### Add-modal default: terrain on

- `OfflineAreasView.vue` `openAddModal()` (line ~462): `includeTerrain.value = true` (satellite
  and auto-refresh stay `false`). New areas therefore include elevation data for the pump
  calculation unless the user opts out; the size-estimate line already reflects the toggle.

## Step 4 — i18n (`src/locales/en.json` + `de.json`)

- `offlineAreas.detail.*`: `waterSources`, `mapTiles`, `storage`, `created`, `lastRefreshed`,
  `neverRefreshed`, `downloadSettings`, `additionalDownload`,
  `removeTilesDialog.title` / `.message` / `.remove`.
- `offlineAreas.add.includeTerrainHint` — pump-calculation hint under the terrain toggle
  (shared by add modal and detail view); de: "Für die Pumpenberechnung offline erforderlich —
  Geländekacheln liefern die Höhendaten."
- Audit note carried from the parent plan: `common.*` only has `cancel`/`save`; the yes/no
  strings under `markerInfo.values.*` are domain-specific and must not be reused.

## Order of work

1. Step 1 (composable + `formatBytes`, pure refactor) → 2. Step 2 (route + detail view,
shippable alone as the review feature) → 3. Step 3 (`deleteAreaSource` + `updateAreaSettings` +
toggles) → 4. i18n per step.

## Verification

- `npm run lint` + `npm run build` after each step.
- Via the repo `verify` skill (headless app):
  1. **Detail view**: tap a list item → mini-map shows the fitted bounds rectangle, metadata
     populated; rename updates the title; delete navigates back exactly once; deep-link reload
     on the detail URL works.
  2. **Enable a source**: toggle satellite on a small `ready` area → status goes
     `downloading`, only satellite tiles are fetched (network/interception), `tileCount`/
     `sizeBytes` grow, area returns to `ready`.
  3. **Disable a source**: toggle satellite off → confirm dialog → `tileCount`/`sizeBytes`
     drop, re-enabling re-downloads; a protomaps-only pan inside the area still renders.
  4. **Auto-refresh**: toggle on an area with `lastRefreshedAt` older than 30 days →
     refresh starts (Wi-Fi/unknown connection).
  5. **Offline**: inside a downloaded region with network blocked, the detail page renders
     (mini-map from `offline://`); source-enable toggles are disabled, source-disable and
     auto-refresh still work.
  6. **Terrain default**: opening the add modal shows the terrain toggle pre-enabled with the
     pump-calculation hint; the size estimate includes terrain; toggling it off is respected on
     download.

## Risks / follow-ups

- Bounds editing is out of scope — delete + recreate remains the path; a "duplicate with new
  bounds" action is a cheap future improvement.
- `sizeBytes` drift with overlapping areas (see Step 3) — follow-up: recount from tile store.
- While a source download runs, the area is `downloading` and the parent plan's cache-only
  gate falls back to live fetch (same as refresh) — covered by the parent plan's
  `refreshing && nodeCount > 0` fast-follow if that lands.
