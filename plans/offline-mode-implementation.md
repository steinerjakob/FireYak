# Plan: Full Offline Mode (Phases 4a + 4b)

Detailed implementation plan for the offline features outlined in
`project-review-improvements.md` §4.1/§4.2. Written 2026-07-03. Code snippets
are illustrative starting points — verify against the codebase state at
implementation time (the phase 1–3 stack may have shifted details).

**Goal:** a fire brigade pre-downloads its district once and FireYak is fully
usable without connectivity: base map renders, water source markers show,
marker info opens, nearby-sources works, and edits made offline are synced to
OSM later.

**Prerequisites (already planned/implemented in the phase 1–3 stack):**

- Overpass instance pool + POST + bbox clamp (`feature/overpass-reliability`)
- `fetchedAt` per node, DB v2, freshness registry (`feature/cache-freshness`)
- Network/offline detection groundwork (`feature/fetch-error-feedback`,
  `src/composable/onlineStatus.ts` — to be superseded by §1.4 below)

**Decided approach for tiles:** own tile store + `maplibregl.addProtocol`
(Option B — see §4.1b of the review plan). Tile source is the existing
`api.protomaps.com` endpoint; PMTiles extracts are a later refinement if
quota/terms ever require it.

---

## Part 1 — Phase 4a: Offline data areas + edit queue

### 1.1 Data model (IndexedDB, bump `FireMarker` DB to v3)

New object stores in `src/mapHandler/databaseHandler.ts`:

```ts
export interface OfflineArea {
	id?: number;
	name: string;
	bounds: GeoBounds;
	createdAt: number;
	lastRefreshedAt: number | null;
	includeSatellite: boolean;
	includeTerrain: boolean;
	nodeCount: number;
	tileCount: number;
	sizeBytes: number;
	status: 'downloading' | 'ready' | 'error' | 'refreshing';
	progress: { done: number; total: number };
	/** Resume info: index of the last successfully completed data chunk. */
	lastCompletedChunk: number;
}

export interface PendingEdit {
	localId?: number;
	action: 'create' | 'update' | 'delete';
	elementType: 'node';
	/** Negative temp ID for creates (-1, -2, …), real OSM ID otherwise. */
	osmId: number;
	/** Snapshot of the tags at edit time — used for conflict detection. */
	baseTags: Record<string, string> | null;
	tags: Record<string, string>;
	lat: number;
	lon: number;
	createdAt: number;
	status: 'pending' | 'uploading' | 'conflict' | 'error';
	errorMessage?: string;
}

const dbPromise = openDB('FireMarker', 3, {
	upgrade(db, oldVersion) {
		if (oldVersion < 1) {
			// v1: fireMarker store — as today (keyPath 'id', 'lat, lon' index)
		}
		if (oldVersion < 2) {
			// v2 (feature/cache-freshness): 'fetchedAt' index, drop redundant 'id' index
		}
		if (oldVersion < 3) {
			db.createObjectStore('offlineAreas', { keyPath: 'id', autoIncrement: true });
			const edits = db.createObjectStore('pendingEdits', {
				keyPath: 'localId',
				autoIncrement: true
			});
			edits.createIndex('status', 'status');
		}
	}
});
```

Marker nodes themselves stay in the existing `fireMarker` store. **Pruning
rule change:** the startup prune (§2.2 of the review plan) must skip nodes
whose coordinates fall inside any `offlineAreas.bounds` — membership is
computed by bounds check, no per-node area bookkeeping needed:

```ts
const areas = await getAllOfflineAreas();
const isProtected = (p: GeoPoint) => areas.some((a) => boundsContains(a.bounds, p));
```

### 1.2 Area data download (`src/offline/areaDataDownloader.ts`)

⚠️ **Do not call `fetchMarkerData` from the downloader.** It aborts the
previous in-flight area query via a module-level `AbortController`
(supersession for map panning) — a user panning the map would kill the
download, and vice versa. Export a lower-level function from
`overPassApi.ts` that shares the instance pool/POST/cool-down logic but takes
its own signal:

```ts
// overPassApi.ts — new export, used only by the offline downloader
export async function fetchAreaRaw(
	bounds: GeoBounds,
	signal: AbortSignal
): Promise<OverPassElement[]> {
	return fetchFromPool(buildAreaQuery(bounds), signal); // throws on failure
}
```

Chunked download with resume:

```ts
function* chunkBounds(b: GeoBounds, step = 0.25): Generator<GeoBounds> {
	for (let s = b.south; s < b.north; s += step) {
		for (let w = b.west; w < b.east; w += step) {
			yield {
				south: s,
				west: w,
				north: Math.min(s + step, b.north),
				east: Math.min(w + step, b.east)
			};
		}
	}
}

export async function downloadAreaData(area: OfflineArea, signal: AbortSignal) {
	const chunks = [...chunkBounds(area.bounds)];
	for (let i = area.lastCompletedChunk + 1; i < chunks.length; i++) {
		const elements = await retry(() => fetchAreaRaw(chunks[i], signal), 2);
		await storeMapNodes(elements); // sets fetchedAt (DB v2)
		await updateArea(area.id!, {
			lastCompletedChunk: i,
			progress: { done: i + 1, total: chunks.length }
		});
		await sleep(1000); // be polite to Overpass between chunks
	}
}
```

- Chunk failure after retries → mark the area `error`; "Retry" resumes at
  `lastCompletedChunk + 1`, it does not restart.
- Refresh = same flow (reset `lastCompletedChunk`); reconcile deletions per
  chunk with the existing truncation-guarded `reconcileDeletedNodes`.

### 1.3 Offline edit queue (`src/offline/editQueue.ts`)

Current behavior: `markerEditStore.saveMarker()` / `deleteMarker()` upload a
changeset immediately via `osm-api` and fail hard offline.

**Enqueue path** — when `!isOnline.value` (or the upload fails with a network
error), write a `pendingEdits` record instead of failing:

```ts
let nextTempId = -1; // initialise from min existing temp id at startup

export async function enqueueEdit(
	edit: Omit<PendingEdit, 'localId' | 'createdAt' | 'status'>
): Promise<void> {
	const db = await dbPromise;
	await db.add('pendingEdits', { ...edit, createdAt: Date.now(), status: 'pending' });

	// Optimistic cache update so the map reflects the edit immediately
	if (edit.action === 'delete') {
		await deleteMapNode(edit.osmId); // existing soft-delete
	} else {
		await storeMapNodes([
			{ id: edit.osmId, type: 'node', lat: edit.lat, lon: edit.lon, tags: edit.tags }
		]);
	}
}
```

- create → `osmId = nextTempId--` (negative temp IDs never collide with OSM).
- update → store `baseTags` (the tags as fetched) for conflict detection.
  `OverPassElement` has **no `version` field** (the area query uses
  `out qt center … tags`, not `out meta`) — so conflicts are detected by
  comparing the server's current tags against `baseTags` at sync time instead
  of by version number. (Alternative considered: add `meta` to the Overpass
  output — rejected, it inflates every area query for a rare need.)

**Sync engine** — runs on app start, on `onOnline()`, and via a manual "Sync
now" button:

```ts
export async function processQueue(): Promise<void> {
	const edits = await getEditsByStatus('pending'); // FIFO by localId
	for (const edit of edits) {
		await setStatus(edit.localId!, 'uploading');
		try {
			switch (edit.action) {
				case 'create': {
					// Mirror markerEditStore.saveMarker()'s osm-api changeset call
					const newId = await uploadCreate(edit);
					await remapTempId(edit.osmId, newId); // fireMarker cache + later queue entries
					break;
				}
				case 'update': {
					const server = await fetchNodeById(edit.osmId);
					if (server && edit.baseTags && !tagsEqual(server.tags, edit.baseTags)) {
						await setStatus(edit.localId!, 'conflict');
						continue; // never auto-overwrite concurrent edits
					}
					await uploadUpdate(edit);
					break;
				}
				case 'delete': {
					try {
						await uploadDelete(edit);
					} catch (e) {
						if (!isAlreadyDeleted(e)) throw e; // HTTP 410 → treat as success
					}
					break;
				}
			}
			await removeEdit(edit.localId!);
		} catch (e) {
			if (isNetworkError(e)) {
				await setStatus(edit.localId!, 'pending');
				return; // still offline — stop, retry on next onOnline()
			}
			await setStatus(edit.localId!, 'error', String(e));
		}
	}
}
```

- One changeset per sync run where the `osm-api` usage allows batching
  (comment: `"FireYak offline sync"`); otherwise one changeset per edit is
  acceptable for v1.
- Conflict UI: list entry shows local vs. server tags; actions "apply mine
  anyway" (re-enqueue with `baseTags = server.tags`) / "discard" (drop entry,
  re-fetch node into cache).
- **UI:** badge with pending count (settings FAB / SettingsView), a "Pending
  changes" list (type icon, tag summary, retry / discard), toast on
  successful sync.
- Queue entries and their cached nodes are exempt from pruning.

### 1.4 Network status service (`src/composable/networkStatus.ts`)

Add `@capacitor/network` (web support wraps `navigator.onLine`; native also
reports connection type for the Wi-Fi-only rule). Replaces/absorbs the
phase-2 `onlineStatus.ts` composable — keep the same `isOnline` export name so
call sites don't churn.

```ts
import { readonly, ref } from 'vue';
import { Network } from '@capacitor/network';

const isOnline = ref(true);
const connectionType = ref<'wifi' | 'cellular' | 'none' | 'unknown'>('unknown');
const onlineCallbacks = new Set<() => void>();
let initialized = false;

async function init() {
	if (initialized) return;
	initialized = true;
	const status = await Network.getStatus();
	isOnline.value = status.connected;
	connectionType.value = status.connectionType;
	Network.addListener('networkStatusChange', (s) => {
		const wasOffline = !isOnline.value;
		isOnline.value = s.connected;
		connectionType.value = s.connectionType;
		if (wasOffline && s.connected) onlineCallbacks.forEach((cb) => cb());
	});
}

export function useNetworkStatus() {
	init();
	return {
		isOnline: readonly(isOnline),
		connectionType: readonly(connectionType),
		onOnline(cb: () => void) {
			onlineCallbacks.add(cb);
			return () => onlineCallbacks.delete(cb);
		}
	};
}
```

### 1.5 UI — offline area management

- **Settings → "Offline areas"** (`src/views/OfflineAreasView.vue`, route
  `/settings/offline-areas`):
  - List of areas: name, size, node/tile counts, last refresh, status,
    progress bar while downloading; actions: refresh, rename, delete.
  - "Add area" → map picker mode: reuse `MainMap` with a rectangle overlay
    the user pans/zooms into place ("download current view"), plus a radius
    preset around the fire station/current location (2/5/10 km). Show the
    size estimate before starting (§2.6).
  - Per-area toggles at creation: include satellite, include terrain
    (default off).
- Refresh policy: manual always; "auto-refresh on Wi-Fi when older than 30
  days" as a per-area toggle (`connectionType === 'wifi'` on native).
- i18n: all new strings in `src/locales/en.json` + `de.json`.

---

## Part 2 — Phase 4b: Offline map tiles

### 2.1 Tile store abstraction (`src/offline/tileStore.ts`)

```ts
export interface TileStore {
	get(source: string, z: number, x: number, y: number): Promise<Blob | null>;
	/** areaId adds a reference; write-through puts (protocol cache) pass no areaId. */
	put(
		source: string,
		z: number,
		x: number,
		y: number,
		data: Blob,
		opts?: { areaId?: number }
	): Promise<void>;
	has(source: string, z: number, x: number, y: number): Promise<boolean>;
	addAreaRef(source: string, z: number, x: number, y: number, areaId: number): Promise<void>;
	/** Removes areaId refs; deletes tiles whose ref list becomes empty. */
	deleteArea(areaId: number): Promise<void>;
	sizeBytes(): Promise<number>;
}
```

IndexedDB implementation (web) — separate DB so the marker DB stays small:

```ts
const tileDb = openDB('FireTiles', 1, {
	upgrade(db) {
		// out-of-line key: `${source}/${z}/${x}/${y}`
		const store = db.createObjectStore('tiles');
		store.createIndex('areaIds', 'areaIds', { multiEntry: true });
	}
});
const key = (s: string, z: number, x: number, y: number) => `${s}/${z}/${x}/${y}`;

export const idbTileStore: TileStore = {
	async get(s, z, x, y) {
		const rec = await (await tileDb).get('tiles', key(s, z, x, y));
		return rec?.blob ?? null;
	},
	async put(s, z, x, y, blob, opts = {}) {
		const db = await tileDb;
		const k = key(s, z, x, y);
		const existing = await db.get('tiles', k);
		const areaIds = new Set<number>(existing?.areaIds ?? []);
		if (opts.areaId != null) areaIds.add(opts.areaId);
		await db.put('tiles', { blob, areaIds: [...areaIds], fetchedAt: Date.now() }, k);
	}
	// has / addAreaRef / deleteArea (cursor over 'areaIds' index) / sizeBytes analogous
};
```

- Call `navigator.storage.persist()` when the first area download starts, to
  opt out of best-effort eviction on the web.
- **Native:** Capacitor Filesystem under `Directory.Data`
  (`offline-tiles/{source}/{z}/{x}/{y}.bin`) with a small IDB index for
  `areaIds`/size bookkeeping — avoids WKWebView IndexedDB size pressure on
  iOS. Same `TileStore` interface; pick the impl via
  `Capacitor.isNativePlatform()`.

### 2.2 Custom protocol (`src/offline/offlineProtocol.ts`)

Register once at app start (before the map is constructed), MapLibre v5 API:

```ts
import maplibregl, { GetResourceResponse, RequestParameters } from 'maplibre-gl';

const PROTOMAPS_API_KEY = import.meta.env.VITE_PROTOMAPS_API_KEY;

const NETWORK_URL: Record<string, (z: number, x: number, y: number) => string> = {
	protomaps: (z, x, y) => `https://api.protomaps.com/tiles/v4/${z}/${x}/${y}.mvt?key=${PROTOMAPS_API_KEY}`,
	satellite: (z, x, y) =>
		`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
	terrain: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.png` // verify template
};

export function registerOfflineProtocol(store: TileStore) {
	maplibregl.addProtocol(
		'offline',
		async (
			params: RequestParameters,
			abort: AbortController
		): Promise<GetResourceResponse<ArrayBuffer>> => {
			const m = params.url.match(/^offline:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/);
			if (!m) throw new Error(`Bad offline URL: ${params.url}`);
			const [, source, zs, xs, ys] = m;
			const [z, x, y] = [+zs, +xs, +ys];

			const cached = await store.get(source, z, x, y);
			if (cached) return { data: await cached.arrayBuffer() };

			try {
				const resp = await fetch(NETWORK_URL[source](z, x, y), { signal: abort.signal });
				if (!resp.ok) throw new Error(`Tile ${resp.status}`);
				const buf = await resp.arrayBuffer();
				// Write-through only for tiles inside a downloaded area (keeps areas warm
				// without turning the store into an unbounded browse cache)
				if (await isInsideDownloadedArea(source, z, x, y)) {
					await store.put(source, z, x, y, new Blob([buf]));
				}
				return { data: buf };
			} catch {
				// Offline and not cached → empty tile: MapLibre renders a gap, not an error
				return { data: new ArrayBuffer(0) };
			}
		}
	);
}
```

**Style change in `MainMap.vue` (`getProtomapsStyle`)** — the `protomaps`
source switches from the TileJSON `url:` form to an explicit tile template
(TileJSON metadata can't be fetched offline, so it must be inlined). One code
path for online and offline:

```text
// before
protomaps: {
	type: 'vector',
	url: `https://api.protomaps.com/tiles/v4.json?key=${PROTOMAPS_API_KEY}`,
	attribution: '…'
}
// after
protomaps: {
	type: 'vector',
	tiles: ['offline://protomaps/{z}/{x}/{y}'],
	minzoom: 0,
	maxzoom: 15,
	attribution: '…'
}
```

Same pattern for the satellite and terrain sources when enabled.

**Glyphs & sprites:** MapLibre allows custom protocols for these too. Route
`glyphs`/`sprite` through e.g. `offline://assets/{path}` with write-through
caching; the area download additionally prefetches the sprite JSON/PNG
(@1x + @2x) and the glyph ranges used by the style's fonts (`Noto Sans
Regular/Medium/Italic`; ranges 0–255 at minimum plus ranges needed by the app
locales).

### 2.3 Tile math (`src/offline/tileMath.ts`)

```ts
export interface TileCoord {
	z: number;
	x: number;
	y: number;
}

export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
	const n = 2 ** z;
	const x = Math.floor(((lng + 180) / 360) * n);
	const latRad = (lat * Math.PI) / 180;
	const y = Math.floor(
		((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
	);
	return { x: Math.min(Math.max(x, 0), n - 1), y: Math.min(Math.max(y, 0), n - 1) };
}

/** Iterator, not array — z15+ lists get large. */
export function* tilesForBounds(b: GeoBounds, zMin: number, zMax: number): Generator<TileCoord> {
	for (let z = zMin; z <= zMax; z++) {
		const min = lngLatToTile(b.west, b.north, z); // top-left
		const max = lngLatToTile(b.east, b.south, z); // bottom-right
		for (let x = min.x; x <= max.x; x++) {
			for (let y = min.y; y <= max.y; y++) yield { z, x, y };
		}
	}
}

export function tileCount(b: GeoBounds, zMin: number, zMax: number): number {
	let count = 0;
	for (let z = zMin; z <= zMax; z++) {
		const min = lngLatToTile(b.west, b.north, z);
		const max = lngLatToTile(b.east, b.south, z);
		count += (max.x - min.x + 1) * (max.y - min.y + 1);
	}
	return count;
}
```

Zoom ranges: protomaps vector z0–15 (MapLibre overzooms past 15); satellite
raster capped at z17 (size!); terrain DEM z0–12 (verify Mapterhorn's actual
maxzoom used by hillshade/terrain at implementation time).

### 2.4 Tile download manager (`src/offline/tileDownloader.ts`)

Worker-pool over the shared tile iterator (single-threaded JS makes sharing
the iterator safe):

```ts
const CONCURRENCY = 6;

export async function downloadTiles(
	area: OfflineArea,
	source: string,
	zMax: number,
	signal: AbortSignal,
	onProgress: () => void
) {
	const it = tilesForBounds(area.bounds, 0, zMax)[Symbol.iterator]();
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			for (let r = it.next(); !r.done; r = it.next()) {
				if (signal.aborted) return;
				const { z, x, y } = r.value;
				if (await tileStore.has(source, z, x, y)) {
					await tileStore.addAreaRef(source, z, x, y, area.id!); // overlap: ref only
				} else {
					const resp = await fetchWithBackoff(NETWORK_URL[source](z, x, y), signal);
					await tileStore.put(source, z, x, y, await resp.blob(), { areaId: area.id! });
				}
				onProgress();
			}
		})
	);
}
```

- `fetchWithBackoff`: exponential backoff on 429/5xx, abort support
  (pause/cancel from the UI).
- Progress into `offlineAreas.progress` (tile phase after the data phase);
  resumable: persist the last completed z-level + index.
- Update `sizeBytes` incrementally (`blob.size`).

### 2.5 Offline degradation of online-only features

- Address search (Photon): disable the search bar input with an inline
  "unavailable offline" hint when `!isOnline`.
- Photos (Panoramax/Mapillary/Commons): hide the gallery section with a hint
  instead of empty loading states.
- Elevation (Open-Meteo) in the supply-pipe calculator:
  - offline default: flat-terrain estimate with a clearly visible
    "elevation ignored (offline)" label;
  - stretch goal: if the area includes terrain, decode elevations from the
    downloaded Terrarium-encoded DEM tiles in `src/helper/elevationData.ts`
    as an offline provider:

    ```ts
    // Terrarium RGB encoding (Mapterhorn / AWS terrain tiles)
    const elevationMeters = r * 256 + g + b / 256 - 32768;
    ```

- OSM edits: covered by the edit queue (Part 1).

### 2.6 Size estimation (shown before download)

```ts
const AVG_TILE_BYTES: Record<string, number> = {
	protomaps: 45_000, // calibrate with real districts during implementation
	satellite: 25_000,
	terrain: 35_000
};

export function estimateAreaBytes(area: OfflineArea): number {
	let bytes = tileCount(area.bounds, 0, 15) * AVG_TILE_BYTES.protomaps;
	if (area.includeSatellite) bytes += tileCount(area.bounds, 0, 17) * AVG_TILE_BYTES.satellite;
	if (area.includeTerrain) bytes += tileCount(area.bounds, 0, 12) * AVG_TILE_BYTES.terrain;
	return bytes;
}
```

Show a range ("30–50 MB"), not a fake exact number. Typical 20×20 km
district, vector only: ~800–900 tiles ≈ 30–50 MB.

### 2.7 Protomaps quota & terms

- Validated 2026-07-03: hosted API is free for non-commercial use, soft limit
  1M tile requests/month; offline pre-fetching neither explicitly allowed nor
  forbidden. Action item before release: short email to Protomaps describing
  the pattern (open-source emergency-services app, per-user district
  prefetch). Fallback path if needed: self-generated PMTiles extracts from
  the free daily builds (`pmtiles extract`), served per district — the
  `TileStore`/protocol abstraction keeps this swappable.

---

## Part 3 — Implementation order & branch plan

Stacked branches continuing the phase 1–3 stack:

| #   | Branch                          | Content                                                                  | Depends on |
| --- | ------------------------------- | ------------------------------------------------------------------------ | ---------- |
| 1   | `feature/network-status`        | §1.4 `@capacitor/network` composable, fold in offline banner             | phase 2    |
| 2   | `feature/offline-areas-data`    | §1.1 DB v3, §1.2 area data downloader, §1.5 management UI (data only)    | 1          |
| 3   | `feature/offline-edit-queue`    | §1.3 queue + sync engine + conflict UI + badge                           | 1          |
| 4   | `feature/offline-tile-store`    | §2.1 store, §2.2 protocol + style switch, §2.3 math (write-through only) | 1          |
| 5   | `feature/offline-tile-download` | §2.4 downloader wired into areas UI, §2.6 estimates, glyphs/sprites      | 2 + 4      |
| 6   | `feature/offline-degradation`   | §2.5 search/photos/elevation degradation                                 | 1          |

Branch 4 is intentionally shippable before 5: switching the style to the
`offline://` protocol with write-through caching already makes previously
viewed areas render offline, without any download UI.

## Part 4 — Testing checklist

- Airplane-mode walkthrough on Android + iOS + PWA: map renders in a
  downloaded area, markers tap-able, nearby-sources works, edit → queued →
  badge → sync after reconnect.
- Create-offline → sync → verify real OSM ID replaces temp ID and the marker
  survives a cache refresh.
- Conflict path: edit a node offline, change it on osm.org meanwhile, sync →
  conflict entry, both resolutions work.
- Overlapping areas: delete one, shared tiles must survive; delete both,
  store size returns to ~0.
- Download interruption (kill app mid-download) → resume works.
- Map panning during an active area download must not cancel it (and vice
  versa) — regression test for the `fetchAreaRaw` supersession split (§1.2).
- iOS storage: verify Filesystem-backed tiles survive OS storage pressure;
  web: verify `navigator.storage.persist()` is requested.
- Quota sanity: one district download stays in the low thousands of tile
  requests (log the count in dev builds).
