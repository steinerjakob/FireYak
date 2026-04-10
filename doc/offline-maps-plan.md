# Offline Maps Implementation Plan

## Overview

Add offline map functionality to FireYak using Protomaps (PMTiles) and MapLibre. Users select a geographic area (e.g. Austria / Lower Austria), the app downloads the required vector tile data and OSM fire hydrant nodes, and stores them locally for offline use.

---

## Architecture

```mermaid
graph TD
    A[User opens Settings] --> B[Select Offline Area\ne.g. Austria > Lower Austria]
    B --> C{Download Trigger}
    C --> D[Fetch PMTiles tiles\nvia HTTP Range Requests]
    C --> E[Fetch OSM fire_hydrant data\nvia Overpass API]
    D --> F{Platform?}
    E --> G[IndexedDB / idb\nalready in use]
    F -->|Web/PWA| H[OPFS\nOrigin Private File System]
    F -->|Native iOS/Android| I[@capacitor/filesystem\nDirectory.Data]
    H --> J[MapLibre custom protocol\nserves tiles from OPFS]
    I --> J
    G --> K[Overlaid as GeoJSON layer]
    J --> L[Offline-capable Map]
    K --> L
```

---

## 1. Protomaps Data Source (No Self-Hosting)

**Recommended: [OpenFreeMap](https://openfreemap.org/)** — completely free, no API key required:

```
https://tiles.openfreemap.org/planet
```

This file supports **HTTP Range Requests**, meaning we fetch only the tile byte ranges for a specific bounding box — not the entire planet file.

Alternatively, **Protomaps Builds CDN** at `https://build.protomaps.com/` provides monthly extracts but requires a free API key for production use.

> **Key insight**: PMTiles is designed for range requests. The `pmtiles` npm library fetches specific tile byte ranges from a remote file. We exploit this to download only the tiles for Lower Austria without touching the rest of the planet.

---

## 2. Area Definition

Define offline areas in a new store `src/store/offlineMapStore.ts`:

```typescript
interface OfflineArea {
  id: string;
  nameKey: string;           // i18n key
  bbox: [number, number, number, number]; // [west, south, east, north]
  minZoom: number;
  maxZoom: number;           // 14 gives road-level detail
  estimatedSizeMB: number;
}

const OFFLINE_AREAS: OfflineArea[] = [
  {
    id: 'at-noe',
    nameKey: 'offline.areas.at_noe',
    bbox: [14.45, 47.52, 17.08, 48.99],   // Lower Austria
    minZoom: 0,
    maxZoom: 14,
    estimatedSizeMB: 180,
  },
  {
    id: 'at',
    nameKey: 'offline.areas.at',
    bbox: [9.53, 46.37, 17.16, 49.02],    // All of Austria
    minZoom: 0,
    maxZoom: 12,
    estimatedSizeMB: 420,
  },
  // Additional areas as needed
];
```

Tile enumeration for a bbox uses the standard slippy map formula — for each zoom level, calculate the x/y tile range from the lat/lng bounds.

---

## 3. Storage Strategy

### Web / PWA — OPFS (Origin Private File System)

```typescript
const root = await navigator.storage.getDirectory();
const fileHandle = await root.getFileHandle('at-noe.pmtiles', { create: true });
const writable = await fileHandle.createWritable();
await writable.write(downloadedBuffer);
await writable.close();
```

OPFS advantages over IndexedDB for large binary data:
- Handles 100s of MB efficiently
- Persistent across sessions
- Accessible from Web Workers (critical for MapLibre's worker thread)
- Not counted against the same storage quotas as IndexedDB

### Native iOS/Android — `@capacitor/filesystem`

```typescript
import { Filesystem, Directory } from '@capacitor/filesystem';

await Filesystem.writeFile({
  path: 'offline/at-noe.pmtiles',
  data: base64EncodedChunk,
  directory: Directory.Data,
  recursive: true,
});
```

On native, this returns a `file://` URI that MapLibre can use directly.

### Platform Abstraction

Create `src/helper/offlineStorage.ts` that abstracts over OPFS (web) vs Filesystem (native):

```typescript
interface OfflineStorageAdapter {
  write(key: string, data: ArrayBuffer): Promise<void>;
  read(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSize(key: string): Promise<number>;
}
```

---

## 4. Download Flow with Progress

```typescript
// src/helper/pmtilesDownloader.ts
import { PMTiles } from 'pmtiles';

async function downloadAreaTiles(
  area: OfflineArea,
  sourceUrl: string,
  onProgress: (pct: number) => void
) {
  const remotePmtiles = new PMTiles(sourceUrl);
  const tileIds = enumerateTilesForBbox(area.bbox, area.minZoom, area.maxZoom);

  let completed = 0;
  const BATCH_SIZE = 50;

  for (let i = 0; i < tileIds.length; i += BATCH_SIZE) {
    const batch = tileIds.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (tileId) => {
      const tileData = await remotePmtiles.getZxy(tileId.z, tileId.x, tileId.y);
      await storeTileLocally(area.id, tileId, tileData);
    }));
    completed += batch.length;
    onProgress(completed / tileIds.length);
  }
}

function enumerateTilesForBbox(
  bbox: [number, number, number, number],
  minZoom: number,
  maxZoom: number
): { z: number; x: number; y: number }[] {
  const tiles: { z: number; x: number; y: number }[] = [];
  const [west, south, east, north] = bbox;

  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = lng2tile(west, z);
    const xMax = lng2tile(east, z);
    const yMin = lat2tile(north, z); // note: north gives smaller y
    const yMax = lat2tile(south, z);

    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

function lng2tile(lng: number, zoom: number): number {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
}

function lat2tile(lat: number, zoom: number): number {
  return Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
}
```

The Pinia store tracks `downloadProgress: { areaId: string, pct: number } | null` reactively, feeding the UI progress bar.

---

## 5. MapLibre Custom Protocol Handler

After download, register a custom protocol so MapLibre reads from local storage:

```typescript
import maplibregl from 'maplibre-gl';
import { PMTiles, Protocol } from 'pmtiles';

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// When offline data exists, swap the source URL:
const mapStyle = {
  sources: {
    openmaptiles: {
      type: 'vector',
      url: isOffline
        ? 'pmtiles://local://at-noe'   // served from OPFS/Filesystem
        : 'pmtiles://https://tiles.openfreemap.org/planet',
    },
  },
};
```

The `local://` protocol handler intercepts requests and reads the tile from OPFS or Filesystem instead of network.

---

## 6. OSM Fire Hydrant Pre-fetch

Extends existing `src/mapHandler/overPassApi.ts` and `src/mapHandler/databaseHandler.ts`:

```typescript
async function fetchHydrantsForArea(area: OfflineArea): Promise<void> {
  const query = `
    [out:json][timeout:90];
    node["emergency"="fire_hydrant"]
      (${area.bbox[1]},${area.bbox[0]},${area.bbox[3]},${area.bbox[2]});
    out body;
  `;
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
  });
  const data = await response.json();
  // Store in IndexedDB with area tag for later retrieval
  await storeHydrantsForOfflineArea(area.id, data.elements);
}
```

The existing `idb` infrastructure in `src/mapHandler/databaseHandler.ts` needs an `areaId` index to differentiate pre-fetched data from live-fetched data.

---

## 7. Settings Page Integration

In `src/views/SettingsView.vue`, add an "Offline Maps" section:

```
┌────────────────────────────────────────┐
│  Offline Maps                          │
│                                        │
│  ✅ Lower Austria     180 MB  [↑] [🗑] │
│  ○  Upper Austria     165 MB       [↓] │
│  ○  Austria (full)    420 MB       [↓] │
│                                        │
│  Storage used: 180 MB of 2.1 GB avail  │
└────────────────────────────────────────┘
```

The store exposes:
- `downloadedAreas: string[]` — list of area IDs stored locally
- `downloadProgress: { areaId: string, pct: number } | null`
- `totalStorageUsed: number` — from OPFS `getFile().size` sum

Clear deletes the OPFS/Filesystem file + scoped IndexedDB entries. Update re-runs the download flow.

---

## 8. UI Components

### Download Progress Component

New component `src/components/OfflineMapDownload.vue`:

```vue
<template>
  <ion-card v-if="offlineStore.downloadProgress">
    <ion-card-header>
      <ion-card-title>{{ $t('offline.downloading') }}</ion-card-title>
    </ion-card-header>
    <ion-card-content>
      <p>{{ currentAreaName }}</p>
      <ion-progress-bar :value="offlineStore.downloadProgress.pct" />
      <p>{{ Math.round(offlineStore.downloadProgress.pct * 100) }}%</p>
      <ion-button fill="outline" color="danger" @click="offlineStore.cancelDownload()">
        {{ $t('offline.cancel') }}
      </ion-button>
    </ion-card-content>
  </ion-card>
</template>
```

### Area Selection Component

New component `src/components/OfflineAreaSelector.vue`:

```vue
<template>
  <ion-list>
    <ion-list-header>
      <ion-label>{{ $t('offline.selectArea') }}</ion-label>
    </ion-list-header>
    <ion-item v-for="area in offlineAreas" :key="area.id">
      <ion-icon
        :icon="offlineStore.isDownloaded(area.id) ? checkmarkCircle : downloadOutline"
        slot="start"
      />
      <ion-label>
        <h2>{{ $t(area.nameKey) }}</h2>
        <p>~{{ area.estimatedSizeMB }} MB</p>
      </ion-label>
      <ion-button
        v-if="!offlineStore.isDownloaded(area.id)"
        slot="end"
        fill="clear"
        @click="offlineStore.downloadArea(area)"
      >
        <ion-icon :icon="downloadOutline" />
      </ion-button>
      <ion-button
        v-else
        slot="end"
        fill="clear"
        color="danger"
        @click="offlineStore.deleteArea(area.id)"
      >
        <ion-icon :icon="trashOutline" />
      </ion-button>
    </ion-item>
  </ion-list>
</template>
```

---

## 9. Required New Packages

| Package | Purpose |
|---|---|
| `pmtiles` | PMTiles range-request fetching + MapLibre protocol |
| `maplibre-gl` | Vector tile map renderer (replaces or augments Leaflet) |
| `@capacitor/filesystem` | Native file write (if not already installed) |

Install:
```bash
npm install pmtiles maplibre-gl @capacitor/filesystem
```

---

## 10. File Structure (New/Modified)

```
src/
├── store/
│   └── offlineMapStore.ts          # NEW — area definitions, download state, storage metadata
├── helper/
│   ├── offlineStorage.ts           # NEW — platform-aware OPFS vs Filesystem abstraction
│   ├── pmtilesDownloader.ts        # NEW — bbox tile enumeration + batch HTTP range fetch
│   └── tileEnumeration.ts          # NEW — slippy map tile math utilities
├── components/
│   ├── OfflineMapDownload.vue      # NEW — download progress indicator
│   └── OfflineAreaSelector.vue     # NEW — area selection list
├── mapHandler/
│   ├── databaseHandler.ts          # MODIFIED — add areaId index for pre-fetched hydrants
│   └── overPassApi.ts              # MODIFIED — add area-scoped hydrant pre-fetch
├── views/
│   └── SettingsView.vue            # MODIFIED — add Offline Maps section
├── locales/
│   ├── en.json                     # MODIFIED — add offline.* keys
│   └── de.json                     # MODIFIED — add offline.* keys
└── components/
    └── MainMap.vue                 # MODIFIED — wire MapLibre protocol handler
```

---

## 11. Key Challenges & Mitigations

| Challenge | Mitigation |
|---|---|
| PMTiles files can be 100s of MB | Cap maxZoom at 14, restrict to bbox only |
| OPFS not in older browsers | Feature-detect; fall back to tile-by-tile IndexedDB store |
| Download interruption | Track downloaded tile IDs in IndexedDB; resume from last checkpoint |
| Overpass timeout for large areas | Split bbox into sub-queries or use `[maxsize:1073741824]` |
| Capacitor large file base64 overhead | Write in 1 MB chunks using `Filesystem.appendFile` |
| MapLibre worker thread needs OPFS access | Use `FileSystemSyncAccessHandle` in worker context |

---

## 12. Implementation Order

1. **`src/store/offlineMapStore.ts`** — area definitions, download state, storage metadata
2. **`src/helper/offlineStorage.ts`** — platform-aware OPFS vs Filesystem wrapper
3. **`src/helper/tileEnumeration.ts`** — bbox → tile ID enumeration utilities
4. **`src/helper/pmtilesDownloader.ts`** — batch tile fetch with progress callback
5. **`src/components/MainMap.vue`** — wire MapLibre custom protocol handler for `local://` tiles
6. **`src/components/OfflineMapDownload.vue`** — progress UI component
7. **`src/components/OfflineAreaSelector.vue`** — area selection list component
8. **`src/views/SettingsView.vue`** — integrate offline section with clear/update controls
9. **`src/mapHandler/databaseHandler.ts`** — extend with `areaId` index for pre-fetched hydrant data
10. **`src/mapHandler/overPassApi.ts`** — add area-scoped hydrant pre-fetch function
11. **`src/locales/en.json` + `de.json`** — add translation keys

---

## 13. Estimated Tile Counts

For reference, approximate tile counts per zoom level for Lower Austria bbox `[14.45, 47.52, 17.08, 48.99]`:

| Zoom | Tiles | Approx Size |
|---|---|---|
| 0–6 | ~50 | < 1 MB |
| 7–10 | ~800 | ~5 MB |
| 11–12 | ~3,200 | ~20 MB |
| 13 | ~6,400 | ~40 MB |
| 14 | ~25,600 | ~120 MB |
| **Total** | **~36,000** | **~180 MB** |

These are estimates — actual sizes depend on the level of detail in the vector tiles for the given area.
