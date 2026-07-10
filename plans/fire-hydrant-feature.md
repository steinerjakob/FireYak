# Plan: Add Fire Hydrant Feature

This plan outlines the steps to implement the "Add/Edit Fire Hydrant" feature in FireYak.

## 1. Preparation & Dependencies
- Add `osm-api-js` to `package.json`.
- Research `osm-api-js` for OAuth 2.0 authentication and node creation/modification.

## 2. OSM Authentication
- Create `src/store/osmAuthStore.ts` to manage OSM login state and credentials.
- Implement a login flow (likely using a modal or redirecting to OSM for OAuth).
- Store credentials securely using `@capacitor/preferences`.

## 3. State Management
- Extend `src/store/mapMarkerStore.ts` or create `src/store/markerEditStore.ts`:
    - `isEditing`: boolean
    - `isAdding`: boolean
    - `pendingLocation`: LatLng | null
    - `editableTags`: Record<string, string>
- Add actions to start/stop editing and save changes.

## 4. Map Interactions (`src/components/MainMap.vue`)
- Add a new FAB button (plus icon) to trigger "Add Mode".
- When in "Add Mode" or "Edit Mode":
    - Change cursor or show a ghost marker at the center.
    - On map click: update `pendingLocation`.
    - If editing an existing marker: allow dragging or re-clicking to move.

## 5. UI: Editing Panel
- Create `src/components/MarkerEditPanel.vue`:
    - Mimic `MarkerInfoPanel.vue` structure (bottom sheet on mobile, sidebar on desktop).
    - Contain `MarkerEdit.vue`.
- Create `src/components/MarkerEdit.vue`:
    - Form with inputs for common fire hydrant tags:
        - `fire_hydrant:type`: Selection (pillar, underground, wall, etc.)
        - `fire_hydrant:diameter`: Input (numeric)
        - `fire_hydrant:pressure`: Input
        - `fire_hydrant:flow_capacity`: Input
        - `fire_hydrant:position`: Input
        - `couplings`: Input
        - `ref`, `name`, `operator`, `description`, `note`, etc.
    - Provide hint messages based on OSM wiki.
    - Section for "Optional Tags".
    - "Save" and "Cancel" buttons.

## 6. Saving to OSM
- Implement `saveMarker` logic:
    - If new: create a new node on OSM.
    - If existing: fetch current version, update tags (preserving unknown ones), and update location if changed.
    - Use `osm-api-js` to push changesets.
- Show success/error messages using `ion-toast`.

## 7. Local Cache & UI Update
- On successful save:
    - Update `idb` cache using `storeMapNodes`.
    - Refresh `mapMarkerStore` to show updated data.
    - Exit editing mode.

## 8. Internationalization
- Add translations for new labels, hints, and messages in `src/locales/de.json` and `src/locales/en.json`.
