<p align="center"><img src="logo.png" alt="logo" width="150"/></p>

# FireYak

FireYak helps fire departments quickly find the nearest usable water source (e.g. fire hydrants, suction points, water tanks, fire water ponds, fire stations) based on **OpenStreetMap** data.

All water source data comes from the community-driven project [OpenStreetMap](https://www.openstreetmap.org).  
If a hydrant or water source is missing or incorrect, you can improve it directly in OpenStreetMap (see below).

---

## Apps

You can access FireYak through the web app or Android app:

- **Web:** https://app.fireyak.org
- **Android:** https://play.google.com/store/apps/details?id=at.jst.fireyak
- **iOS:** Currently not available (requires an Apple Developer account and macOS).

The web app is a Progressive Web App (PWA) and can be installed to the home screen on most modern browsers.

---

## Support

If you find FireYak useful, please consider supporting it:

<a href="https://www.buymeacoffee.com/steinerjakob" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
       alt="Buy Me A Coffee"
       style="height: 60px !important;width: 217px !important;">
</a>

You can also:

- Star the project on GitHub
- Report issues and improvement ideas
- Contribute code or documentation

---

## Features

### Interactive map of water sources

- Displays nearby water sources using OpenStreetMap data:
  - `emergency=fire_hydrant`
  - `emergency=water_tank`
  - `emergency=suction_point`
  - `emergency=fire_water_pond`
  - `amenity=fire_station`
- Different icons for hydrants, suction points, water tanks, ponds and fire stations.
- Map view and last position are restored on reopen.
- Dark mode support.

### Detailed marker information

When you tap/click a marker, FireYak shows:

- Hydrant / water source type (pillar, underground, wall, pond, etc.)
- Pipe diameter, pressure, flow capacity / flow rate
- Couplings (type, diameters)
- Water source type (main, pond, stream, river, lake, tank, well, etc.)
- Capacity/volume where tagged
- Reference number, operator, name and address (if available)
- Access, notes, survey date, coordinates and OSM ID

You can:

- Open the object directly on **openstreetmap.org**.
- Open the object in the **OSM editor** to improve the data.
- Start navigation to the location (mobile & desktop).
- Share a link to the marker.

### Nearby water sources

- Use your current location to list the **nearest water sources** (e.g. nearest hydrants).
- Distance display in meters/kilometres.
- Rough estimation of the required number of B-hoses based on configured hose length.
- Quick selection of a nearby source to see full details.

### Supply pipe / relay pump calculation

FireYak includes a **relay pump / supply pipe calculator**:

- Set:
  - **Fire object** (target point)
  - **Suction point** (water source)
  - Optional **waypoints** (route via streets, terrain, etc.)
- Uses elevation data to estimate:
  - Real (3D) hose distance along the route
  - Elevation difference between suction and fire object
- Calculates:
  - Approximate number of B-hoses required
  - Number and positions of intermediate pumps
  - For each pump and for the fire object:
    - Distance from suction point
    - Elevation gain
    - Pressure at the pump / inlet

Configuration:

- Adjustable:
  - Output pressure
  - Minimum input pressure
  - Pressure loss per meter (depending on flow rate)

### Photos

If photos exist on Wikimedia Commons using the naming pattern  
`Fire-fighting-facility node-<OSM_ID>`, FireYak can show them in a gallery for the selected marker.

### Localization

- English
- German

---

## How to add a fire hydrant (or other water source) to OpenStreetMap

FireYak only displays what is in OpenStreetMap.  
If a hydrant or water source is missing or incorrect, you can fix it yourself in a few minutes.

Below is a basic guide using the standard **iD editor** on openstreetmap.org.

### 1. Create / log in to your OpenStreetMap account

1. Go to https://www.openstreetmap.org
2. Click **Sign Up** (or **Log In** if you already have an account).
3. Verify your email and sign in.

### 2. Find the correct location

1. Use the search or manually move the map to the location of the hydrant.
2. Zoom in until you clearly see the street/building structure.

### 3. Start editing

1. Click the **Edit** button at the top.
2. If asked, choose **"Edit with iD (in-browser editor)"**.
3. Wait until the editor has loaded.

### 4. Add a fire hydrant

1. In the iD editor toolbar, choose **Point** (or the “+” to add a point).
2. Click on the exact location of the hydrant on the map.
3. In the left panel, search for **"Fire Hydrant"** or select it from the presets.
4. The editor will set the primary tag:
   - `emergency=fire_hydrant`

#### Recommended additional tags

To make the hydrant as useful as possible for FireYak and other emergency tools, please follow the official OpenStreetMap tagging guidelines instead of this README:

- General hydrant tagging:  
  https://wiki.openstreetmap.org/wiki/Tag:emergency%3Dfire_hydrant
- Hydrant type and position keys (e.g. `fire_hydrant:type=*`, `fire_hydrant:position=*`):  
  https://wiki.openstreetmap.org/wiki/Key:fire_hydrant:type  
  https://wiki.openstreetmap.org/wiki/Key:fire_hydrant:position
- Additional hydrant-related keys (diameter, pressure, flow, couplings, etc.):  
  https://wiki.openstreetmap.org/wiki/Key:fire_hydrant:diameter  
  https://wiki.openstreetmap.org/wiki/Key:fire_hydrant:pressure  
  https://wiki.openstreetmap.org/wiki/Key:fire_hydrant:flow_capacity

For general water source tagging see:

- `water_source=*`:  
  https://wiki.openstreetmap.org/wiki/Key:water_source

The iD editor provides fields for many of these; others can be added under **All tags**.

### 5. Add other water sources

FireYak also uses the following objects from OpenStreetMap:

- **Suction point** – see  
  https://wiki.openstreetmap.org/wiki/Tag:emergency%3Dsuction_point
- **Water tank** – see  
  https://wiki.openstreetmap.org/wiki/Tag:emergency%3Dwater_tank
- **Fire water pond** – see  
  https://wiki.openstreetmap.org/wiki/Tag:emergency%3Dfire_water_pond
- **Fire station** – see  
  https://wiki.openstreetmap.org/wiki/Tag:amenity%3Dfire_station

For names, operators, access restrictions and capacities/volumes, please also refer to the relevant OSM wiki pages (e.g. `name=*`, `operator=*`, `access=*`, `capacity=*`, `volume=*`) for up‑to‑date recommendations.

### 6. Save your changes

1. Click **Save** in the top right of the iD editor.
2. Add a short **changeset comment**, e.g.  
   `Added fire hydrant for local fire department` or `Improved hydrant data (diameter, pressure)`.
3. Click **Upload**.

Within a short time, FireYak will start using the updated data (depending on the Overpass API and cache).

---

## For developers

### Tech stack

- **Frontend:** Vue 3 + Ionic Vue
- **Language:** TypeScript
- **State:** Pinia
- **Routing:** vue-router
- **Maps:** Leaflet + marker clustering
- **Storage:** IndexedDB (via `idb`) for caching map data
- **PWA:** Vite + `vite-plugin-pwa`
- **Mobile:** Capacitor (Android)

### Setup

```bash
# install dependencies
npm install
```

### Run in development

```bash
npm run dev
```

Then open the printed URL (typically http://localhost:5173) in your browser.

### Build

```bash
# build web app
npm run build
```

The Android project lives in the `android` directory and can be built with Gradle/Android Studio as usual.

---

## License

This project is released under the terms of the **MIT License**.  
See the [`LICENSE`](LICENSE) file for details.
