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
- **GitHub:** [![Get it on GitHub](https://img.shields.io/badge/Get_it_on-GitHub-grey?logo=github)](https://github.com/steinerjakob/FireYak/releases/latest)
- **iOS:** Use the web app https://app.fireyak.org

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
