# Changelog

All notable changes to FireYak.
## [2.16.0] - 2026-07-15

### Bug Fixes

- *(pump-calculation)* Open marker chooser via touch long-press on mobile

### Features

- *(offline-areas)* Hide satellite download for imagery license compliance
- *(offline-areas)* Enable terrain download by default in the add modal
- *(offline-areas)* Add per-area detail view with coverage map and editable settings
- *(offline-areas)* Support updating download settings on existing areas
- *(pump-calculation)* Recalculate automatically when the line changes
- *(pump-calculation)* Redesign result panel with elevation chart and synced selection
- *(pump-calculation)* Add elevation profile chart component
- *(pump-calculation)* Select result entries via map markers instead of popups

### Chore

- *(ui)* Remove iOS-specific condition in WhatsNewModal
- *(whats-new)* Announce offline area detail view and terrain default
- *(docs)* Remove outdated WhatsNewModal entries and minor translation fix

### Docs

- *(plans)* Add offline area review and settings plan
- *(whats-new)* Announce pump result panel, auto-recalc, and mobile long-press
## [2.15.2] - 2026-07-11

### Bug Fixes

- *(ui)* Conditionally hide close button in SupplyPipeCalculationHeader
- *(workflows)* Remove signed apks from cwd before Play upload
- *(fastlane)* Skip apk upload so signed apks in workdir don't conflict with aab
- *(workflows)* Drop bundler deployment mode to fix platform lockfile error
## [2.15.1] - 2026-07-10

### Chore

- *(funding)* Update donation links to Ko-fi and adjust UI elements accordingly
- *(funding)* Add Ko-fi username to funding config
- *(workflows)* Add Ruby setup for caching and simplify dependency management
## [2.15.0] - 2026-07-10

### Bug Fixes

- *(theme)* Reduce popup frost blur to 4px for improved balance
- *(theme)* Popup frost via blur only, back to stock glass alpha
- *(theme)* Soften popup frost alpha to 0.76
- *(theme)* Frost ios glass popups for readability
- *(whats-new)* Apply ios26 liquid-glass style to the popup
- *(lint)* Migrate eslint config to v10 flat config, clean dead imports

### Features

- *(whats-new)* Show feature overview on first launch
- *(app)* Show What's New popup after updates
- *(map)* Marker path line toggle, distance cap, and UI-aware fit padding

### Build

- Fix vulnerabilities

### Chore

- *(workflows)* Update GitHub Actions to latest versions across workflows
- *(whats-new)* Refine wording in release notes for clarity
- *(whats-new)* Mention the ios liquid-glass design in 2.14.0 notes
- *(whats-new)* Polish German wording of release notes
- Share project verify skill, ignore local build/agent artifacts

### Ci

- Harden pipelines and add unified release workflow

### Docs

- Refresh AGENTS.md to current architecture and pipelines
- Add feature and pipeline plans
- Add issue/PR templates and What's New maintenance rule
## [2.14.0] - 2026-07-08

### Bug Fixes

- *(map)* Avoid wasted startup Overpass fetch; quieten Overpass client
- *(theme)* Harmonize color palette with new MD3 token values
- *(theme)* Emit -rgb tokens as bare triplets so Ionic alpha states work
- *(theme)* Card and snackbar typography per MD3
- *(theme)* Use headline/title scale for headings instead of display
- *(theme)* Size buttons per MD3 spec (40px default, 32px small, 56px large)
- *(ui)* Stack labels on pump and hose number inputs
- *(pump)* Round displayed elevation difference to whole meters
- *(pump)* Correct hose counts, elevation-0 handling and steep-terrain loop
- *(map)* Reconnect simplified T-junctions; nearby view zoom + highlight
- *(map)* Stop terrain routes from looping around whole blocks
- *(map)* Anchor the path distance label to the route midpoint
- *(map)* Route around building blocks instead of falling back to straight lines
- *(offline)* Clip the capture-rect scrim to the picker map
- *(ui)* Use readable text token instead of surface-mapped medium color
- *(map)* Reduce Overpass load and surface fetch activity
- *(offline)* Clone records to plain objects before IndexedDB writes
- *(pwa)* Raise workbox precache limit for the grown main chunk
- *(overpass)* Send queries via POST to avoid URL encoding issues

### Features

- *(offline)* Native Overpass transport, parallel tile download, live marker refresh
- *(map)* Add native transport for Overpass API with CapacitorHttp support
- *(theme)* Generate MD3 brand-aware theme and iOS 26 adjustments
- *(pump)* Use a tapped hydrant as water source with its pressure
- *(settings)* Configurable hose length, diameter and designation
- *(pump)* Align relay calculation with fire-service doctrine
- *(map)* Show hose counts between pump markers on the supply line
- *(map)* Route the pump supply line like the nearby-marker path
- *(elevation)* Sample elevations from offline terrain DEM tiles
- *(map)* Terrain hose routing with clamp-to-roads setting
- *(map)* Label the selected-marker path with its calculated distance
- *(map)* Rank nearby water sources by road-aware distance
- *(map)* Identify Overpass requests with a per-install referrer
- *(offline)* Show download phase in area progress UX
- *(offline)* Degrade online-only features gracefully when offline
- *(offline)* Offline map tiles via custom MapLibre protocol
- *(offline)* Queue OSM edits offline and sync on reconnect
- *(offline)* Downloadable offline areas with chunked Overpass data
- *(offline)* Add network status service via @capacitor/network
- *(map)* Show GPS accuracy circle around user location
- *(map)* Long-press to add a marker at the pressed location
- *(map)* Add marker legend to layer selector
- *(map)* Filter water source types on the map
- *(marker-info)* Show data age of cached node
- *(cache)* Prune stale cached nodes on startup
- *(cache)* Skip background refresh of fresh areas
- *(cache)* Track node fetch timestamps (DB v2)
- *(map)* Show offline banner with cached-data hint
- *(map)* Show retry toast when water source fetch fails
- *(overpass)* Clamp oversized area query bounds
- *(overpass)* Per-attempt timeouts and instance pool with 429 cool-down

### Chore

- *(theme)* Map Ionic color variables to MD3 tokens for iOS compatibility
- *(theme)* Remove dead sheet.css duplicate of action-sheet.css
- Ignore local SSH key files

### Docs

- Update offline mode plan with implementation snippets
- Add detailed offline mode implementation plan
- Add project review and improvements plan
## [2.13.0] - 2026-04-30

### Bug Fixes

- Preserve cached markers when updateNodeCache is aborted or fails

### Features

- Add loading indicator for marker fetching
- Add request cancellation, fallback, and timeout handling to Overpass API

### Other

- Remove in-app review feature from About view
- Deduplicate map movement event handlers

### Chore

- Use overpass.private.coffee as fallback
## [2.12.0] - 2026-04-18

### Features

- Add in-app review with 7-day usage tracking and manual trigger (#72)
- Add native app install prompt for mobile web (#73)
## [2.11.1] - 2026-03-30

### Bug Fixes

- Apply theme color to search action buttons
## [2.11.0] - 2026-03-28

### Bug Fixes

- Load PROTOMAPS_API_KEY from environment variables
- Adjust popup position
- Adjust clustering settings

### Features

- Add address search bar with photon geocoder (#71)
- Add mapterhorn 3d terrain source (#70)
- Support for editing AWWA Class
- Add chips with preselected values

### Build

- Bump packages
- Remove capacitor/assets package
## [2.10.3] - 2026-03-22

### Bug Fixes

- Supply pipe polyline not showing after layer change (#69)
- Allow clearing any input during edit
## [2.10.2] - 2026-03-20

### Bug Fixes

- Watersource was not available for fire_hydrants
## [2.10.1] - 2026-03-20

### Bug Fixes

- Fix/missing or wrong implemented tags for fire_hydrant nodes (#65)

* fix: fire_hydratn:pressure wrong values provided

* support setting survey date

* support pillar:type
## [2.10.0] - 2026-03-13

### Features

- Move to maplibre-gl with protomaps
## [2.9.2] - 2026-03-10

### Bug Fixes

- Improve URL parsing and routing logic in appUrlOpen listener
## [2.9.1] - 2026-03-10

### Bug Fixes

- Browser background theme color
- Reconcile deleted nodes from cache when fetching fresh marker data

### Build

- Bump husky and re-enable git hooks

### Ci

- Remove unuse upload metadata lanes

### Docs

- Update app name
- Update store listings for Android and iOS
## [2.9.0] - 2026-03-06

### Bug Fixes

- Move version commit after deployment in Android workflow and simplify git operations

### Features

- Add comprehensive SEO, metadata, and sitemap configuration

### Chore

- Update eslint configuration
- Enable pre commit hooks
- Reformat with prettier

### Docs

- Expand AGENTS.md with comprehensive technical reference and architecture details
- Restructure README with in-app editing features and improved organization
- Update app download links and badges in README
## [2.8.1] - 2026-03-03

### Bug Fixes

- Commit version changes before fetching/rebasing in CI workflows
- Re-enable deep link handling for app URL opens
- Exclude land.html from service worker caching and navigation fallback
## [2.8.0] - 2026-03-03

### Bug Fixes

- Remove extra ampersand in CARTO attribution text

### Features

- Add "Manage Account" button in settings to open OSM profile page
- Ensure activity state readiness before accessing Preferences in OAuth flow
- Prevent native deep-link from interfering with OAuth InAppBrowser flow
- Switch web OAuth flow from redirect to popup mode with BroadcastChannel
- Implement native OAuth2 PKCE flow with in-app browser for mobile platforms
- Disable service workers for native builds using selfDestroying mode (#58)
- Enhance map attribution with GitHub support link
- Update dark mode styling to consider satellite map layer selection
- Add map layer selector with satellite and standard options

### Other

- Improve OSM auth flow and cleanup
- Replace direct Preferences usage with centralized settings management
- Migrate OAuth flow to @capacitor/inappbrowser with improved handling
- Centralize OAuth logic in reusable service
- Remove OSM hydrant guide card from About page

### Chore

- Replace @capgo/inappbrowser with @capacitor/inappbrowser in dependencies
- IOS location permission descriptions with FireYak-specific context

### Ci

- Remove push trigger from GitHub Pages deployment workflow

### Docs

- Remove detailed OSM editing guide from README.md
## [2.7.0] - 2026-02-28

### Features

- Support for add/edit/delete markers
## [2.6.0] - 2026-02-26

### Features

- Add ios applink support
## [2.5.0] - 2026-02-26
## [2.4.3] - 2026-02-26

### Features

- Add apple-app-site-association file for iOS universal links
## [2.4.2] - 2026-02-26

### Bug Fixes

- Ensure SystemBars style logic runs only on native platforms

### Chore

- Downgrade vue-router to 4.6.4 in package.json
## [2.4.1] - 2026-02-26

### Other

- Replace `Capacitor.getPlatform()` calls with `isNativeIos` computed property
## [2.4.0] - 2026-02-26

### Features

- Add iOS-specific UI restrictions and conditional rendering

### Chore

- Adjust build steps
## [2.3.0] - 2026-02-26

### Features

- Migrate ios to capacitor 8
- Migrate ios to capacitor 8
- Add ios safe area support
- Add ios spm support
- Feature/migrate-to-capacitor-8 (#53)

* feat: migrate to capacitor 8

* style: adjust padding in theme selection segment for better alignment

* refactor: migrate ESLint configuration to flat config format

- Remove `.eslintrc.json` and replace it with `eslint.config.mjs` using the new flat config format.
- Update `package.json` dependencies to reflect changes in ESLint configuration.

### Other

- Update MarkerEditHeader icon and button behavior

### Build

- Xtool.sh setup

### Chore

- Add version and category type
## [2.2.1] - 2026-02-24

### Bug Fixes

- Restrict marker editing to fire hydrants with emergency tags
## [2.2.0] - 2026-02-24

### Bug Fixes

- Invalid json format

### Other

- Comment out unused tag description fields in MarkerEdit component
- Simplify and consolidate MD3 theme styles
## [2.1.3] - 2026-02-24
## [2.1.2] - 2026-02-21

### Bug Fixes

- Update DE locale for hydrant pressure descriptions

### Features

- Improve authentication and UX for marker editing
- Improve OSM authentication and UX for marker editing
- Update assetlinks.json for additional app linking
- Update OSM authentication configuration
- Add marker editing feature

### Other

- Consolidate spacing overrides and enhance MD3 component styling
- Adjust OSM authentication and add redirect handling

### Style

- Refine padding and fullscreen behavior in About and Settings views
## [2.1.1] - 2026-02-02

### Bug Fixes

- Initialize theme system on app startup
## [2.1.0] - 2026-02-01

### Bug Fixes

- Theme switching did not work properly

### Features

- Add guard to prevent invalid pressure inputs
- Remove webkit highlight color from buttons
- Add settings page
- Add zoom buttons to map

### Build

- Add AGENTS.md file

### Ci

- Improve versioning
- Generate apk to provide it on github
## [2.0.2] - 2025-12-04

### Bug Fixes

- Use custom location marker first to find the nearest source
- Desktop card scroll behaviour
- Desktop card scroll behaviour
- Element center on landscape screens

### Chore

- Cache osm tiles with service worker
## [2.0.1] - 2025-12-03

### Features

- Set a fallback path if opened via url listener
- Improve mobile screen detection

### Ci

- Update permissions
- Configure semantic versionings
## [2.0.0] - 2025-12-03

### Bug Fixes

- Location request in web
- Adjust marker info modal breakpoints and scroll behavior
- Improve pump placement logic (#42)
- Update clustering zoom behavior and improve marker cluster interactions
- Do not show marker info panel
- Enhance navigation URLs by platform in MarkerInfoHeader for improved map integration
- Correct localization key for "tubes" in en.json
- Improve tube calculation accuracy and simplify distance handling
- Rename pumpCalculation store to pumpCalculationSettings
- Waypoint deletion popup not appearing
- Improve pump count
- Do not require gps hardware
- Update URL splitting logic for route slug parsing
- Standardize route path casing for "supplypipe" references
- Update share message text for more accurate description
- Icon name casing
- Icon name casing
- Update marker URL to use absolute path
- Handle null fallback for `fetchMarkerById`

### Features

- Prevent duplicate map instances in MainMap component
- Support geo url scheme on android (#40)
- Update android design to md3
- Feature/replace-photoviewer-with-photoswipe (#38)

* feat: replace capacitor-photoview with photoswipe

* feat: improve image loading when page is directly loaded

* feat: photoviewer consider edge to edge
- Feature/improved-documentation (#36)

* docs: expand README with app features, setup guide, and contribution instructions

* feat: add guide for contributing hydrants to OpenStreetMap in About section

* refactor: "add hydrants" card in About section

* refactor: combine support-related cards in About section
- Support to view marker images (#35)
- Replace EdgeToEdge with SafeArea for improved status bar and navigation bar handling on Android
- Calculate b tubes for nearby marker
- Fit nearby marker in the upper half of the screen
- Fit pump calculation to bounds after calculation
- Allow clicking the full list button
- Feature/nearby-watersources (#32)

* feat: add nearby marker search with distance sorting and UI integration including new icon

* feat: integrate nearby water source feature with route, UI components, and data handling

* feat: update nearby water source integration

* feat: add getNearbyMapNodes with radius filtering and integrate with getNearbyMarkers

* feat: refine nearby water source handling and map interaction logic

* feat: translate distance text

* feat: highlight selected nearby marker

* feat: show polyline to selected marker

* feat: add panel header

* feat: recalculate on location change

* refactor: improve router handling

* refactor: remove log message

* ci: publish android to production
- Add @capacitor/preferences to Android project configuration
- Feat: persist pump calculation settings using
 @capacitor/preferences and auto-save on changes
- Add @capacitor/preferences dependency
- Add context menu for marker placement with alert options in pump calculation
- Enhance pump calculation results with tube count and pressure display
- Refactor pump position handling and enhance suction point popup functionality
- Add pump marker support with navigation, enhance routing, and refactor pump calculation logic
- Improve results display with styled layout and added labels for pump calculation results
- Add tube count calculation and display elevation difference in results
- Add reset functionality for pump calculation and improve calculation result handling
- Add CalculationResult interface and enhance pump position handling
- Make markers draggable and update polyline on drag
- Add popup to target point
- Provide tube calculation
- Allow removing a waypoint
- Automatically sort waypoints based on distance
- Add intent filter for deep links
- Add capacitor-screen-orientation plugin and update version code
- Add android deep link
- Add missing splash screens
- Replace locate.control button with fab button
- Enhance pump calculation with dynamic pressure parameters and flow rate selection
- Enhance pump calculation with dynamic pressure parameters and flow rate selection
- Add pressure and distance properties to elevation points in pump calculations
- Update pump pressure labels to include units in German localization
- Update pump location marker retrieval and add new icons for various points
- Localize pump marker popups with internationalization support
- Enhance pump marker popups with detailed information
- Implement pump position calculation and marker generation based on elevation data
- Integrate elevation data into pump calculation and distance functions
- Add elevation data fetching for geographical points
- Destructure distance in pump calculation
- Add interpolation and point generation functions for distance calculations
- Add distance calculation functions and integrate into pump calculation
- Add watch to clear layers and reset points when route changes
- Add calculate button and enable conditional rendering in pump calculation
- Add custom icons for suction, fire, and way points in pump calculation
- Improve handling of suction and target points in pump calculation
- Add state management for suction and fire points in pump calculation
- Enhance pump calculation logic to update polyline on point changes
- Update SupplyPipeCalculation component for displaying pump calculation points
- Rename SupplyPipeCalculation component to SupplyPipeCalculationPanel
- Add locate icon to Supply Pipe Calculation component and style it
- Integrate pump calculation logic into MainMap and enhance map interaction
- Add Supply Pipe Calculation header component and update localization
- Add Supply Pipe Calculation component and update MainMap behavior
- Add supply pipe calculation feature and update translations
- Implement screen orientation handling and refactor status bar plugin
- Add Capacitor App plugin to Android project
- Enhance Android status bar customization with Edge to Edge support
- Add "Buy Me a Coffee" support section in About page
- Add About page with FAB button and GitHub support link in MainMap
- Add new icons for web and android
- Integrate dark mode styling for MainMap component
- Add `useDarkMode` composable for dark mode detection
- Disable zoom control in MainMap initialization
- Add UpdateToast component for PWA refresh notifications
- Implement android statusbar colorization
- Add Capacitor Share plugin to Android project
- Replace navigator.share with Capacitor Share API
- Add android native support
- Enhance favicon support with multiple sizes and platforms
- Integrate MarkerInfoHeader into MarkerInfoPanel
- Add MarkerInfoHeader component with navigation and share functionality
- Integrate Pinia store for marker management
- Extend volume handling in MarkerInfo with unit display
- Support to open osm editor
- Add "Open in OSM" button to MarkerInfo
- Add share functionality to MarkerInfo with clipboard fallback
- Improve map marker interaction and clustering behavior
- Add `getMarkerById` function for marker retrieval by ID
- Enhance map marker functionality and improve responsiveness
- Add water_source translations and update MarkerInfo
- Add flow capacity field to MarkerInfo with i18n support
- Add dynamic translation for fire hydrant values in MarkerInfo
- Integrate i18n for MarkerInfo with multi-language support
- Adjust MarkerInfoPanel modal behavior and improve MarkerInfo header styles
- Enhance MarkerInfoPanel modal with additional breakpoint and scroll settings
- Add navigation functionality to MarkerInfo
- Enhance MarkerInfo with detailed marker data display
- Pass markerId prop to MarkerInfo and handle updates
- Add getMapNodeById function to databaseHandler
- Add MarkerInfoPanel component and integrate with MainMap
- Basic PWA support with reload prompt
- Improved marker caching
- Primary datasource is now indexdb
- Store fetched map nodes to the indexdb
- Store last map view and restore it on next visit
- Added location control plugin
- Add firestations to the map
- Fetch and add firemap markers
- Map fullscreen
- Add first leaflet map

### Other

- Extract pump calculation logic into composable
- Remove unused router logic and simplify MarkerInfo usage
- Replace dynamic imports with direct references for HomeView in router setup
- Restructure MainMap component for improved DOM hierarchy
- Refactor: simplify dark mode binding in MainMap
 and update Android status bar handling
- Remove edge-to-edge plugin and update App.vue with UpdateToast component
- Simplify MarkerInfo by removing unused methods and header
- Replace custom header in MarkerInfo with Ionic components
- Switch router history mode to use hash-based navigation
- Move route watch logic into onMounted and extract map initialization
- Remove unused `markerId` prop in MarkerInfo and related references
- Use Pinia's `selectedMarker` state in MarkerInfo
- Replace `showSelectMarkerForNode` with Pinia-based state management
- Convert `useMapMarkerStore` to composition API
- Simplify MarkerInfo structure and improve styles
- Migrate from vuetify to ionic
- Moved overpass handling into own directory
- Do not setView
- Use default marker icon
- Updated window title
- Updated favicon
- Disable vite pwa for now

### Chore

- Use full screen of app
- Disable Prettier rule in ESLint config
- Adjust initial breakpoint in MarkerInfoPanel modal to 0.25
- Disable deprecated Vue slot attribute rule in ESLint config
- Remove type-checking step from build script in package.json
- Add package-lock.json with dependencies and devDependencies
- Update GitHub Actions to use latest versions
- *(npm)* Add new package idb
- Eslint allow @ts-ignore
- Improved my location behaviour
- Added debouncing to the mapmove listener
- Resolve @ paths
- Code cleanup
- Merge unrelated histories
- Add github actions
- Add missing configuration files
- Stylelint
- Eslint
- Change precommit
- Lint-staged
- Lint-staged
- Added commitlint with husky
- Add prettier

### Ci

- Autogenerate version
- Add PAT_TOKEN to GitHub Actions checkout step
- Create main.yml (#31)

### Docs

- Update README.md
- Improved readme and added logo
- Improved readme and added logo
- Initial readme

### Style

- Update About button color to light in MainMap FAB
