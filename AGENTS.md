# Gemini Project Guide: FireYak

This document provides a comprehensive overview of the FireYak project for AI-assisted development. It outlines the project's purpose, technologies, structure, and key commands to ensure efficient and consistent collaboration.

## 1. Project Overview

FireYak is a hybrid mobile and web application designed for firefighters and emergency response teams. Its primary function is to display a map of nearby water sources (such as fire hydrants, suction points, water tanks, fire water ponds and fire stations) fetched from the OpenStreetMap (OSM) database via the Overpass API. It also includes specialized tools for calculating water supply logistics, such as pump positioning and pressure loss over distance.

- **Website:** [app.fireyak.org](https://app.fireyak.org)
- **iOS App ID:** `6759717059` (Bundle: `org.jst.fireyak`)
- **Android Package:** `at.jst.fireyak`
- **Languages:** English, German

## 2. Core Technologies

- **Framework**: Vue.js 3 (Composition API, `<script setup>`)
- **UI Components**: Ionic for Vue (Material Design 3 theme)
- **Build Tool**: Vite
- **Mobile Wrapper**: Capacitor (iOS + Android)
- **Mapping**: Leaflet.js with marker clustering (`leaflet.markercluster`)
- **State Management**: Pinia
- **Routing**: Vue Router (Ionic Router)
- **Data Source**: OpenStreetMap via Overpass API
- **Local Storage**: IndexedDB (via `idb`) for marker caching, Capacitor Preferences for settings
- **Internationalization**: vue-i18n (English + German)
- **Image Gallery**: PhotoSwipe (for Wikimedia Commons images)
- **Elevation Data**: Open-Meteo API
- **OSM Editing**: osm-api with OAuth2 PKCE
- **Styling**: SCSS, Material Design 3 custom theme
- **Code Quality**: ESLint, Prettier, Stylelint, Commitlint (Conventional Commits), Husky + lint-staged
- **CI/CD**: GitHub Actions (GitHub Pages deploy, Google Play via Fastlane, TestFlight via Fastlane)

## 3. Project Structure

### `src/` directory

```
src/
├── assets/          # Static assets (marker icons, images)
├── components/      # Reusable Vue components
├── composable/      # Vue Composition API hooks (stateful logic)
├── helper/          # Pure utility functions
├── locales/         # i18n translation files (en.json, de.json)
├── mapHandler/      # Map data fetching, marker management, caching
├── plugins/         # Vue plugin registration (Pinia, Router, Ionic, i18n)
├── router/          # Route definitions
├── store/           # Pinia stores
├── theme/           # SCSS variables and Material Design 3 CSS overrides
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
| `markerEditStore.ts` | Handles marker editing/adding state, OSM uploads via osm-api |
| `osmAuthStore.ts` | OAuth2 PKCE authentication with OpenStreetMap |
| `settingsStore.ts` | Theme (light/dark/auto), zoom button visibility, system bar styling |
| `pumpCalculationSettings.ts` | Pump calculation parameters with localStorage persistence |

### Composables (`src/composable/`)

| File | Purpose |
|---|---|
| `nearbyWaterSource.ts` | Reactive list of nearby water sources with distances |
| `pumpCalculation.ts` | Relay pump calculations (waypoints, elevation, pump positioning) |
| `settings.ts` | Loads/saves persistent settings via Capacitor Preferences |
| `darkModeDetection.ts` | System/manual dark mode detection and application |
| `screenDetection.ts` | Mobile/desktop breakpoint detection (768px) |
| `screenOrientation.ts` | Device orientation monitoring via Capacitor |
| `modalBreakpointWatcher.ts` | Tracks Ionic modal breakpoint state changes |

### Helpers (`src/helper/`)

| File | Purpose |
|---|---|
| `helper.ts` | Debounce utility |
| `distanceCalculation.ts` | Haversine distance + geodetic point interpolation (20m intervals) |
| `elevationData.ts` | Batch elevation fetching from Open-Meteo API |
| `calculatePumpPosition.ts` | Optimal pump positioning along routes (pressure/elevation/flow) |

### Map Handlers (`src/mapHandler/`)

| File | Purpose |
|---|---|
| `overPassApi.ts` | Queries Overpass API for emergency infrastructure within bounds |
| `markerHandler.ts` | Creates Leaflet markers with type-specific icons, manages cache |
| `markerImageHandler.ts` | Fetches Wikimedia Commons images for OSM nodes |
| `databaseHandler.ts` | IndexedDB wrapper for local marker caching and spatial queries |

### Components (`src/components/`)

| File | Purpose |
|---|---|
| `MainMap.vue` | Central Leaflet map with FAB controls and dark mode styling |
| `MarkerInfo.vue` | Displays selected marker properties (type, pressure, flow, etc.) |
| `MarkerInfoPanel.vue` | Bottom sheet wrapper for MarkerInfo |
| `MarkerInfoHeader.vue` | Header with title and action buttons (navigate, share, edit) |
| `MarkerEdit.vue` | Edit form for marker tags with OSM login requirement |
| `MarkerEditPanel.vue` | Modal panel for adding/editing markers |
| `MarkerEditHeader.vue` | Header with save/cancel buttons |
| `NearbyMarker.vue` | List item showing nearby source with distance + B-tube count |
| `NearbyMarkerHeader.vue` | Header for nearby markers section |
| `NearbyMarkerPanel.vue` | Bottom sheet listing nearby water sources within radius |
| `SupplyPipeCalculation.vue` | Pump supply line UI (suction/fire points, waypoints, profile) |
| `SupplyPipeCalculationHeader.vue` | Header for pump calculation panel |
| `SupplyPipeCalculationPanel.vue` | Modal panel for pump calculation with map layer |
| `ReloadPrompt.vue` | PWA update notification with reload button |
| `UpdateToast.vue` | Service worker update toast with periodic checking |

### Views (`src/views/`)

| File | Purpose |
|---|---|
| `HomeView.vue` | Main page combining map with all panels |
| `AboutView.vue` | App info, version, OSM contribution instructions, store links |
| `SettingsView.vue` | Theme selector, zoom toggle, OSM account login/logout |
| `MarkerImageViewer.vue` | Full-screen PhotoSwipe gallery for marker images |

### Routes

| Path | View | Description |
|---|---|---|
| `/` | HomeView | Main map view |
| `/markers/:markerId` | HomeView | Map with selected marker |
| `/supplypipe` | HomeView | Pump calculation mode |
| `/nearbysources` | HomeView | Nearby water sources list |
| `/about` | AboutView | App information |
| `/settings` | SettingsView | User preferences |
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
| `main.yml` | Push to `main` | Semantic versioning, build, deploy to GitHub Pages |
| `android.yml` | Manual | Build APK, sign, upload to Google Play beta via Fastlane |
| `ios.yml` | Manual | Build, sign, upload to TestFlight via Fastlane |

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
- **API Abstraction**: Overpass API calls are isolated in `src/mapHandler/overPassApi.ts`. OSM editing goes through `osm-api` in the marker edit store.
- **Offline-First Caching**: IndexedDB caches OSM markers locally. OSM tile caching (30-day TTL) is handled by the service worker via Workbox.
- **Hybrid Native Integration**: Capacitor wraps the web app for iOS and Android, providing access to geolocation, screen orientation, preferences, and share APIs.
- **Material Design 3 Theming**: Custom MD3 CSS overrides for all Ionic components live in `src/theme/md3/`.
- **Conventional Commits**: Enforced via Commitlint + Husky pre-commit hooks.

## 6. Important Notes for AI Agents

- **No test suite exists.** There are no unit or integration tests.
- **OSM OAuth2 uses PKCE flow** — see `osmAuthStore.ts` for the implementation.
- **The PWA manifest is generated by `vite-plugin-pwa`** from `vite.config.ts`, not a static file.
- **Marker icons** are in `src/assets/` as SVG/PNG files with type-specific variants.
- **Elevation data** comes from the free Open-Meteo API (no API key required).
