# Gemini Project Guide: FireYak

This document provides a comprehensive overview of the FireYak project for AI-assisted development. It outlines the project's purpose, technologies, structure, and key commands to ensure efficient and consistent collaboration.

## 1. Project Overview

FireYak is a hybrid mobile and web application designed for firefighters and emergency response teams. Its primary function is to display a map of nearby water sources (such as fire hydrants, rivers, and tanks) fetched from the OpenStreetMap (OSM) database via the Overpass API. It also includes specialized tools for calculating water supply logistics, such as pump positioning and pressure loss over distance.

## 2. Core Technologies

-   **Framework**: Vue.js 3 (with Composition API)
-   **UI Components**: Ionic for Vue
-   **Build Tool**: Vite
-   **Mobile Wrapper**: Capacitor
-   **Mapping**: Leaflet.js for tile display and interactivity.
-   **State Management**: Pinia for centralized, type-safe state management.
-   **Routing**: Vue Router
-   **Data Source**: OpenStreetMap (via Overpass API)
-   **Internationalization**: vue-i18n
-   **Styling**: SCSS and Stylelint
-   **Code Quality**: ESLint and Prettier

## 3. Project Structure (`src/`)

The `src` directory is organized into functional modules:

-   **/assets**: Static assets like marker icons and images.
-   **/components**: Reusable Vue components (e.g., `MainMap.vue`, `MarkerInfoPanel.vue`). These are the building blocks of the UI.
-   **/composable**: Reusable Vue Composition API functions that encapsulate stateful logic (e.g., `pumpCalculation.ts`, `nearbyWaterSource.ts`).
-   **/helper**: Pure utility functions for specific calculations (e.g., `distanceCalculation.ts`, `elevationData.ts`).
-   **/locales**: Translation files (`en.json`, `de.json`) for internationalization using `vue-i18n`.
-   **/mapHandler**: Core logic for interacting with the map and its data.
    -   `overPassApi.ts`: Handles all communication with the Overpass API to fetch OSM data.
    -   `markerHandler.ts`: Manages the lifecycle of Leaflet markers on the map.
-   **/plugins**: Integration point for third-party libraries and custom Vue plugins.
-   **/router**: Defines the application's pages and navigation rules using `vue-router`.
-   **/store**: Centralized state management using Pinia. Each file defines a separate "store" for a specific domain (e.g., `mapMarkerStore.ts`).
-   **/theme**: Global styling, SCSS variables, and Ionic component overrides.
-   **/views**: Top-level Vue components that represent the main pages of the app (e.g., `HomeView.vue`).

## 4. Key Commands

The following scripts are defined in `package.json` and are essential for development:

-   **Start development server**:
    ```bash
    npm run dev
    ```
-   **Create a production build**:
    ```bash
    npm run build
    ```
-   **Check and fix linting issues**:
    ```bash
    npm run lint
    ```
-   **Build the web app and sync with Capacitor native platforms**:
    ```bash
    npm run buildAndSync
    ```

## 5. Architectural Patterns

-   **Component-Based Architecture**: The UI is built with Vue components, promoting reusability and separation of concerns.
-   **Centralized State Management**: Pinia is the single source of truth for all shared application data. Components read from the store to display data and dispatch actions to modify it.
-   **Modular Logic**: Business logic is separated into `composables` (for Vue-reactive logic) and `helpers` (for pure functions), keeping components clean and focused on presentation.
-   **API Abstraction**: All interactions with the Overpass API are isolated within `src/mapHandler/overPassApi.ts`, making it easy to manage or modify data fetching behavior.
-   **Hybrid Native Integration**: Capacitor is used to wrap the web application in a native shell, allowing it to be deployed as a mobile app and access native device features.
