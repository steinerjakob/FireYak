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
- **Image Gallery**: PhotoSwipe (for Wikimedia Commons images)
- **Elevation Data**: Mapterhorn terrain DEM tiles (same offline-capable pipeline as the map), used for pump calculation and routing
- **OSM Editing**: osm-api with OAuth2 PKCE; edits queue offline and sync when back online
- **In-App Review**: `@capacitor-community/in-app-review`, gated by a usage-based composable
- **Styling**: SCSS, Material Design 3 custom theme
- **Code Quality**: ESLint, Prettier, Stylelint, Commitlint (Conventional Commits), Husky + lint-staged
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
├── services/        # External auth service integration (OSM OAuth)
├── store/           # Pinia stores
├── theme/           # SCSS variables and Material Design 3 CSS overrides
├── types/           # Shared TypeScript types (geo, obstacles)
├── views/           # Top-level page components
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
| `pumpCalculationSettings.ts` | Pump calculation parameters with localStorage persistence |
| `settingsStore.ts` | Theme, map layer (standard/satellite), terrain 3D toggle, marker filters, zoom button visibility, system bar styling |

### Composables (`src/composable/`)

| File | Purpose |
|---|---|
| `darkModeDetection.ts` | System/manual dark mode detection and application |
| `inAppReview.ts` | Tracks active usage days and triggers the one-shot native in-app review prompt |
| `modalBreakpointWatcher.ts` | Tracks Ionic modal breakpoint state changes |
| `nearbyWaterSource.ts` | Reactive list of nearby water sources, ranked by road-aware distance |
| `networkStatus.ts` | Singleton reactive online/offline status shared across the app |
| `photonSearch.ts` | Address/place search against the Photon geocoding API |
| `pumpCalculation.ts` | Relay pump calculations (waypoints, elevation, pump positioning) |
| `screenDetection.ts` | Mobile/desktop breakpoint detection (768px) |
| `screenOrientation.ts` | Device orientation monitoring via Capacitor |
| `settings.ts` | Loads/saves persistent settings via Capacitor Preferences |
| `whatsNew.ts` | Loads `whats-new.json`, tracks last-seen app version, drives the What's New modal |

### Helpers (`src/helper/`)

| File | Purpose |
|---|---|
| `appStoreInfos.ts` | App Store / Play Store URLs for the current app |
| `calculatePumpPosition.ts` | Optimal pump positioning along routes (pressure/elevation/flow) |
| `demElevation.ts` | Elevation sampling from the Mapterhorn terrain DEM tiles (offline-capable, replaces Open-Meteo) |
| `distanceCalculation.ts` | Haversine distance + geodetic point interpolation (20m intervals) |
| `elevationData.ts` | Batch elevation fetching helper (legacy/fallback path) |
| `helper.ts` | Debounce utility |
| `tileMath.ts` | Minimal Web-Mercator slippy-tile helpers used by the tile-freshness registry |
| `weightedDistance.ts` | Tuning constants for the road-aware weighted-distance heuristic (building penalty, road bonus, sampling) |

### Map Handlers (`src/mapHandler/`)

| File | Purpose |
|---|---|
| `databaseHandler.ts` | IndexedDB wrapper for marker caching, offline areas, pending edits, and spatial queries |
| `gridRouting.ts` | Cost-grid Dijkstra terrain routing for hose laying (not clamped to roads, avoids buildings) |
| `markerHandler.ts` | Creates MapLibre markers with type-specific icons, manages cache |
| `markerImageHandler.ts` | Fetches Wikimedia Commons images for OSM nodes |
| `nearbyRouting.ts` | Road-aware ranking for the nearby water sources list (routed distance → weighted heuristic → straight-line) |
| `obstacleGeometry.ts` | Decodes building footprints and road centerlines from Protomaps vector tiles for routing |
| `overPassApi.ts` | Queries Overpass API (web fetch or native transport) for emergency infrastructure within bounds |
| `roadRouting.ts` | Shortest-path routing over decoded road centerlines for hose-laying distance to a marker |

### Offline mode (`src/offline/`)

| File | Purpose |
|---|---|
| `areaDataDownloader.ts` | Downloads Overpass node data for a selected offline area, chunked to stay under API limits |
| `editQueue.ts` | FIFO offline edit queue + sync engine; drains on reconnect, app start, or manual sync |
| `offlineProtocol.ts` | Registers the `offline://` MapLibre protocol; cache-first tile/style-asset serving with online fallback |
| `tileDownloader.ts` | Parallel tile + style-asset fetcher with retry/backoff, used for offline area downloads |
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

### Public Assets (`public/`)

- Favicons and app icons (PNG, ICO)
- `robots.txt` and `sitemap.xml` for SEO
- `.well-known/apple-app-site-association` — iOS Universal Links
- `.well-known/assetlinks.json` — Android App Links

### CI/CD (`.github/workflows/`)

| Workflow | Trigger | Description |
|---|---|---|
| `release.yml` | Manual (`workflow_dispatch`) | Unified release pipeline. `prepare` job computes the next semver from Conventional Commits, bumps `package.json`/Android version, generates `CHANGELOG.md` via git-cliff, stamps `src/assets/whats-new.json`, commits, tags `v<version>`, and creates the GitHub Release; then fans out to `main.yml`/`android.yml`/`ios.yml` (each checks out that tag, read-only) |
| `main.yml` | `workflow_call` (from `release.yml`) or manual | Builds the web app and deploys to GitHub Pages |
| `android.yml` | `workflow_call` or manual | Two-job pipeline: `build` runs `npm ci`/Gradle to produce an **unsigned** AAB+APK (no secrets); `deploy` downloads those artifacts, signs them with the keystore, uploads the signed APK to the GitHub Release, and pushes the AAB to the Google Play **internal** track via Fastlane |
| `ios.yml` | `workflow_call` or manual | Builds and archives via Xcode/Fastlane, uploads to TestFlight |

All workflows pin third-party actions to a commit SHA and install dependencies with `npm ci --ignore-scripts`.

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

- **No test suite exists.** There are no unit or integration tests.
- **OSM OAuth2 uses PKCE flow** — see `osmAuthStore.ts` for the implementation.
- **The PWA manifest is generated by `vite-plugin-pwa`** from `vite.config.ts`, not a static file.
- **Marker icons** are in `src/assets/` as SVG/PNG files with type-specific variants.
- **Elevation data** comes from the Mapterhorn terrain DEM tiles the map already loads (`src/helper/demElevation.ts`), not a separate API — this keeps pump calculation working offline inside a downloaded area.
- **`scripts/stamp-whats-new.mjs`** moves `whats-new.json`'s `unreleased` entries into `releases` with a version/date; run only by `release.yml`, not manually during feature work.
