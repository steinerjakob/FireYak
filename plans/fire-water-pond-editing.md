# Plan: Add / Edit / Flag Fire Water Ponds (way-aware OSM editing)

## Context

FireYak can add, edit and delete **nodes** of type `fire_hydrant`,
`suction_point` and `water_tank`. Fire water ponds (`emergency=fire_water_pond`)
are different: in OSM they are usually mapped on the **area of the water body**,
which is a closed **way** (`natural=water` + `water=pond`/`reservoir`/`basin`) or
a **multipolygon relation**. Sometimes they are mapped as a plain node.

The goal is to let users:

1. **Edit** an existing fire water pond, whether it is a node, a way or a relation.
2. **Flag** an existing water area that is already in OSM but not tagged as a fire pond
   (add `emergency=fire_water_pond` to it). No geometry editing is needed.
3. **Add** a new fire water pond when there is no water area to use. FireYak creates
   a **node** tagged `emergency=fire_water_pond` + `natural=water` + `water=pond`.
   The wiki allows both tags on nodes, and mappers can turn the node into an area later.
4. **Remove** the fire pond flag from a way or relation **without deleting the water
   body**.

The design rule behind all of this: **FireYak never edits way geometry.** For ways
and relations it only changes tags. That avoids a polygon editor, avoids breaking
shared nodes, and keeps the risk to OSM data low.

---

## Current state (what already works and what is missing)

| Area | State | File |
|---|---|---|
| Namespaced refs (`n…`/`w…`/`r…`) | ✅ already in place | `src/helper/osmRef.ts` |
| Static extract delivers way/relation ponds (with `center`) | ✅ | `src/mapHandler/staticDataApi.ts` |
| Fetch a single element by type | ✅ `fetchElementById(type, id)` | `src/mapHandler/overPassApi.ts` |
| Tombstones so deletes are not brought back by the extract | ✅ | `databaseHandler.ts → deleteMapNode` |
| **Overpass area query only asks for `node[emergency~…fire_water_pond]`** | ❌ way ponds are missing when the live layer is used | `overPassApi.ts` (~line 214) |
| `editAllowed` excludes `fire_water_pond` | ❌ | `MarkerInfoHeader.vue` |
| Save, delete and queue code hard-code `'node'` | ❌ | `markerEditStore.ts`, `offline/editQueue.ts` |
| `PendingEdit.elementType: 'node'` | ❌ type too narrow | `databaseHandler.ts` |
| Edit form has no pond section and no pond type option | ❌ | `MarkerEdit.vue` |
| Drag marker always moves `lat/lon` | ❌ must be off for ways and relations | `MainMap.vue` (~302, 1455, 1483) |

---

## OSM tagging reference (checked against the wiki)

Source: <https://wiki.openstreetmap.org/wiki/Tag:emergency%3Dfire_water_pond>
(status *in use*), plus the `natural=water` and `emergency=suction_point` pages.

| Rule from the wiki | What it means for FireYak |
|---|---|
| `onNode=yes`, `onArea=yes`, `onWay=no`, `onRelation=no` | Nodes and areas are both valid. An "area" is a closed way **or a multipolygon relation** (the wiki convention counts multipolygons under `onArea`; `onRelation=no` only rules out other relation types). Never tag an open way or a non-multipolygon relation. |
| *"requires `natural=water` or similar"* / *"use in conjunction with a tag for the physical object, typically `natural=water` + `water=pond`"* | `emergency=fire_water_pond` is an **add-on tag**, never a feature by itself. **New pond nodes must also get `natural=water` + `water=pond`** (`natural=water` is `onNode=yes`). When flagging an area, the physical tag is already there. When unflagging, the physical tag stays. |
| *"A man made or natural pond … specifically designed or selected (in case of a natural one)"* | Natural ponds may be flagged. The pond only needs to be one the fire service actually uses. |
| *"For the specific point where the fire department can pump water, `emergency=suction_point` is used instead."* | The pump or parking spot is a **separate** `emergency=suction_point` node (`onNode=yes`, `onArea=no`). Pipe connections are `emergency=fire_hydrant` + `fire_hydrant:type=pipe` + `fire_hydrant:pressure=suction`. Couplings therefore belong on that hydrant or suction point, **not on the pond**. |
| The wiki documents **no pond-specific sub-tags** | Keep the form small and use only general keys (see 1.6). |

**Tags FireYak writes:**

- **New pond node:** `emergency=fire_water_pond`, `natural=water`, `water=pond`. The
  user can switch `water` to `reservoir` or `basin`. Optional fields come from the form.
- **Flag an existing area:** add `emergency=fire_water_pond`. Do not change any other tag.
- **Unflag:** remove `emergency=fire_water_pond` and the FireYak-only sub-tags. Keep
  `natural=water`, `water=*`, `name` and everything else.

The candidate search accepts the same "or similar" physical tags: `natural=water`,
`landuse=reservoir`, `landuse=basin`.

---

## UX flows

### A. Edit an existing pond (node, way or relation)
Tap the pond marker, then **Edit**. The form opens with the **pond section**.
- **Node:** same as today. The marker can be dragged, and the type can be changed.
- **Way/relation:** the type selector is locked to *Fire water pond*. The drag marker
  is hidden. A hint explains: *"The shape comes from the water area in OSM. Only the
  details are changed."* The delete button becomes **"Not a fire pond anymore"**
  (unflag).

### B. Add a pond (add button **or** long-press) → type "Fire water pond"
Both entry points are equal:
- **Add button (FAB):** `MainMap.vue → startAdding()` uses the **map centre** as
  `pendingLocation`.
- **Long-press:** uses the pressed point.

Both call `markerEditStore.requestStartAdding(location)` and open the same form. The
pond logic therefore keys only off `pendingLocation` and the selected type, never off
how the form was opened. A "Fire water pond" option in the type select is enough. No
separate button is needed.

1. The add form opens. The user picks *Fire water pond*, or it is **suggested** when
   the Protomaps check (§B2) finds pond-like water under the pin.
2. **If online** and the Protomaps check finds water (or cannot tell), FireYak looks
   up water areas **at or next to** the pin (see §2.1). With the add button, the user
   pans the map so the crosshair sits on the pond. With long-press, the pressed point
   is used. Dragging the pin runs the lookup again.
   - **Candidates found:** show an action sheet or inline card:
     - "Use water area *Löschteich Musterdorf* (≈ 450 m²)": flag the existing area
       (flow A with `emergency=fire_water_pond` prefilled).
     - "Add as point instead": creates a node.
   - **Nothing found:** create a node, as for the other types.
3. **If offline:** node only, with a short hint that existing water areas can only be
   used online. The node goes into the offline queue as usual.

### B2. Detecting water from the Protomaps layer: what is possible

I checked the Protomaps basemap source (`tiles/…/layers/Water.java`, v4 schema) to see
what the `water` source layer contains:

| Available in the tile | Not available |
|---|---|
| Polygon geometry of water areas from z6 (not simplified away at z14/z15) | **OSM ID**: water polygons get no `setId(...)`. Only line features and label points do. |
| `kind`: `water`, `lake` (also for `landuse=reservoir`), `basin`, `swimming_pool`, `ocean`, … | **Name**: names sit on separate label points, not on the polygon |
| `kind_detail`: the OSM `water=*` value, e.g. `pond`, `reservoir`, `basin` | **Exact outline**: polygons are clipped at tile edges, and `postProcess` runs `mergeNearbyPolygons`, so neighbouring ponds can arrive as one shape |
| Works **offline** (tiles come through `offline://`, also in downloaded areas) | Any OSM tags beyond `kind`/`kind_detail` |

**Conclusion:** Protomaps can answer *"is there water under the pin, and what kind?"*
It can draw an approximate outline right away and offline. It **cannot identify the
OSM object to tag**, because there is no ID. Flagging an existing area therefore
still needs the Overpass lookup (§2.1). Use Protomaps as a fast, free **pre-check**
before that lookup:

1. On `pendingLocation` change (add mode), run
   `map.queryRenderedFeatures(map.project(pin), { layers: [<protomaps water fill layer ids>] })`.
   Check the real layer IDs that `@protomaps/basemaps` generates in our flavors,
   typically `water`. Fall back to `querySourceFeatures` with `sourceLayer: 'water'`
   plus a point-in-polygon test when the layer is not rendered (satellite mode).
2. Use the result to:
   - **Suggest the type:** if `kind_detail ∈ {pond, reservoir, basin}` or
     `kind = basin`, show a chip *"Water detected: add as fire water pond?"*. Do not
     switch the type automatically, because the same spot may be a suction point.
   - **Skip Overpass** when there is no water under or near the pin. This saves
     rate-limit budget and goes straight to "add as point".
   - **Show the large-water hint (§D) early** for `kind = lake|ocean|river`. Use the
     tile polygon area as a rough size.
   - **Highlight right away:** draw the tile polygon as a temporary outline until the
     Overpass candidate (`out geom`) replaces it with the exact shape.
   - **Offline:** water detected but no Overpass → offer *"Add as point"* with the
     hint *"Connect to the internet to mark the existing water area instead."*
3. Always run Overpass if Protomaps finds nothing but the user still chooses the pond
   type. The tiles may be older than OSM, and small ponds below the min pixel size can
   be missing.

Possible later step: Overpass could be replaced by a lookup in FireYak's own static
extract, if that extract one day also contains `natural=water` areas with IDs
(see `plans/selfhost-osm-data.md`). Protomaps itself will not provide IDs.

### C. Duplicate guard
Before a pond node is created, check the local cache for an existing
`fire_water_pond` (any type) within about 50 m, or one whose area contains the point.
If there is one, offer "Edit existing pond" instead.

### D. Large water bodies (quality guard)
The wiki allows natural ponds that the fire service has *selected*, so flagging
them is not wrong. For large or flowing water, though, the useful information is the
access point, not the whole water body.
- If a candidate has `water=lake|river|canal|stream`, or its bounding box is larger
  than about 2 ha, still list it, but show a hint: *"For lakes and rivers, mark the
  pumping spot as a suction point instead."* Include a button that switches the form
  to `suction_point` at the pressed location.
- Never offer `waterway=*` lines. They are not areas, and the tag is `onWay=no`.

### E. Pumping spot at a pond
After a pond is saved, show the hint *"Add the pumping spot as a suction point?"*.
It opens the add form with type `suction_point` at the current pin. This follows the
wiki's split between the pond (water supply) and the suction point (where the engine
parks and pumps).

---

## Implementation status

- **Phase 1: done.** Way and relation ponds load and can be edited with tag-only
  changes. Areas are unflagged instead of deleted. New pond nodes get
  `natural=water` + `water=pond`.
- **Phase 2: done.** Protomaps pre-check (`waterDetection.ts`), Overpass water-area
  search (`fetchWaterAreasAt`), the candidate list (`PondAreaCandidates.vue`),
  flagging (`startFlagging`), the duplicate guard for areas that are already ponds,
  and the large-water hint.
- **Phase 3: done.** Outline highlight (`areaOutline.ts`; the search returns
  outlines clipped with `out geom(bbox)`; a selected or edited area fetches its
  outline once), the "Add pumping spot" quick action (info panel + offer after
  saving a pond, flow E), and a duplicate guard for nearby pond nodes from the
  local marker cache (60 m, works offline).
- Left open: "tap water to mark it" outside add mode, and node → area upgrade
  (both optional).

Lessons from the implementation:
- Protomaps writes `kind_detail=lake` for `water=pond|reservoir|lake`, so the
  pre-check decides pond vs. lake by **polygon area** (≈ 2 ha), not by kind.
- Overpass `out … center bb` returns only one of the two. The search asks for
  `bb` and derives the center.
- Existing pond data is often incomplete: nodes with only the flag, and areas
  with only `water=pond`. Area edits are never blocked. Node edits add
  `natural=water` automatically.

## Implementation steps

### Phase 1: Load and edit existing way and relation ponds

**1.1 `overPassApi.ts`: query ways and relations for ponds**

```ts
`node[emergency~"^(fire_hydrant|water_tank|suction_point)$"]${bbox};`,
`nwr[emergency=fire_water_pond]${bbox};`,
`way[amenity=fire_station]${bbox};`
```
`out qt center … tags` already sets `center` for ways and relations. Check that
`areaDataDownloader.ts` uses the same statement list, or uses the static extract,
so offline areas also contain way ponds.

**1.2 `databaseHandler.ts`: widen `PendingEdit`**
```ts
elementType: OsmType; // was 'node'
```
Older rows already contain `'node'`, so no IDB migration is needed. Add an optional
`kind?: 'flag' | 'unflag'` only if the Pending Edits view should show a different
label (see 2.4).

**1.3 `markerEditStore.ts`: make save and delete type-aware**
- Add `const elementType = computed(() => originalMarker.value?.type ?? 'node')` and
  `const isArea = computed(() => elementType.value !== 'node')`.
- `startEditing`: for areas, set `pendingLocation` from `center`. It is only used for
  display and is never uploaded.
- In the save path (`isEditing`):
  ```ts
  const [el] = await OSM.getFeature(elementType.value, originalMarker.value.id);
  if (!isArea.value) { el.lat = lat; el.lon = lon; }
  el.tags = finalTags;           // the full tag set: natural=water etc. are kept
  modify: [el]                   // ways keep their `nodes`, relations keep `members`
  ```
  The changeset comment comes from a helper, e.g. `Update fire_water_pond (way) via FireYak x.y`.
- Local cache: `storeMapNodes([{ id, type: elementType, center, tags }])`. Keep
  `center` and do not set `lat/lon` for areas. Use `toRef(elementType, id)` everywhere
  instead of `toRef('node', …)`.
- `enqueueCurrentEdit` passes `elementType` and `center` through.

**1.4 `editQueue.ts`: type-aware sync**
- `EnqueueInput` gets `elementType: OsmType`. Creates are always `'node'`.
- `uploadUpdate`/`uploadDelete`: `OSM.getFeature(edit.elementType, edit.osmId)`. Do not
  set coordinates for areas.
- Conflict check: replace `fetchNodeById(edit.osmId)` with
  `fetchElementById(edit.elementType, edit.osmId)`. This also applies to
  `applyMineAnyway`, `discardEdit` and `fetchServerTags`.
  `fetchNodeById` is ambiguous for node/way ID collisions.
- Optimistic cache and coalescing: replace every `toRef('node', …)` with `toRef(edit.elementType, …)`.
- **Hard guard:** `action === 'delete' && elementType !== 'node'` throws. Areas are
  never deleted (see 2.3).

**1.5 `MarkerInfoHeader.vue`**
Add `'fire_water_pond'` to `editAllowed`.

**1.6 `MarkerEdit.vue`: pond section**
- Type select: add `<ion-select-option value="fire_water_pond">`. Lock it
  (`:disabled="markerEditStore.isArea"`) for areas.
- New `<ion-item-group v-if="emergencyType === 'fire_water_pond'">`. The wiki
  documents no pond sub-tags, so the form uses only general, widely used keys:
  - `name`
  - `water` (select `pond` / `reservoir` / `basin`). Editable for nodes. For areas,
    show it read-only, because it describes the existing water body.
  - `access` (reuse the existing `accessOptions`)
  - `operator`
  - `intermittent` (yes/no/—). This is the `natural=water` combination key for ponds
    that dry out, and it matters to firefighters.
  - `water_volume` (m³), marked as optional. It is not documented on the pond page,
    so it needs a taginfo check before release. If it is barely used, leave it out.
  - **No** `couplings*`. Those belong on a suction point or pipe hydrant (see the
    tagging reference).
- `onTypeChange` (nodes only, because the type is locked for areas):
  - Switching **to** `fire_water_pond`: set `natural=water` and `water=pond` if they
    are missing.
  - Switching **away**: remove `emergency`-specific pond fields. Also remove
    `natural`/`water`, but **only if FireYak added them in this session**. Track this
    with a flag, so physical tags that were already on the object are never removed.
- Save validation: a pond must have `natural=water`, `landuse=reservoir|basin` or a
  similar physical tag. Otherwise block the save. The wiki says the physical tag is required.
- Add any new keys to `relevantTags`. Make sure tags that are not shown
  (`natural`, `water`, …) are **not removed** from `editableTags`. Today this works
  because `editableTags` starts as a copy of all tags. Keep it that way.
- Show the area hint text when `isArea`.

**1.7 `MainMap.vue`**
Do not create the draggable edit marker, and do not change `pendingLocation` on
map tap or drag, when `markerEditStore.isArea`.

### Phase 2: Flag existing water areas and unflag

**2.1 New Overpass helper `fetchWaterAreasAt(lat, lon)` in `overPassApi.ts`**
```
[out:json][timeout:15];
is_in(LAT,LON)->.a;
( way(pivot.a)[natural=water]; rel(pivot.a)[natural=water][type=multipolygon];
  way(pivot.a)[landuse~"^(reservoir|basin)$"]; )->.inside;
( way(around:30,LAT,LON)[natural=water];
  rel(around:30,LAT,LON)[natural=water][type=multipolygon]; )->.near;
(.inside; .near;);
out tags center bb 10;
```
- Use the existing instance pool, timeouts and the native transport (`fetchSingleElement`'s runner).
- Leave out candidates that already have `emergency=*`. Those are already markers,
  and the duplicate guard handles them.
- Approximate the area from `bounds` with a cos(lat) correction. This is enough for
  the "≈ m²" label and the large-water warning.
- Prefer the **relation** over its member way. `is_in` / `pivot` already returns the
  multipolygon itself, not its untagged outer ways. Only show ways that carry the
  water tags themselves.

**2.2 Store: `startFlagging(candidate)`**
```ts
startEditing({ ...candidate, tags: { ...candidate.tags, emergency: 'fire_water_pond' } });
originalMarker.value = candidate;      // baseTags = the real server tags, without emergency
```
- The comment helper detects "flag" (`emergency` missing in `originalMarker.tags`) and writes
  `Tag water area as fire_water_pond via FireYak x.y`.
- Online: same `modify` path as 1.3. Offline is not possible, because the lookup needs
  the network. Edits are still allowed to fail into the queue on a network error,
  just like updates.

**2.3 Unflag instead of delete for areas**
- `requestDeleteMarker`: if `isArea`, show a different dialog: *"Remove the fire pond
  information? The water area itself stays in OpenStreetMap."*
- Implementation: an `update` with the tags minus `emergency` and `water_volume`.
  The physical tags (`natural=water`, `water=*`, `intermittent`) and `name`, `access`,
  `operator` stay. They describe the water body and are valid without the flag.
- Node ponds: unflagging would leave a bare `natural=water` node. So for nodes, keep
  today's **delete** behaviour, and also offer "Keep as plain water (remove fire pond
  only)" for the case where the pond really exists but the fire service no longer uses it.
- Cache: the element is no longer a marker, so call `deleteMapNode(toRef(type, id))`
  (with a **tombstone**). This keeps the static extract, which can lag several days,
  from showing the pond again. Check that the tombstone expires once the extract no
  longer contains the element, the same as for node deletes.

**2.4 `PendingEditsView.vue`**
Show the element type (icon or text "Area"). Unflag edits are shown as
"Fire pond flag removed". Flag edits are shown as "Water area marked as fire pond".
Derive both from `baseTags` and `tags`.

**2.5 Add flow in `MarkerEdit.vue` / `markerEditStore`**
- The flow works the same from the add button (map centre) and from long-press, because
  both end in `requestStartAdding(location)`. No entry-point-specific code.
- New helper `detectWaterAt(map, lngLat)` in `src/mapHandler/waterDetection.ts`. It
  runs the Protomaps check from §B2 and returns
  `{ kind, kindDetail, polygon, approxAreaM2 } | null`. `MainMap.vue` owns the map
  instance, so it calls the helper when `pendingLocation` changes in add mode and
  writes the result to `markerEditStore.detectedWater`.
- `watch([emergencyType, pendingLocation])`: when the type is `'fire_water_pond'`,
  `isAdding` is true, the app is online, and `detectedWater` is not `null` (or the
  user explicitly picked the pond type), debounce (`helper.ts`), then call
  `fetchWaterAreasAt(pendingLocation)`, then fill `areaCandidates`.
- Show the candidates as a card at the top of the form. Selecting one calls
  `startFlagging`. "As point" keeps the node flow.
- Run the lookup again when the pin is dragged. Keep the debounce, because of Overpass rate limits.

### Phase 3: Polish (optional)

- **Outline highlight:** when a way or relation pond is selected or a candidate is
  focused, load `out geom` and draw it as a temporary GeoJSON `fill` + `line` layer
  in `MainMap.vue`. This lets the user see which polygon is being tagged. This is the
  most important visual aid for flow B.
- **Tap on water to flag:** tapping a water area outside add mode opens a small
  popup, *"Mark as fire water pond"*. It uses the §B2 detection, then the §2.1 lookup.
- **"Add suction point at the shore"** as a quick action on the pond info panel
  (the same as flow E, but available at any time).
- **Node to area upgrade** (pond node sits inside an unflagged water area): offer to
  move the tags to the area and delete the node. Do this later and only with an extra
  confirmation, because it rewrites the history of two objects.

---

## Edge cases & risks

| Risk | Mitigation |
|---|---|
| A way is deleted, which would delete the water body or leave orphaned nodes | Hard guard in the store and the queue: areas only get `modify` |
| Coordinates are written onto a way | `lat/lon` are only set when `elementType === 'node'` |
| Node/way ID collision in the cache or a lookup | Use `toRef(type,id)` and `fetchElementById` everywhere; deprecate `fetchNodeById` |
| A member way of a multipolygon gets tagged | Only relations or ways with their own water tag become candidates |
| A lake or river is flagged by mistake | Large-water hint plus a one-tap switch to a suction point |
| A pond is saved without a physical tag (the wiki says "requires `natural=water` or similar") | Node creation prefills `natural=water` + `water=pond`; save validation blocks ponds without a physical tag |
| Existing physical tags are removed when the type is changed | Only remove `natural`/`water` that FireYak itself added in this edit session |
| The static extract shows an unflagged pond again | Tombstone in `deleteMapNode` |
| Overpass rate limit during the candidate search | Debounce, a single query, `out … 10` limit, reuse the existing cool-down pool |
| Concurrent edit on the area | The existing `baseTags` conflict check, now type-aware |
| `is_in` does not work on an instance (area index missing) | Fall back to the `around:30` part; the query has both parts |

---

## Data pipeline (`steinerjakob/fireyak-data`): no change needed

Checked against `build.sh` and `export-config.json`:
- `osmium tags-filter … nwr/emergency=fire_water_pond` already keeps nodes, ways **and**
  relations, together with their referenced nodes and members.
- `export-config.json` lists `emergency=fire_water_pond` in `area_tags`. Closed ways
  and multipolygons are therefore exported as polygons with `@id`/`@type`, and
  `staticDataApi.ts` already reduces them to a `center`.
- Physical tags such as `natural=water` / `water=pond` survive, because all tags are kept.
- Freshness lag after a flag or unflag is handled on the app side: optimistic cache
  updates plus tombstones (§2.3).

Only the optional idea in §B2 (replacing the Overpass candidate search with a static
lookup) would need a pipeline change: a separate `water_areas.fgb` with
`natural=water` / `landuse=reservoir|basin` areas. This would be millions of polygons
worldwide, so it is not recommended for now.

## Files touched (summary)

| File | Change |
|---|---|
| `src/mapHandler/overPassApi.ts` | `nwr` for ponds; new `fetchWaterAreasAt` |
| `src/mapHandler/databaseHandler.ts` | `PendingEdit.elementType: OsmType` |
| `src/store/markerEditStore.ts` | `elementType`/`isArea`, type-aware save/delete/unflag, `startFlagging`, candidates |
| `src/offline/editQueue.ts` | type-aware upload, conflict check, cache refs, delete guard |
| `src/components/MarkerInfoHeader.vue` | allow editing for `fire_water_pond` |
| `src/components/MarkerEdit.vue` | pond section, locked type for areas, candidate card, area hint |
| `src/components/MarkerEditHeader.vue` | title or delete icon → "unflag" for areas |
| `src/components/MainMap.vue` | no drag marker for areas; run Protomaps water detection on `pendingLocation`; outline layer |
| `src/mapHandler/waterDetection.ts` (new) | Protomaps `water` layer query → `kind`, `kind_detail`, polygon, approximate area |
| `src/views/PendingEditsView.vue` | element type and flag/unflag label |
| `src/locales/en.json`, `de.json` | all new strings |
| `src/assets/whats-new.json` | `unreleased` entry (AGENTS.md §6) |
| `AGENTS.md` | short note: "areas: only tag edits, never geometry/delete" |

**What's New (draft):**
```json
{ "type": "feature",
  "en": "Fire water ponds can now be added, edited, or marked on existing ponds on the map.",
  "de": "Löschteiche lassen sich jetzt hinzufügen, bearbeiten oder an bestehenden Teichen markieren." }
```

---

## Verification (there is no test suite, so test manually or with `/verify`)

Use the OSM **dev API** (`master.apis.dev.openstreetmap.org`) if it can be configured.
Otherwise, review the changesets carefully.

1. A way pond in the view appears as a marker through both the live layer and the static extract.
2. Edit a way pond: the changeset contains only `modify way` with the same `nodes`,
   and only the tags change.
3. Edit a relation pond: `modify relation`, members unchanged.
4. Long-press next to an unflagged pond, pick "Fire water pond": the candidate appears.
   Use it: the way gets `emergency=fire_water_pond`, and `natural=water` stays.
4b. Same check through the **add button**: pan the map so the crosshair is on the pond,
   then press add and pick the pond type. The same candidate appears.
4c. With the pin on the water, the "Water detected" chip appears, also in flight mode.
   With the pin on dry land, Overpass is not called for the candidate search (check
   the network log).
5. Same place, "As point": a node is created with `emergency=fire_water_pond`,
   `natural=water` and `water=pond`.
6. Offline: node creation goes into the queue. A way pond edit goes into the queue
   and syncs correctly after reconnecting (type `way`).
7. Unflag a way pond: the way stays in OSM, the marker disappears, and it does not
   come back after a reload (tombstone).
8. Conflict: change the way's tags in OSM in the meantime, then sync. The edit is
   marked as a conflict.
9. `npm run lint` and `npm run build` pass.
