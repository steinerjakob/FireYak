# FireYak Water Source Data — Implementation Plan (v3)

Goal: replace Overpass as the primary read path with self-published static OSM extracts
(fire hydrants, water tanks, suction points, fire water ponds, fire stations),
bootstrapped on the Ubuntu laptop, rebuilt every 2 days on the Synology DS423+,
served from Cloudflare R2 via a custom domain (CORS-enabled, free egress).
Overpass stays as an optional best-effort freshness layer. OSM editing
(OAuth2 + offline edit queue) is untouched.

> **Why R2, not GitHub Releases (measured 2026-07-21):** release assets serve
> range requests correctly (`302` → `206`, `accept-ranges: bytes`) BUT return no
> `Access-Control-Allow-Origin` on either hop, and `OPTIONS` preflight 404s. A
> `fetch()` from the app is therefore blocked by CORS — **on native as well as
> web**, see the note below. R2 with a custom domain lets us set CORS explicitly,
> so both builds read the same URL. GitHub Releases can stay as an optional
> public archive.

> **Native does *not* get a CORS free pass in this app.** The common claim that
> Capacitor requests bypass browser CORS does not hold here:
> `capacitor.config.ts:17-19` sets `CapacitorHttp: { enabled: false }`, so
> `fetch` inside the WebView is the ordinary browser fetch. With no `server`
> block, Capacitor's defaults put the app at origin `https://localhost`
> (Android) and `capacitor://localhost` (iOS) — both cross-origin to
> `data.fireyak.org`, both subject to CORS. `overPassApi.ts:320` only escapes
> this because it calls `CapacitorHttp.post` *directly*; `flatgeobuf`'s
> `deserialize()` drives global `fetch` internally and cannot be routed through
> that plugin. **Consequence: the R2 CORS policy must cover the native origins
> too** (Part 1a).

```
Laptop (one-time bootstrap)          NAS DS423+ (recurring, every 2 days)
  planet download + first run   ──►    diff-update planet → filter → convert → upload
                                                     │
                                                     ▼
                                       Cloudflare R2 bucket (fireyak-data)
                                       water_sources.{fgb,pmtiles} + metadata.json
                                       custom domain data.fireyak.org, CORS + CDN
                                                     │  HTTP range requests, free egress
                                                     ▼
                                       FireYak app (MapLibre GL, offline:// protocol)
                                       Overpass = optional background refresh only
```

---

## Part 1 — Storage & code setup (once, ~30 min)

### 1a. Cloudflare R2 bucket (the data delivery target)

1. Cloudflare dashboard → R2 → **Create bucket** `fireyak-data`.
   Free tier: 10 GB storage, free egress — your ~1.2 GB of outputs fit easily.
2. **CORS policy** on the bucket (Settings → CORS policy) — **already configured
   and verified 2026-07-21**:

   ```json
   [
     {
       "AllowedOrigins": [
         "https://app.fireyak.org",
         "http://localhost:5173",
         "https://localhost",
         "capacitor://localhost"
       ],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range", "If-Match", "If-None-Match"],
       "ExposeHeaders": ["Content-Range", "Content-Length", "ETag", "Accept-Ranges"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

   `https://localhost` is Android's origin, `capacitor://localhost` is iOS's
   (Capacitor defaults, since `capacitor.config.ts` has no `server` block).
   **R2 accepts the non-HTTP `capacitor://` scheme** and echoes it back in
   `Access-Control-Allow-Origin` — measured against the dev bucket for all three
   production origins, so the explicit allow-list is viable and no wildcard is
   needed. Re-run the §2.3 check after any policy edit.
3. **Custom domain** for production: R2 bucket → Settings → Public access →
   Custom Domains → Connect `data.fireyak.org`. Needs the domain's zone in the
   same Cloudflare account; status goes Active in a few minutes. The `r2.dev`
   URL *does* honour the bucket CORS policy (measured), so it is fine for
   development — but it is rate-limited by Cloudflare and explicitly not for
   production traffic, and it gives no CDN cache control. Ship against the custom
   domain.
4. **API token** for uploads: R2 → Manage API Tokens → Create, **Object Read &
   Write** scoped to this bucket. Note the Access Key ID, Secret, and the S3
   endpoint `https://<accountid>.r2.cloudflarestorage.com`.

**Data URLs** (overwriting objects keeps URLs constant):

```
# production — live and CORS-verified 2026-07-21
https://data.fireyak.org/fireyak-data/water_sources.fgb        # 617 MB
https://data.fireyak.org/fireyak-data/water_sources.pmtiles    # 571 MB
https://data.fireyak.org/fireyak-data/metadata.json

# same objects via the dev URL (rate-limited, CORS also works)
https://pub-2d208d725d5849bba36ed4ed8cfb4e8e.r2.dev/fireyak-data/…
```

Note the `fireyak-data/` **key prefix** — the upload placed the objects in a
folder inside the bucket, so it is part of the URL. `BASE` therefore includes it.

Gate result (§2.3), all three origins: `206` + `content-range` +
`access-control-allow-origin` echoing the origin, including
`capacitor://localhost`. Phase 0 is **done**.

`BASE` in §4.3 comes from an env var (`VITE_DATA_BASE_URL`) defaulting to the
production URL, so dev builds can point elsewhere without a code change — and so
the origin list above stays the complete set.

`water_sources.pmtiles` is still produced and uploaded by the pipeline, but the
app does **not** consume it — see §4.8. It costs nothing to keep publishing and
leaves the door open.

### 1b. Code repo (optional, for reproducibility)

Create a repo `steinerjakob/fireyak-data-pipeline` (or a folder in the app repo)
holding `Dockerfile`, `build.sh`, `export-config.json`, `README.md` so the
pipeline is reproducible and the NAS can build the image from it. No release
assets, no PAT with contents-write needed anymore — uploads go to R2, not GitHub.

---

## Part 2 — Bootstrap on the Ubuntu laptop (i7 / 32 GB / NVMe)

The laptop turns the slow first iteration loop (planet download + full filter) from
"overnight on the NAS" into "over lunch". Expected timings: filter ~20–40 min,
export + conversions ~10 min. Total per iteration well under an hour after the
one-time planet download.

### 2.1 Run the pipeline

```bash
sudo apt install docker.io          # if not present
git clone https://github.com/steinerjakob/fireyak-data-pipeline
cd fireyak-data-pipeline
docker build -t fireyak-pipeline .

mkdir -p ~/osm-data                  # on the NVMe, needs ~250 GB free
docker run --rm \
  -v ~/osm-data:/data \
  -e SKIP_UPLOAD=1 \
  fireyak-pipeline
```

First run downloads `planet.osm.pbf` (~80 GB) into `~/osm-data`, then filters,
exports, and writes `out/water_sources.{fgb,pmtiles}` + `metadata.json`.

(With 32 GB RAM you could also run osmium/tippecanoe natively via apt for even
faster iteration, but using the same Docker image as the NAS validates exactly
what will run in production — prefer that.)

### 2.2 Validate before shipping

```bash
# Schema + feature count (expect ~2–3 M features worldwide)
ogrinfo -so -al ~/osm-data/out/water_sources.fgb

# Fire ponds must come through as polygons, hydrants as points:
ogrinfo -al ~/osm-data/out/water_sources.fgb \
  -where "\"emergency\" = 'fire_water_pond'" | head -50

# Spot-check hydrants you know (your area) against openstreetmap.org
```

Tune here if needed (tippecanoe zoom levels `-Z4 -z14`, export config), re-run —
each iteration costs <1 h instead of a NAS night.

**Confirm the FlatGeobuf has its spatial index** — this is what makes bbox range
reads pull tight, contiguous byte ranges instead of scattered ones (big deal for
the ~620 MB file). `build.sh` builds it with `-lco SPATIAL_INDEX=YES`; verify:

```bash
ogrinfo -so ~/osm-data/out/water_sources.fgb water_sources | grep -i index
```

If a file was built without it, rebuild just the FGB from the existing
GeoJSONSeq (seconds–minutes) with `SPATIAL_INDEX=YES` before uploading.

> ⚠️ **The export MUST carry the OSM element type — the first upload did not.**
> Measured on the 2026-07-21 file: `@id` is a bare `Integer64` (e.g.
> `6915617458`) with no type, and the `osm_type` column is empty on every
> feature (it exists in the schema only because some OSM object somewhere
> carries a literal `osm_type` *tag*). Without the type, `node/123` and
> `way/123` cannot be told apart, which is exactly what the app's namespaced
> keys (§4.5) need.
>
> Fix in `build.sh`: add **`--add-unique-id=type_id`** to the `osmium export`
> invocation, so `@id` becomes the string `"n123"` / `"w456"` / `"r789"`.
> Confirm the exact flag against `osmium export --help` on the build machine.
> Then re-run and re-upload. Note this also introduces **relations** (`r`) —
> `amenity=fire_station` multipolygons — which is why `OsmRef` supports them.
>
> Until that file lands, `staticDataApi.ts` falls back to inferring the type
> from geometry (`Point` → node, else way) and warns once per session. That
> fallback is transitional and should be deleted once the typed export is live.

**Record the geometry mix per `emergency` value while you're here** — §4.4 needs
to know which types arrive as ways/polygons rather than points, because that
drives a required change in the app's icon/category logic:

```bash
ogrinfo -al -so ~/osm-data/out/water_sources.fgb   # geometry column type
ogrinfo -al ~/osm-data/out/water_sources.fgb \
  -where "\"emergency\" = 'water_tank'" | head -30
```

### 2.3 First upload to R2 (optional, from the laptop)

Once satisfied you can seed R2 from the laptop so app integration can start
before the NAS is configured. Uses `rclone` (or any S3 client) with the R2 token:

```bash
sudo apt install rclone
rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<R2_ACCESS_KEY> secret_access_key=<R2_SECRET> \
  endpoint=https://<accountid>.r2.cloudflarestorage.com

rclone copy ~/osm-data/out/ r2:fireyak-data/ \
  --include "water_sources.fgb" \
  --include "water_sources.pmtiles" \
  --include "metadata.json" -P
```

**Verify CORS + range from every origin the app will use.** This is the single
riskiest assumption in the whole plan — prove it before writing app code:

```bash
for O in https://app.fireyak.org http://localhost:5173 https://localhost capacitor://localhost; do
  echo "--- $O"
  curl -sI -H "Origin: $O" -H "Range: bytes=0-99" \
    https://data.fireyak.org/water_sources.fgb \
    | grep -iE "^HTTP|access-control-allow-origin|content-range|accept-ranges"
done
```

Each must show `206`, an `access-control-allow-origin` (echoing the origin or
`*`), and a `content-range` — that is the check GitHub Releases fails. The two
`localhost` origins are the ones people forget; they are what mobile actually
sends.

### 2.4 Hand over to the NAS

```bash
# copy planet + outputs to the NAS (gigabit LAN: ~15 min)
rsync -ah --progress ~/osm-data/planet.osm.pbf ~/osm-data/out \
  admin@<nas-ip>:/volume1/osm-data/
```

`pyosmium-up-to-date` reads the replication timestamp from the planet file's
header, so the NAS continues applying daily diffs exactly where the laptop's
download left off — no re-download, no extra state to transfer.

---

## Part 3 — Recurring builds on the NAS (once configured, fully hands-off)

### 3.1 Folder + secrets

```
/volume1/osm-data/
├── planet.osm.pbf   # copied from laptop, updated in place via diffs
├── work/            # scratch, overwritten each run
├── out/             # final artifacts
├── env              # R2 credentials (see below)
└── pipeline.log
```

`/volume1/osm-data/env` (chmod 600):

```
R2_ACCESS_KEY=xxxxxxxx
R2_SECRET=xxxxxxxx
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_BUCKET=fireyak-data
```

Keep ~250 GB free on the volume (planet + temp copy during diff apply + scratch).

### 3.2 Image via Portainer

Portainer → Images → Build → method "Repository" → URL of `fireyak-data-pipeline` →
name `fireyak-pipeline`. Pipeline changes later = one-click rebuild from the repo.
Portainer is also your log viewer and manual-trigger UI (duplicate + start the
container for an ad-hoc rebuild).

### 3.3 Schedule (DSM Task Scheduler — Portainer has no cron)

Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script,
user `root`, every 2 days at 00:30:

```bash
docker run --rm \
  --cpus="2.5" \
  --cpu-shares=256 \
  -v /volume1/osm-data:/data \
  --env-file /volume1/osm-data/env \
  fireyak-pipeline >> /volume1/osm-data/pipeline.log 2>&1
```

Task Settings → email **only on abnormal termination**.

Per-run on the J4125: diff-apply ~1–2 h (rewrites the 80 GB file in place —
normal) → filter 2–4 h → convert ~30 min → upload minutes. Total 4–6 h overnight
(longer with the CPU cap below); lock file prevents overlaps; a failed run just
leaves the previous R2 objects in place.

### 3.4 Keep the NAS usable during a run

The DS423+ has 4 cores; two flags keep it responsive while the pipeline runs:

- **`--cpus="2.5"`** — hard cap: the container never uses more than 2.5 cores'
  worth, so ~1.5 cores stay free for DSM, file access, and other containers.
  Applies to every tool inside, including tippecanoe's threads.
- **`--cpu-shares=256`** — soft priority (default 1024): under contention the
  container automatically backs off and yields to interactive tasks, but still
  uses spare capacity when the NAS is idle. This is the "polite" knob.

Use both: the cap guarantees headroom, the shares make it yield gracefully.
Tune to taste — `--cpus="3"` alone is fine if you mainly care about the
occasional overnight access; `--cpus="2"` is the gentlest but roughly doubles
wall-clock (still overnight). Since the job runs at 00:30, contention is usually
minimal regardless.

For disk I/O (the filter step is I/O-heavy on HDDs), optionally also lower the
container's I/O priority by prefixing the command:

```bash
ionice -c2 -n7 nice -n 19 docker run --rm --cpus="2.5" --cpu-shares=256 \
  -v /volume1/osm-data:/data --env-file /volume1/osm-data/env \
  fireyak-pipeline >> /volume1/osm-data/pipeline.log 2>&1
```

(`nice`/`ionice` on the client reprioritizes reliably only if Docker doesn't
reset priority in a fresh cgroup; the `--cpus`/`--cpu-shares` flags are the
dependable levers, so treat `nice`/`ionice` as a bonus.)

Optionally cap tippecanoe threads in `build.sh` too (`tippecanoe … -t <N>`),
though the `--cpus` cap already bounds them.

---

## Part 4 — App integration (Vue 3 / MapLibre GL / Pinia / offline://)

*Validated against the source 2026-07-21. Corrections that validation forced are
marked **[V]**.*

```bash
npm install flatgeobuf     # `pmtiles` deliberately NOT installed — see §4.8
```

### 4.1 Who serves what

| Use case | Source | Integration point |
|---|---|---|
| Marker data for viewport | **FlatGeobuf** bbox range-read | `markerHandler.updateNodeCache()` **[V]** |
| Offline area downloads | **FlatGeobuf** bbox read | `src/offline/areaDataDownloader.ts` |
| Single marker by id (deep link, edit-conflict check) | **Overpass** — unchanged | `fetchNodeById` stays as-is **[V]** |
| Live freshness | Overpass (existing code) | background-only, never blocking |
| User's own edits | local injection | existing pending-edits queue — already solved |
| ~~Low-zoom overview layer~~ | ~~PMTiles~~ | **descoped — see §4.8** **[V]** |

### 4.2 Transport: one URL, two origins **[V]**

R2's CORS policy (Part 1a) is what makes the reads work — for the **web** build
*and* the **native** builds. The frequently-repeated "Capacitor bypasses CORS"
shortcut does not apply here: `CapacitorHttp` is disabled in
`capacitor.config.ts:17-19`, so the WebView uses ordinary `fetch` from
`https://localhost` (Android) / `capacitor://localhost` (iOS), and `flatgeobuf`
drives that global `fetch` internally with no way to divert it through the
Capacitor HTTP plugin.

Practical upshot — one code path, one URL, and two obligations:

- The R2 CORS policy must cover the native origins (Part 1a).
- The Part 2.3 four-origin `curl` check is a **gate**, not a nicety. Re-run it
  after any CORS-policy edit.

No native transport shim is needed, and none should be written.

### 4.3 Primary read path: FlatGeobuf at the `updateNodeCache` seam **[V]**

`overPassApi.ts` is *not* the choke point for the viewport path — its
`fetchMarkerData` has exactly one caller. The real seam is
`src/mapHandler/markerHandler.ts:168 updateNodeCache()`, which owns the padding
(`padBounds`, 0.25), the clamp (`clampBounds`), the tile-freshness stamps, the
`storeMapNodes` write, `reconcileDeletedNodes`, and the `markerCacheVersion` bump.
Swap only the fetch line inside it; everything else in that function stays.

Note the data-flow consequence: `getMarkersForView` **re-reads IndexedDB**, it
does not render the fetch's return value. So the adapter's contract is "produce
`OverPassElement[]` and let `storeMapNodes` persist it" — not "produce GeoJSON".

> ⚠️ **Move the freshness check out of the cache-hit branch.** `getMarkersForView`
> only consulted `areTilesFresh` when the cache already had markers; an empty
> cache fetched unconditionally. An area with genuinely **no** water sources
> caches nothing, so that condition never stops being true — and because
> `updateNodeCache` bumps `markerCacheVersion`, which `MainMap.vue:546` watches
> by calling `getMarkersForView` again, it is an **infinite fetch loop**, not
> merely redundant polling. Observed in practice.
>
> The freshness registry is the only record that we already asked about an area
> and the answer was "none here", so it must gate both branches. Compute
> `areTilesFresh` once, before the empty/populated split, and use it in each.

```ts
// src/mapHandler/staticDataApi.ts
import { deserialize } from 'flatgeobuf/lib/mjs/geojson';
import type { OverPassElement } from '@/mapHandler/overPassApi';
import type { GeoBounds } from '@/types/geo';

const BASE = import.meta.env.VITE_DATA_BASE_URL ?? 'https://data.fireyak.org';
export const FGB_URL = `${BASE}/water_sources.fgb`;
export const META_URL = `${BASE}/metadata.json`;

export async function fetchWaterSources(bounds: GeoBounds): Promise<OverPassElement[]> {
  const out: OverPassElement[] = [];
  for await (const f of deserialize(FGB_URL, {
    minX: bounds.west, minY: bounds.south, maxX: bounds.east, maxY: bounds.north
  })) {
    const el = toOverPassElement(f as GeoJSON.Feature);
    if (el) out.push(el);
  }
  return out;
}
```

`clampBounds` exists to keep Overpass inside its server timeout. A range read has
no such limit, so on the FGB path it can be relaxed — but the padded/clamped
bounds are also what `markTilesFresh` and `reconcileDeletedNodes` are keyed on, so
whatever bounds are actually read must be the ones stamped and reconciled. Keep
them identical, exactly as the current code comment at `markerHandler.ts:170-173`
warns.

### 4.4 The adapter — mandatory, and it fixes a latent bug **[V]**

FGB features carry OSM tags plus `@id` (`node/123` / `way/456`). The app keys
everything on a **bare numeric** `id`: IndexedDB `keyPath: 'id'`
(`databaseHandler.ts:78`), `getMapNodeById(id: number)`, `pendingEdits.osmId`, the
`/markers/:markerId` route param. So `toOverPassElement()` must:

1. **Split `@id`** into `{ id: number, type: 'node' | 'way' }` and derive the
   namespaced key from it — see §4.5. Nodes and ways share one numeric keyspace
   today, a collision risk the FGB makes materially worse by introducing
   way-typed *water sources* where only fire stations are ways now. **Decision:
   namespace the key and migrate the DB.**
2. **Centroid polygons.** §2.2 explicitly validates that fire ponds arrive as
   polygons, but the app stores and renders points only. `storeMapNodes`
   (`databaseHandler.ts:136-155`) normalises `center` → `lat`/`lon` via
   `getNodePoint`, so emitting `center: { lat, lon }` is enough.
3. **Decide category and icon from tags, not from `type`.** ⚠️ Today
   `markerHandler.ts:64` returns the `firestation` icon and `:89` returns the
   `fireStation` filter key for **every** `type === 'way'`. That is safe only
   because `overPassApi.ts:213` queries ponds/tanks as `node[…]` exclusively.
   The moment the FGB delivers pond and tank *ways*, they render as fire stations
   and hide under the fire-station filter. Rework `getIconKeyForNode` and
   `categoryForNode` to branch on `tags.emergency` first, falling back to
   `tags.amenity === 'fire_station'`.

Everything downstream of `storeMapNodes` — the IndexedDB cache, nearby ranking,
edit deep-links — then stays untouched.

Bundle cost: `flatgeobuf` pulls in `flatbuffers`; budget it before merging (no
other new dependency, `pmtiles` is descoped).

### 4.5 Namespaced marker keys + DB v4 migration **[V]**

Today every marker is keyed by a bare numeric `id` (`databaseHandler.ts:78`
`keyPath: 'id'`). `node/123` and `way/123` are distinct OSM objects that would
overwrite each other. Ships as its own commit, **before** the FGB switch, so the
key change and the data-source change can be reverted independently.

**Key format: `n<id>` / `w<id>`** (`n123`, `w456`, `n-1` for offline temp
creates). A single opaque string — usable as an IndexedDB key, a `Map` key, a
MapLibre feature property, and crucially a *single* URL path segment. `node/123`
is rejected because the slash breaks `/markers/:markerId`; a compound
`['type', id]` keyPath is rejected because it cannot appear in a URL and is
awkward as a `Map` key.

New `src/helper/osmRef.ts`:

```text
type OsmRef  = string;              // "n123" | "w456"
type OsmType = 'node' | 'way';

toRef(type: OsmType, id: number): OsmRef
parseRef(ref: OsmRef): { type: OsmType; id: number } | null
coerceRef(param: string): OsmRef | null   // bare number → legacy node ref
```

`coerceRef` is what keeps **already-shared links working**: `MarkerInfoHeader.vue:79`
hands out `https://app.fireyak.org/#/markers/${id}` today, those URLs are in
people's chat histories, and `/^-?\d+$/` must keep resolving as a node ref
forever. New links emit `…/markers/n123`. Universal links need no change —
`public/.well-known/apple-app-site-association` uses `paths: ["*"]`.

**Migration (`FireMarker` v3 → v4).** IndexedDB cannot change a store's keyPath
in place, so the v4 `upgrade` block creates a new store, copies, and drops the
old one:

- Create `fireMarkerRefs` with `keyPath: 'ref'` (no `autoIncrement`), and
  recreate both existing indexes: `'lat, lon'` → `['lat', 'lon']` and
  `'fetchedAt'`.
- Cursor the old `fireMarker` store and write
  `{ ...row, ref: toRef(row.type ?? 'node', row.id) }` — preserving `__deleted`
  tombstones and `fetchedAt` (the freshness index and the startup prune both
  depend on it). Keep `id` and `type` on the record; they are the OSM wire
  identity that `osm-api` and `fetchNodeById` still need.
- `db.deleteObjectStore('fireMarker')`, then point `markerStoreName` at
  `fireMarkerRefs`.

**Do not migrate by wiping the cache.** It looks disposable and is not: the
water-source data for downloaded offline areas lives in this same store while
`offlineAreas` still reports `status: 'ready'`. A wipe leaves areas claiming
ready with no data — which the user discovers only once they are offline, i.e.
exactly when it matters. The copy is a one-time cursor pass over a cache bounded
by what the user has panned across.

**Mechanical signature changes** (all compile-time-checked, so the compiler
enumerates the work):

| Location | Change |
|---|---|
| `databaseHandler.ts` | `CachedMapNode` gains `ref: OsmRef`; `getMapNodeById(ref)`, `deleteMapNode(ref)`, `hardDeleteMapNodes(refs)`, `getMapNodeIdsForBounds` → `getMapNodeRefsForBounds(): OsmRef[]` |
| `markerHandler.ts:158` | `reconcileDeletedNodes` compares `toRef(e.type, e.id)` |
| `markerHandler.ts:274-289` | GeoJSON `properties.id` → `properties.ref` |
| `MainMap.vue:1445-1447` | push the ref; `:1641` `Number(markerId)` → `coerceRef(markerId)` |
| `mapMarkerStore.ts` | `fetchMarkerById(ref)`, `selectMarker(ref \| null)`, `fetchPromises: Map<OsmRef, …>` |
| `NearbyMarker.vue:75` | `router.push(\`/nearbysources/${toRef(...)}\`)` |
| `pumpCalculation.ts:525` | `useMarkerAsWaterSource(ref, coords)` |
| `editQueue.ts` | `PendingEdit` keeps numeric `osmId` + `elementType` (OSM wire identity, negative temp ids) — derive refs at the call sites: `hardDeleteMapNodes([toRef(edit.elementType, edit.osmId)])`. **No `pendingEdits` migration needed.** |
| `overPassApi.ts` | `fetchNodeById(nodeId: number)` unchanged — it queries `node(id);way(id);`; the caller attaches the ref from the returned `type` |

**One behavioural fix falls out of this.** `markerImageHandler.ts:42` builds the
Commons category `Fire-fighting-facility node-${markerId}` — a node-only
convention. Once ways are real markers, gate the image lookup on
`parseRef(ref)?.type === 'node'` and skip it for ways, rather than querying a
category that cannot exist.

### 4.6 Offline areas: replace the Overpass chunking

`areaDataDownloader.ts` currently chunks Overpass calls to stay under API limits.
With the FGB, one bbox read returns the whole area's features — no chunking, no
rate limits, dramatically faster offline-area downloads. Feed the results into the
same IndexedDB structures. This also removes the last place where a user action
directly triggers bulk Overpass load.

**[V]** It is not a drop-in swap of the fetch call — `downloadAreaData` also owns
three things the chunk loop provides:

- **Resume** via `lastCompletedChunk`, persisted per chunk.
- **Progress**: `offlineAreasStore.ts:165` computes
  `combinedTotal = countChunks(bounds) + totalTilesFor(area)`. A single FGB read
  collapses the data half of the bar to one unit — rework the progress model
  rather than leaving a bar that jumps.
- **Deletion reconciliation**, today guarded by
  `elements.length < OVERPASS_TRUNCATION_LIMIT` (`areaDataDownloader.ts:124`).

**Implemented as:** `lastCompletedChunk` is repurposed as a 0/-1 "data phase
done" flag (no DB migration — the field stays a `number`); the progress total
becomes `DATA_PHASE_UNITS (1) + totalTilesFor(area)`, so tiles remain the bulk
and the bar stays monotonic. `chunkBounds`/`countChunks` are deleted.

Two UI call sites also assumed per-chunk semantics and had to move with it, or
they'd have shown a stuck counter for the whole tile phase:
`offlineAreaActions.ts` `downloadDetail` (dropped the `{done}/{total}` counter —
the locale keys `offlineAreas.status.loading/refreshingSources` lost those
params) and `OfflineAreasView.vue` `estimateLine` (dropped `{chunks}` from
`offlineAreas.add.estimate`).

**Measured worst case** — a full 1° area (`MAX_AREA_SPAN_DEGREES`) over the
dense Ruhr region: **42,956 features in 2.3 s over 21 range requests / 11.5 MB**,
~21 MB heap. The old path needed 16 chunked Overpass calls with a 1 s sleep
between each. No chunking is needed for size or memory reasons.

The last one is a genuine **win worth stating**: an FGB read is never truncated,
so refresh-time `reconcileDeletedNodes` becomes exact over the whole area instead
of being skipped whenever a chunk hit 2000 elements.

> ⚠️ **Correction to the above — reconciliation needs a staleness guard, not
> just the dropped truncation guard.** This plan previously said the FGB path
> could "reconcile unconditionally". That is wrong and would delete live data.
> The extract is rebuilt every ~2 days (the file live on 2026-07-21 had a planet
> timestamp of 2026-07-12 — a 9-day window), so it knows nothing about anything
> mapped since it was cut. Reconciling against it would hard-delete every marker
> newer than the extract from the local cache — **including the marker the user
> just added through the app**, on their very next pan.
>
> Rule implemented instead: delete a cached node the extract doesn't mention
> **only if `fetchedAt < planet_timestamp`** — i.e. only if our knowledge of it
> predates the extract. Anything we learned after the cut is kept, since the
> extract cannot be authoritative about it. This protects user edits, offline
> temp creates, and `fetchNodeById` results, while still removing genuinely
> deleted objects once a later rebuild advances past when we cached them.
> `reconcileDeletedNodes` takes an optional `sourceTimestampMs`; omit it for a
> live source like Overpass, where absence really does mean deletion. If the
> timestamp can't be determined, skip reconciliation entirely — the TTL prune is
> the safe backstop.

### 4.7 What stays on Overpass

**Single-node reads stay on Overpass by design, and that is fine.** FGB is a
spatial index and cannot answer "give me node 123", but `fetchNodeById`
(`mapMarkerStore.ts:31`, `editQueue.ts:265/309/334/348`) only ever *populates or
refreshes the cache* — deep links and edit-conflict checks read from the cache
that the bbox range reads have already filled. No FGB replacement, no change.

**Background freshness (optional, phase 2).** Render static data immediately; fire
the existing Overpass query in the background with a ~5 s timeout; on 429/500
swallow silently. Objects missing from the Overpass response but present
statically are **kept** (gaps ≠ deletions).

**[V]** Merge at the `OverPassElement` layer before `storeMapNodes`, not on GeoJSON
features — see §4.3. And **drop the `@version` comparison**: nothing in the app
stores `@version` (`CachedMapNode` has no such field) and Overpass as queried
(`out qt center 2000 tags`) omits meta entirely, so
`Number(undefined ?? 0) >= Number(undefined ?? 0)` is always true and live always
wins. That is the behaviour we want — express it directly rather than leaving code
that only looks like it compares versions. A real version compare would need
`out meta`, which is heavier for no benefit.

```ts
/** Live response wins for ids it contains; static-only ids are preserved. */
export function mergeLive(staticEls: OverPassElement[], liveEls: OverPassElement[]) {
  const byId = new Map(staticEls.map((e) => [e.id, e]));
  for (const e of liveEls) byId.set(e.id, e);
  return [...byId.values()];
}
```

**[V]** With the static path in place the blocking-fetch failure mode effectively
disappears, so decide what happens to `markerFetchFailed` and the toast wired at
`MainMap.vue:836` — either retire it or repoint it at "data host unreachable and
cache empty". Leaving it wired to a path that can no longer fail is dead UI.

### 4.8 PMTiles overlay — descoped **[V]**

The pipeline keeps producing `water_sources.pmtiles`, but the app does not read
it. The original design assumed it could be routed through the existing
`offline://` protocol and thereby inherit cache-first/offline behaviour for free.
It cannot:

- `offlineProtocol.ts:27-28` accepts exactly two URL shapes —
  `offline://{source}/{z}/{x}/{y}` and `offline://assets/{path}`; anything else
  throws `Bad offline URL`.
- The handler returns `{ data: ArrayBuffer }`, never reads `params.headers`, and
  has no way to express a `206`/partial body.
- `tileStore.get()` returns a whole `Blob` with no byte-offset API; on native it
  base64-decodes the entire file through Capacitor Filesystem.

PMTiles would need the `pmtiles` package's own protocol doing ranged `fetch`,
which **bypasses `offline://` entirely** — losing the cache-first behaviour that
was the whole justification, and bypassing `tileStore`'s ref-counting and
`sizeBytes` accounting so offline-area size/delete would not see those bytes.

If low-zoom density display is ever wanted, the shape that fits this codebase is
to pre-explode the archive into the existing tile store as `z/x/y` blobs under a
new source name — a separate plan, not a phase of this one.

### 4.9 UX & housekeeping

- Fetch `metadata.json` at startup → "Data as of {planet_timestamp}". Slot:
  the Data Source card at `src/views/AboutView.vue:91-109`, after the existing
  attribution paragraph. **Implemented** as `src/composable/dataFreshness.ts`
  (Preferences-cached, network-refreshed) + key `about.dataAsOf`
  (`Data as of {date}` / `Datenstand: {date}`).
  **[V]** No Workbox rule matches `data.fireyak.org` (`vite.config.ts:95-167`
  covers only protomaps / ArcGIS / mapterhorn / wikimedia), so this refetches on
  every launch and fails offline — persist the timestamp via Capacitor
  Preferences and render the cached value. Do **not** add a Workbox rule for the
  `.fgb` itself; range reads must not be intercepted.
- User edits appear instantly via the existing pending-edits flow; they reach the
  static file after the next pipeline run (≤2 days) — no UI change needed.
- `whats-new.json` entry (both languages, user-perspective, no jargon), e.g.:
  `{ "type": "improvement", "en": "Water sources now load reliably, even at peak times.",
     "de": "Wasserentnahmestellen laden jetzt zuverlässig – auch zu Stoßzeiten." }`
- Keep OSM/ODbL attribution (already present).

### 4.10 Rollout order

- **Phase 0 — R2 live and CORS proven** (Part 1a + the four-origin check in
  §2.3). CORS policy is already in place; what remains is uploading real objects
  and re-running the check against them, since an empty bucket only proves the
  policy, not the range reads. Blocks everything else.
- **Phase 1 — namespaced keys + DB v4** (§4.5), on **today's** Overpass data.
  Ships and is verified on its own; no user-visible change. Keeping it separate
  means a regression in the key migration can be reverted without also reverting
  the data source, and vice versa.
- **Phase 2** — `staticDataApi.ts` + adapter (§4.4, including the way/tags icon
  fix), swapped in at `updateNodeCache`; switch `areaDataDownloader` to FGB with
  the reworked progress model. Removes 429/500 from the viewport and offline-area
  paths. Residual Overpass exposure: single-node reads (§4.7) — acceptable, they
  are cache-fill only.
- **Phase 3** — Overpass background refresh + merge, plus the
  `markerFetchFailed` decision.
- ~~**Phase 4** — PMTiles~~ → descoped, see §4.8.

### 4.11 Interaction with the sibling plan **[V]**

`plans/offline-first-water-sources.md` targets the same 429/504 problem by making
downloaded regions the primary source and gating live fetches inside them. It
rewrites `getMarkersForView` and touches the same downloader, so the two **will**
conflict. Sequence them deliberately — if this plan lands first, that plan's
gating rationale largely evaporates and it reduces to the coverage-overlay and
onboarding pieces.

### 4.12 Verification

No test suite exists (AGENTS.md §7), so verification is UI-level via the repo
`verify` skill plus `npm run lint` && `npm run build`:

1. **CORS/range from all four origins** — the §2.3 `curl` gate against a real
   uploaded object, then the same read from a web build console and a native
   build. Riskiest assumption in the plan; prove it first.

**Phase 1 (key migration) — verify before touching the data source:**

1. **Upgrade path, not fresh install.** Load the app on v3 data (or check out
   `main`, use it until markers and an offline area are cached, then switch
   branches). After upgrade: markers still render, the offline area still reports
   its node count, and `fireMarkerRefs` row count matches the old `fireMarker`
   count. A fresh install proves nothing here — the copy is the risk.
2. **Tombstones survive** — soft-delete a marker on v3, upgrade, confirm it stays
   deleted rather than reappearing on the next fetch.
3. **Legacy deep link** — `/#/markers/123` (bare numeric, the format already
   shared in chats) still opens that marker; a newly shared link is `/#/markers/n123`
   and also opens it. Test both on web and via a universal link on device.
4. **Pending edits across the upgrade** — queue an offline edit on v3, upgrade,
   then sync: it must still resolve to the right marker (`osmId` stays numeric;
   only the cache lookup is re-keyed).

**Phase 2 (FGB) onward:**

1. **Parity** — pan over a known dense area; compare marker count and positions
   against the Overpass build.
2. **Way-typed sources** — confirm a fire-pond *way* renders with the `water`
   icon and is toggled by the fire-pond filter, not the fire-station one, and
   that a node and a way sharing the same numeric id both survive in the cache
   (the whole point of §4.5).
3. **Offline area** — download a small area, verify node count matches the
   Overpass-era count, progress bar advances monotonically, and resume works
   after a mid-download kill.
4. **Deep link** — open a marker not yet cached; confirm the Overpass fallback
   still fills the cache (§4.7).
5. **Marker images** — confirm a way-typed marker skips the Commons lookup
   instead of querying a `node-…` category (§4.5).
6. **Offline** — airplane mode inside a downloaded area: markers render, "Data as
   of" shows the cached timestamp, no error toast.

---

## Operational summary

| Aspect | Value |
|---|---|
| Cost | €0 (laptop + NAS owned, R2 free tier: 10 GB storage, free egress) |
| Bootstrap | laptop: planet download + <1 h per pipeline iteration |
| Recurring | NAS: 4–6 h every 2 days (more with CPU cap), overnight, hands-off |
| NAS load | `--cpus="2.5" --cpu-shares=256` keeps ~1.5 cores free, stays usable |
| Serving | R2 + custom domain, CORS-enabled (incl. native origins), CDN-cached range requests — no 429 |
| Failure mode | data a few days stale; app fully functional; email alert fires |
| OSM courtesy | one 80 GB download ever, then ~50–100 MB diffs per run |
| Licence | OSM/ODbL attribution (already in app) |
