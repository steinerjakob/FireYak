# AI Agent Project Guide: FireYak

This document provides a comprehensive overview of the FireYak project for AI-assisted development. It outlines the project's purpose, technologies, structure, and key commands to ensure efficient and consistent collaboration.

## 1. Project Overview

FireYak is a hybrid mobile and web application designed for firefighters and emergency response teams. Its primary function is to display a map of nearby water sources (such as fire hydrants, suction points, water tanks, fire water ponds and fire stations) fetched from the OpenStreetMap (OSM) database via the Overpass API. It also includes specialized tools for calculating water supply logistics, such as pump positioning and pressure loss over distance.

- **Website:** [app.fireyak.org](https://app.fireyak.org)
- **iOS App ID:** `6759717059` (Bundle: `org.jst.fireyak`)
- **Android Package:** `at.jst.fireyak`
- **Languages:** English, German

## 2. Core Technologies

- **Framework**: Vue.js 3 (Composition API, `<script setup>`)
- **UI Components**: Ionic for Vue (Material Design 3 theme, optional iOS 26 glass theme via `@rdlabo/ionic-theme-ios26`)
- **Build Tool**: Vite
- **Mobile Wrapper**: Capacitor (iOS + Android)
- **Mapping**: MapLibre GL (`maplibre-gl`) with Protomaps vector tiles (`@protomaps/basemaps`, custom flavors in `src/map/`); optional satellite raster layer and Mapterhorn DEM terrain/hillshade; all tile sources are routed through the `offline://` protocol for cache-first/offline rendering
- **State Management**: Pinia
- **Routing**: Vue Router (Ionic Router)
- **Data Source**: OpenStreetMap via Overpass API (with a native Capacitor transport for mobile), address search via Photon
- **Local Storage**: IndexedDB (via `idb`) for marker caching, offline areas, tiles, and the pending-edits queue; Capacitor Preferences for settings
- **Internationalization**: vue-i18n (English + German)
- **Image Gallery**: PhotoSwipe (Wikimedia Commons and Panoramax images)
- **Elevation Data**: Mapterhorn terrain DEM tiles (same offline-capable pipeline as the map), used for pump calculation and routing
- **OSM Editing**: osm-api with OAuth2 PKCE; edits queue offline and sync when back online
- **In-App Review**: `@capacitor-community/in-app-review`, gated by a usage-based composable
- **Styling**: SCSS, Material Design 3 custom theme
- **Code Quality**: ESLint, Prettier, Stylelint, Commitlint (Conventional Commits), Husky + lint-staged, `vue-tsc` type check
- **Testing**: Vitest (Node environment) for pure modules; routing scene specs read real map tiles from `src/mapHandler/__fixtures__/routing/`
- **Changelog/Release Tooling**: git-cliff (CHANGELOG.md generation), custom `scripts/stamp-whats-new.mjs`
- **CI/CD**: GitHub Actions (GitHub Pages deploy, Google Play via Fastlane, TestFlight via Fastlane, unified release pipeline)

## 3. Project Structure

### `src/` directory

```
src/
├── assets/          # Static assets (marker icons, images, whats-new.json)
├── components/      # Reusable Vue components
├── composable/      # Vue Composition API hooks (stateful logic)
├── helper/          # Pure utility functions
├── locales/         # i18n translation files (en.json, de.json)
├── map/             # Protomaps style "flavors" (color themes) per map layer
├── mapHandler/      # Map data fetching, marker management, routing, caching
├── offline/         # Offline mode: tile download/store, area data, edit queue, offline:// protocol
├── plugins/         # Vue plugin registration (Pinia, Router, Ionic, i18n)
├── router/          # Route definitions
├── services/        # External auth service integration (OSM OAuth) and OSM endpoint config (`osmConfig.ts`)
├── store/           # Pinia stores
├── testing/         # Test-only helpers for specs (fixture loading, tile decoding); never imported by app code
├── theme/           # SCSS variables and Material Design 3 CSS overrides
├── types/           # Shared TypeScript types (geo, obstacles)
├── views/           # Top-level page components
├── workers/         # Web Workers (`hoseRouting.worker.ts`: the hose routing solve, a thin shell over `mapHandler/hoseRoutingProtocol.ts`)
├── App.vue          # Root component
└── main.ts          # Application entry point
```

### Stores (`src/store/`)

| File | Purpose |
|---|---|
| `index.ts` | Pinia instance initialization |
| `defaultStore.ts` | Tracks visible map dimensions, safe areas, responsive layout state |
| `mapMarkerStore.ts` | Fetches/caches fire-related markers from OSM and local IndexedDB |
| `markerEditStore.ts` | Handles marker editing/adding/delete state; uploads via osm-api or queues offline via `editQueue.ts` |
| `offlineAreasStore.ts` | Manages downloaded offline map areas (download/refresh/delete, size estimates, auto-refresh) |
| `osmAuthStore.ts` | OAuth2 PKCE authentication with OpenStreetMap |
| `pendingEditsStore.ts` | Reactive facade over the offline edit queue; exposes pending edits and sync-now |
| `pumpCalculationSettings.ts` | Pump calculation parameters (incl. max. hose working pressure) with Preferences persistence |
| `settingsStore.ts` | Theme, map layer (standard/satellite), terrain 3D toggle, hose routing mode (`hoseRouting`: `optimized` by default, `roads` with the "keep on roads" toggle), the one-time cross-country note flag (`crossCountryNoteSeen`), the routing cache budget (`routingCacheMb`, default 50 MB; `App.vue` applies it), marker filters, zoom button visibility, system bar styling |

### Composables (`src/composable/`)

| File | Purpose |
|---|---|
| `crossCountryNote.ts` | The one-time "check cross-country stretches on site" toast for the first hose line with an off-road stretch (flag persisted in Preferences) |
| `darkModeDetection.ts` | Read-only reactive "is the dark palette active" flag (view of `settingsStore`) |
| `inAppReview.ts` | Tracks active usage days and triggers the one-shot native in-app review prompt |
| `modalBreakpointWatcher.ts` | Tracks Ionic modal breakpoint state changes |
| `nearbyWaterSource.ts` | Reactive list of nearby water sources, ranked by routed hose length (straight line for unrouted ones); `applySilentUpdate` takes a recompute after late routing data (metres in place with a short highlight, re-sorted once the list is not touched) |
| `networkStatus.ts` | Singleton reactive online/offline status shared across the app |
| `photonSearch.ts` | Address/place search against the Photon geocoding API |
| `pumpCalculation.ts` | Relay pump calculations (waypoints, elevation, pump positioning) |
| `screenDetection.ts` | Mobile/desktop breakpoint detection (768px) |
| `screenOrientation.ts` | Device orientation monitoring via Capacitor |
| `settings.ts` | Loads/saves persistent settings via Capacitor Preferences (incl. the one-time hose routing migration write-back) |
| `systemColorScheme.ts` | Single source of truth for the OS `prefers-color-scheme` preference; re-polls on every foreground transition because Android's WebView drops the `change` event while backgrounded |
| `whatsNew.ts` | Loads `whats-new.json`, tracks last-seen app version, drives the What's New modal |

### Helpers (`src/helper/`)

| File | Purpose |
|---|---|
| `appStoreInfos.ts` | App Store / Play Store URLs for the current app |
| `areaShore.ts` | Outline geometry for water areas: nearest shore point, point-in-area, outline bounds |
| `calculatePumpPosition.ts` | Optimal pump positioning along routes (pressure/elevation/flow) |
| `demElevation.ts` | Main-thread entry to `demTiles.ts`: wires it to the cache-first `offline://` tile pipeline and re-exports it |
| `demTiles.ts` | Elevation sampling from the Mapterhorn terrain DEM tiles (offline-capable, replaces Open-Meteo) with a decode LRU and an injected tile fetcher (no app I/O import, so it also runs in the routing worker); route profiles try z14 within a budget, else z12; `loadRoutingHeights` loads the `optimized` grid's height raster (z14, else z12, within the routing DEM budget) |
| `demRaster.ts` | Pure DEM helpers: terrarium decode, bilinear sampling across tile edges, the cost grid's height raster (`buildHeightRaster`: one-cell halo, 3×3 smoothing) and step grades (`stepGrade`: per step on z14, 24 m baseline on z12) |
| `distanceCalculation.ts` | Haversine distance + geodetic point interpolation (20m intervals) |
| `elevationData.ts` | Batch elevation fetching helper (legacy/fallback path) |
| `helper.ts` | Debounce utility |
| `nearbyListMerge.ts` | Pure merge of a silent recompute into the nearby list (order kept while the list is in use, changed entries reported) |
| `routingBudget.ts` | The non-blocking contract of hose routing: `ROUTING_DATA_BUDGET_MS` (1.5 s) as an `AbortSignal`, `budgetedFetch` (wait raced against the budget; an aborted signal means local stores only) |
| `hosePressure.ts` | Downhill static-pressure rule against the max. hose working pressure; hydrant pressure parsing |
| `hoseRoutingSetting.ts` | Hose routing mode type (`optimized` \| `roads`) and the pure migration from the old `clamp_hoses_to_roads` key and the removed `direct` mode (`resolveHoseRouting`: written back once, old key removed); toggle mapping (`modeFromToggle`) |
| `polygonGeometry.ts` | Exact segment/polygon tests (edge intersection, containment, holes) used by route smoothing |
| `routeLabel.ts` | Route label line (estimate prefix, hoses, signed climb, off-road metres, road-only length when > 15 % off) and the warning/fallback/coverage chips shared by the nearby list, map label and pump panel; when the one-time cross-country note is due |
| `routeProfile.ts` | Steep (>25 %/>50 %) and off-road runs of a route, slope "not recommended" triggers, the 3D length (`length3d`) that is the reported metres, the 6 m road proximity test (`isNearAnyRoad`) |
| `osmElement.ts` | Node vs. area (way/relation) helpers for editing: cache shape, fire-pond flag/unflag, changeset wording |
| `tileMath.ts` | Minimal Web-Mercator slippy-tile helpers used by the tile-freshness registry |

### Map Handlers (`src/mapHandler/`)

| File | Purpose |
|---|---|
| `databaseHandler.ts` | IndexedDB wrapper for marker caching, offline areas, pending edits, and spatial queries |
| `gridRouting.ts` | Cost-grid routing for hose laying over the `hoseCostModel.ts` classes (symmetric step cost, escape radius, A* for single paths, early-exit Dijkstra for the list, cost-aware smoothing; with a height raster each step is also priced by its slope, capped ×1.3 on roads/paths/steps, 1.0 on bridges, and a bridge connects only to roads/paths/steps) |
| `costGrid.ts` | Pure rasteriser of the `optimized` grid: scanline polygon fill and supercover lines, drawn in the cost model's order (landuse, water, buildings, walls, roads, bridges); on grids finer than 8 m ways are drawn 8 m wide over open ground and landuse; `routableRoads` drops what `classifyRoad` excludes |
| `cellHeap.ts` | Typed-array binary min-heap (cost, cell) used by the grid searches |
| `markerHandler.ts` | Creates MapLibre markers with type-specific icons, manages cache |
| `markerImageHandler.ts` | Fetches marker photos from Wikimedia Commons and Panoramax |
| `nearbyRouting.ts` | Main-thread facade of hose routing (nearby list, marker path, pump line): runs the solve in the routing worker, fetching tile bytes cache-first and transferring them; falls back to the same solve on the main thread when no worker starts; a request `channel` lets a newer request supersede (cancel) the running one (`RoutingCancelledError`) |
| `hoseRoutingCore.ts` | The hose routing solve (pure, I/O injected via `configureRoutingIO`; runs in the worker and on the main thread): `RoutingOptions.mode` `optimized` (default) or `roads`, adaptive cell size (`chooseCellSize`: 4/6 m single paths, 8 m list, 400k cell cap), returns a `HoseRoute` (one length, 3D over the DEM profile, steep/off-road runs, warnings, surfaced fallbacks incl. thin building data, coverage) |
| `hoseRoutingProtocol.ts` | Message protocol between main thread and routing worker: `serveHoseRouting` (worker side), `HoseRoutingClient` (main side: requests, supersession, tile/DEM-decode service), `transferablesOf` |
| `hoseCostModel.ts` | Pure cost model for hose routing (drives the `optimized` grid and road-mode shore legs): cell classes and factors, `classifyRoad`/`classifyRail`/`classifyLanduse`/`classifyWaterLine`, `slopeFactor`, the thin-buildings test, UI warning thresholds |
| `obstacleDecode.ts` | Pure decoder (bytes in, data out) of Protomaps tiles: buildings, roads with `kind_detail`/bridge/tunnel/access, rail, landuse, water polygons and lines, cliffs, per-tile residential/building area (thin-buildings safeguard); runs in Node specs and workers |
| `obstacleGeometry.ts` | Main-thread entry to `obstacleTiles.ts` with the routing fetcher (`fetchRoutingTile`) as default (`getObstaclesForBounds`, `waterOutlineAt`) |
| `obstacleTiles.ts` | Collects z15 Protomaps tiles through an injected fetcher and merges `obstacleDecode.ts` results (LRU, per-layer coverage); missing tiles are reported, never cached as empty; no app I/O import (runs in the routing worker) |
| `overPassApi.ts` | Queries Overpass API (web fetch or native transport) for emergency infrastructure within bounds |
| `roadRouting.ts` | Shortest-path routing over decoded road centerlines for hose-laying distance to a marker (shore targets with 250 m final legs, priced per target) |
| `routeLayers.ts` | MapLibre layers for a route: solid/dashed (off-road) runs coloured by steepness, ticks on very steep runs; `pulseRouteLayers` (width pulse after a silent recompute) |
| `routingData.ts` | `routingDataArrived` (late basemap/DEM tiles and pond outlines, coalesced), `RouteFreshness` (recompute when a result was incomplete and data landed since), `isRouteDataComplete` |
| `routingDebug.ts` | Pure helpers (route stats, ring-simulation ratio table, cost raster, height/slope raster, per-class area/length summary) for the dev-only routing debug view |
| `__fixtures__/routing/` | Test data for the routing specs: five real scenes (`scene.json` committed, tiles gitignored and fetched locally, README there). Never import from app code |
| `waterDetection.ts` | Protomaps `water` layer pre-check under the edit pin (water/no water, pond vs. large; no OSM ids) |
| `areaOutline.ts` | Session cache + Overpass `out geom` lookup for pond-area outlines (map highlight) |
| `waterSourceAccess.ts` | Where a hose reaches a water source: a mapped suction point at a pond, else the whole shore as a routing goal (outline from the extract, else the Protomaps water polygon; Overpass only in the background) |

### Offline mode (`src/offline/`)

| File | Purpose |
|---|---|
| `areaDataDownloader.ts` | Downloads Overpass node data for a selected offline area, chunked to stay under API limits |
| `editQueue.ts` | FIFO offline edit queue + sync engine; drains on reconnect, app start, or manual sync |
| `areaSizeEstimate.ts` | Pure per-zoom download size estimates for offline areas (terrain z0–12 + routing DEM z14) |
| `offlineProtocol.ts` | Registers the `offline://` MapLibre protocol; wires `tileFetchers.ts` to the app's stores (`fetchTileCacheFirst` for the map, `fetchRoutingTile`/`prefetchTile` for hose routing) |
| `precachePolicy.ts` | Pure precache rules (GPS ring 2 km / 500 m, map move zoom ≥ 14 + 1.5 s idle + Wi-Fi, none offline/saveData) and `FetchQueue` (3 per source, priorities, preemption) |
| `routingCache.ts` | `FireRoutingCache` IndexedDB store for routing/precache tiles (byte budget LRU, TTL), separate from downloaded areas |
| `routingCacheIndex.ts` | Pure LRU-by-bytes and TTL (basemap 30 d, DEM 180 d) bookkeeping of the routing cache |
| `routingPrefetch.ts` | The three precache triggers wired to the app (selected route/pump window, GPS ring, map view on Wi-Fi) |
| `tileFetchers.ts` | Cache-first lookups with injected I/O: area store, then routing cache, then network; routing results fill the routing cache and report `routingDataArrived` |
| `tileDownloader.ts` | Parallel tile + style-asset fetcher with retry/backoff, used for offline area downloads (per-source zoom lists; terrain includes z14) |
| `tileMath.ts` | Web-Mercator tile math shared by the downloader, size estimator, and offline protocol |
| `tileStore.ts` | Persistent store for downloaded tiles/style assets (IndexedDB on web, filesystem on native) |

### Components (`src/components/`)

| File | Purpose |
|---|---|
| `AddressSearchBar.vue` | Search bar (Photon geocoding) with attached info/settings buttons, mobile-aware layout |
| `LayerSelectorModal.vue` | Popover for choosing map layer (standard/satellite), terrain 3D, and marker filters |
| `MainMap.vue` | Central MapLibre GL map (Protomaps vector tiles, satellite/terrain layers) with FAB controls and dark mode styling |
| `MarkerEdit.vue` | Edit form for marker tags with OSM login requirement |
| `MarkerEditHeader.vue` | Header with save/cancel buttons |
| `MarkerEditPanel.vue` | Modal panel for adding/editing markers |
| `MarkerInfo.vue` | Displays selected marker properties (type, pressure, flow, etc.) |
| `MarkerInfoHeader.vue` | Header with title and action buttons (navigate, share, edit) |
| `MarkerInfoPanel.vue` | Bottom sheet wrapper for MarkerInfo |
| `NativeAppInstallPrompt.vue` | Modal nudging mobile web users to install the native app |
| `NearbyMarker.vue` | List item showing nearby source with distance + B-tube count |
| `NearbyMarkerHeader.vue` | Header for nearby markers section |
| `NearbyMarkerPanel.vue` | Bottom sheet listing nearby water sources within radius |
| `PondAreaCandidates.vue` | Add-mode list of OSM water areas at the pin: mark an existing pond, edit an existing fire pond, or suggest a suction point |
| `ReloadPrompt.vue` | PWA update notification with reload button |
| `SupplyPipeCalculation.vue` | Pump supply line UI (suction/fire points, waypoints, profile) |
| `SupplyPipeCalculationHeader.vue` | Header for pump calculation panel |
| `SupplyPipeCalculationPanel.vue` | Modal panel for pump calculation with map layer |
| `UpdateToast.vue` | Service worker update toast with periodic checking |
| `WhatsNewModal.vue` | Post-update "What's New" modal, grouped by feature/improvement/fix |

### Views (`src/views/`)

| File | Purpose |
|---|---|
| `AboutView.vue` | App info, version, OSM contribution instructions, store links |
| `HomeView.vue` | Main page combining map with all panels |
| `MarkerImageViewer.vue` | Full-screen PhotoSwipe gallery for marker images |
| `OfflineAreasView.vue` | Manage downloaded offline map areas (add/refresh/delete, size, online-only gating) |
| `PendingEditsView.vue` | List queued offline edits and trigger manual sync |
| `SettingsView.vue` | Theme selector, map layer/terrain, zoom toggle, OSM account login/logout |
| `RoutingDebugView.vue` | Dev-only routing tuning view (scene picker, draggable origin/target, per-mode length/timing, cost raster, ring simulation); registered only in dev builds or with `VITE_ROUTING_DEBUG=1` |

### Routes

| Path | View | Description |
|---|---|---|
| `/` | HomeView | Main map view |
| `/markers/:markerId` | HomeView | Map with selected marker |
| `/supplypipe` | HomeView | Pump calculation mode |
| `/nearbysources` | HomeView | Nearby water sources list |
| `/nearbysources/:markerId` | HomeView | Nearby water source details |
| `/about` | AboutView | App information |
| `/settings` | SettingsView | User preferences |
| `/settings/offline-areas` | OfflineAreasView | Offline map area management |
| `/settings/pending-edits` | PendingEditsView | Offline edit queue |
| `/markerimages/:relatedId` | MarkerImageViewer | Image gallery |
| `/osm-callback` | - | OAuth callback handler |
| `/debug/routing` | RoutingDebugView | Dev-only routing tuning view (`import.meta.env.DEV` or `VITE_ROUTING_DEBUG=1`) |

### Public Assets (`public/`)

- Favicons and app icons (PNG, ICO)
- `robots.txt` and `sitemap.xml` for SEO
- `.well-known/apple-app-site-association` — iOS Universal Links
- `.well-known/assetlinks.json` — Android App Links

### CI/CD (`.github/workflows/`)

| Workflow | Trigger | Description |
|---|---|---|
| `ci.yml` | Pull requests and pushes to `main` | Quality gate: `npm ci`, `npx eslint .`, `npm run typecheck`, `npm test` |
| `release.yml` | Manual (`workflow_dispatch`) | Unified release pipeline. `prepare` job runs `npm test`, then computes the next semver from Conventional Commits, bumps `package.json`/Android version, generates `CHANGELOG.md` via git-cliff, stamps `src/assets/whats-new.json`, commits, tags `v<version>`, and creates the GitHub Release; then fans out to `main.yml`/`android.yml`/`ios.yml` (each checks out that tag, read-only). **A release publishes to production**: GitHub Pages, Google Play production, and App Store review with automatic release on approval. Test builds are reviewed beforehand via `dev-builds.yml` |
| `main.yml` | `workflow_call` (from `release.yml`) or manual | Builds the web app and deploys to GitHub Pages |
| `android.yml` | `workflow_call` or manual | Two-job pipeline: `build` runs `npm ci`/Gradle to produce an **unsigned** AAB+APK (no secrets); `deploy` downloads those artifacts, signs them with the keystore, uploads the signed APK to the GitHub Release, and pushes the AAB via Fastlane: tagged versions (`version` input set) to the **production** track (`android production` lane), everything else to the **internal** track |
| `ios.yml` | `workflow_call` or manual | Builds and archives via Xcode/Fastlane. Tagged versions run the `ios release` lane (upload, wait for processing, submit for App Store review with automatic release, only `release_notes.txt` from `fastlane/metadata/ios` sent); everything else runs `ios beta` (TestFlight internal only) |
| `dev-builds.yml` | Push to `main` (code changes; docs-only pushes skipped) or manual | Native test builds: computes the upcoming release version (same semver rules as `release.yml`) and a commit-time build number, then calls `android.yml` (Play **internal** track) and `ios.yml` (TestFlight, internal testers only) in dev mode. Commits/tags nothing. Build numbers are 10-second ticks since epoch 1700000000; releases use "now"+1 on the same scale so they always outrank earlier dev builds |

All workflows pin third-party actions to a commit SHA and install dependencies with `npm ci --ignore-scripts`.

### Preview deployments (Cloudflare Pages)

Separate from the GitHub Actions above, **Cloudflare Pages** (Git integration, configured in the Cloudflare dashboard — there is no workflow or Cloudflare config in this repo) builds the web app (`npm run build` → `dist`) on every push:

- **`main`** → dev page at `https://fireyak.pages.dev` (not production; app.fireyak.org on GitHub Pages stays production).
- **Every other branch** (except `dependabot/*`) → preview at `https://<branch-alias>.fireyak.pages.dev` plus a per-commit `https://<sha>.fireyak.pages.dev`. Cloudflare posts the link as a check/comment on the PR. Branches from forks are not built.

Cloudflare builds set `VITE_OSM_URL`/`VITE_OSM_CLIENT_ID` (read by `src/services/osmConfig.ts`), so OSM login and edits go to the **OSM dev server** (`master.apis.dev.openstreetmap.org`). Login works only on hosts registered as exact redirect URIs on the dev OAuth app, so not on per-commit URLs. Because map data still comes from production OSM, edits to *existing* objects on such builds (`OSM_EDITS_TARGET_OTHER_SERVER`) are dry runs: `src/services/osmWrite.ts` reads them from the production API and shows the changeset instead of uploading it. All OSM reads-for-edit and uploads must go through `getFeatureForEdit`/`uploadChange` there. Adding new markers uploads to the dev server, and marker "view/edit on OSM" links always use production (`OSM_DATA_WEB_URL`). Native builds ignore these variables. Full setup and caveats: `plans/cloudflare-pages-previews.md`.

## 4. Key Commands

```bash
# Install dependencies
npm install

# Start development server (with network access)
npm run dev

# Create production build
npm run build

# Build and sync with Capacitor native platforms
npm run buildAndSync

# Lint and auto-fix
npm run lint

# Type check (vue-tsc; the build does not type-check)
npm run typecheck

# Run the unit tests once / in watch mode
npm test
npm run test:watch

# Fetch the (gitignored) routing fixture tiles locally; the key comes from the
# environment only and must never be written to a file
VITE_PROTOMAPS_API_KEY=<key> node scripts/fetch-routing-fixtures.mjs [--scene <id>]

# Generate native app icons and splash screens
npm run generate:assets
```

## 5. Architectural Patterns

- **Component-Based Architecture**: Vue components promote reusability and separation of concerns. Each panel (MarkerInfo, NearbyMarker, SupplyPipe, MarkerEdit) follows a Header + Content + Panel pattern.
- **Centralized State Management**: Pinia is the single source of truth. Components read from stores and dispatch actions to modify state.
- **Composable Pattern**: Business logic is separated into composables (Vue-reactive) and helpers (pure functions), keeping components focused on presentation.
- **API Abstraction**: Overpass API calls are isolated in `src/mapHandler/overPassApi.ts` (with a native Capacitor transport). OSM editing goes through `osm-api` in the marker edit store, queuing to `src/offline/editQueue.ts` when offline.
- **Offline-First Caching**: IndexedDB caches OSM markers, offline area definitions, downloaded tiles, and the pending-edits queue (`src/mapHandler/databaseHandler.ts`, `src/offline/`). All map tile sources are served through the custom `offline://` MapLibre protocol (cache-first, online fallback). On the web build, Workbox additionally runtime-caches Protomaps/ArcGIS satellite/Mapterhorn terrain tiles and Wikimedia assets (30-day TTL) as a PWA-level fallback.
- **Hybrid Native Integration**: Capacitor wraps the web app for iOS and Android, providing access to geolocation, screen orientation, preferences, share, filesystem, network status, and in-app review APIs.
- **Material Design 3 Theming**: Custom MD3 CSS overrides for all Ionic components live in `src/theme/md3/`.
- **Conventional Commits**: Enforced via Commitlint + Husky pre-commit hooks.

### Branch naming (REQUIRED)

Name every new branch `<type>/<short-kebab-slug>`. Do **not** use tool-generated
names such as `claude/…`, `codex/…` or `copilot/…`. If your environment hands you
such a branch for **new** work, create a properly named branch and push that instead.

**Exception — follow-ups on an existing PR:** keep pushing to that PR's head branch,
whatever its name, so the commits land in the PR. Don't open a replacement branch
or PR just to fix the name. If that branch can't be pushed to, stop and report it
instead of pushing the work somewhere else.

| Prefix | Use for | Commit type |
|---|---|---|
| `feature/` | New user-facing functionality | `feat:` |
| `bugfix/` | Fixing broken behaviour | `fix:` |
| `docs/` | Documentation and plans only (`AGENTS.md`, `README.md`, `plans/`) | `docs:` |
| `refactor/` | Code restructuring without behaviour change | `refactor:` |
| `chore/` | CI, build, tooling, dependencies, releases | `chore:` / `ci:` / `build:` |

- Add the issue number when there is one: `bugfix/101-suction-points`.
- Keep the whole name short, **at most ~28 characters**. Cloudflare Pages builds
  the branch preview URL from it (`/` → `-`) and cuts it at 28 characters,
  e.g. `claude/issue-101-suction-pipes` became `claude-issue-101-suction-pip`.
- One branch per PR. Don't stack unrelated changes on a branch that already has
  an open PR.

## 6. What's New Maintenance (REQUIRED)

Every **user-facing change** MUST add an entry to the `unreleased` array in
`src/assets/whats-new.json` — these entries become the in-app "What's New"
popup shown to users after an update.

```json
{ "type": "feature", "en": "Water tanks can now be added directly on the map.",
  "de": "Wassertanks können jetzt direkt auf der Karte hinzugefügt werden." }
```

Rules:

- **User-facing means**: new features, visible improvements, and bug fixes a
  user would notice. Refactors, CI/build changes, docs, and dependency bumps
  get **no** entry.
- `type` is one of `feature`, `improvement`, `fix`.
- **Both languages are mandatory.** Write native-quality German, not a literal
  translation. Use the same tone as `src/locales/de.json`.
- Write from the user's perspective in plain language — what they can now do
  or what stopped being broken. No code identifiers, file names, or technical
  jargon ("Overpass API", "IndexedDB"). One sentence, ≤ ~120 characters.
- Append to `unreleased` only. **Never edit the `releases` array** — the
  release pipeline stamps `unreleased` into it with version and date.
- If a change amends a feature that already has an `unreleased` entry, update
  that entry instead of adding a second one.

## 7. Important Notes for AI Agents

- **Tests run with Vitest** (`npm test`, Node environment). Spec files sit next to the source they test (`foo.ts` → `foo.spec.ts`) and cover pure modules; modules under test import only pure modules and take I/O through injectable fetchers. Scene specs over real map tiles are named `*.scenes.spec.ts`. Shared test-only helpers live in `src/testing/` (eslint forbids importing it, `vitest` or any `__fixtures__` path from app code). Import `describe`, `it`, `expect`, `vi` from `'vitest'` explicitly. Where a module reaches I/O directly (Capacitor Preferences in `composable/settings.ts`, the tile and DEM loaders behind `hoseRoutingCore.ts`), its spec replaces that module with `vi.mock` instead. Node has no `Worker` for Vite's worker, so `nearbyRouting.ts` routes on the main thread in specs; the worker protocol is tested over a `node:worker_threads` `MessageChannel` (`hoseRoutingProtocol*.spec.ts`).
- **Routing fixtures** live in `src/mapHandler/__fixtures__/routing/` (see the README there): `scene.json` and the README are committed, the tile files are gitignored and fetched with `scripts/fetch-routing-fixtures.mjs`. Scene specs skip cleanly (`describe.skipIf(!fixturesPresent)`) when the tiles are absent, so in a fresh checkout a green `npm test` does not exercise them: fetch the fixtures first when you change routing code. Expected values in specs are tolerant ranges.
- **Run `npm test` and `npm run typecheck` before committing** changes to tested modules (CI runs eslint, typecheck and tests on every PR; `release.yml` runs the tests before tagging).
- **Areas get tag-only edits.** Fire water ponds can be ways or multipolygon relations. For those, FireYak only changes tags: never coordinates, member nodes or members, and it never deletes them (that would remove the water body). "Delete" on a pond area removes only the `emergency=fire_water_pond` flag. Helpers live in `src/helper/osmElement.ts`; the edit queue rejects area deletes.
- **OSM OAuth2 uses PKCE flow** — see `osmAuthStore.ts` for the implementation. Never hard-code `www.openstreetmap.org` or the client ID; use `OSM_WEB_URL`/`OSM_CLIENT_ID` from `src/services/osmConfig.ts` so preview builds hit the OSM dev server.
- **Web changes get a Cloudflare Pages preview per branch** (see §3 "Preview deployments"); point reviewers to the PR's preview link for UI checks.
- **The PWA manifest is generated by `vite-plugin-pwa`** from `vite.config.ts`, not a static file.
- **Marker icons** are in `src/assets/` as SVG/PNG files with type-specific variants.
- **Elevation data** comes from the Mapterhorn terrain DEM tiles the map already loads (`src/helper/demElevation.ts` / `demTiles.ts`), not a separate API — this keeps pump calculation working offline inside a downloaded area.
- **`scripts/stamp-whats-new.mjs`** moves `whats-new.json`'s `unreleased` entries into `releases` with a version/date; run only by `release.yml`, not manually during feature work.
