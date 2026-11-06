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
   a **node** for it. This is valid OSM tagging, and mappers can turn it into an
   area later.
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

## OSM tagging reference (check against the wiki before implementation)

- `emergency=fire_water_pond`: allowed on **node** and **area**.
  <https://wiki.openstreetmap.org/wiki/Tag:emergency%3Dfire_water_pond>
- Useful sub-tags for the form: `name`, `water_volume` (m³), `access`,
  `operator`, `couplings`, `couplings:type`, `seasonal` / `intermittent`,
  `description`, `note`.
- Leave the water body's own tags as they are (`natural=water`, `water=*`, `landuse=*`).
- A suction point on the pond shore can be a separate `emergency=suction_point` node.
  This is a possible follow-up: "add suction point here".

---

## UX flows

### A. Edit an existing pond (node, way or relation)
Tap the pond marker, then **Edit**. The form opens with the **pond section**.
- **Node:** same as today. The marker can be dragged, and the type can be changed.
- **Way/relation:** the type selector is locked to *Fire water pond*. The drag marker
  is hidden. A hint explains: *"The shape comes from the water area in OSM. Only the
  details are changed."* The delete button becomes **"Not a fire pond anymore"**
  (unflag).

### B. Add a pond with long-press → type "Fire water pond"
1. The user long-presses, the add form opens, and the user picks the
   *Fire water pond* type.
2. **If online**, FireYak looks up water areas **at or next to** the pressed point
   (see §3).
   - **Candidates found:** show an action sheet or inline card:
     - "Use water area *Löschteich Musterdorf* (≈ 450 m²)": flag the existing area
       (flow A with `emergency=fire_water_pond` prefilled).
     - "Add as point instead": creates a node.
   - **Nothing found:** create a node, as for the other types.
3. **If offline:** node only, with a short hint that existing water areas can only be
   used online. The node goes into the offline queue as usual.

### C. Duplicate guard
Before a pond node is created, check the local cache for an existing
`fire_water_pond` (any type) within about 50 m, or one whose area contains the point.
If there is one, offer "Edit existing pond" instead.

### D. Large water bodies (quality guard)
If a candidate has `water=lake|river|canal|reservoir`, or its bounding box is larger
than about 2 ha, still list it but show a warning and suggest a
**suction point node** instead. Fire ponds are artificial or dedicated ponds, and
flagging a lake is usually wrong tagging. Never offer `waterway=*` lines.

---

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
- New `<ion-item-group v-if="emergencyType === 'fire_water_pond'">` with: `name`,
  `water_volume` (number, m³), `access`, `operator`, `couplings`/`couplings:type`,
  `seasonal` (yes/no/—).
- `onTypeChange`: also remove pond-specific tags when the type changes away from
  `fire_water_pond`. This only matters for nodes, because the type is locked for areas.
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
- Implementation: an `update` with the tags minus `emergency` and the pond-only sub-tags
  (`water_volume`, `couplings*`, …). `natural=water`, `name` etc. stay.
- Cache: the element is no longer a marker, so call `deleteMapNode(toRef(type, id))`
  (with a **tombstone**). This keeps the static extract, which can lag several days,
  from showing the pond again. Check that the tombstone expires once the extract no
  longer contains the element, the same as for node deletes.

**2.4 `PendingEditsView.vue`**
Show the element type (icon or text "Area"). Unflag edits are shown as
"Fire pond flag removed". Flag edits are shown as "Water area marked as fire pond".
Derive both from `baseTags` and `tags`.

**2.5 Add flow in `MarkerEdit.vue` / `markerEditStore`**
- `watch(emergencyType)`: when it is `'fire_water_pond'` while `isAdding` and online,
  debounce (`helper.ts`), then call `fetchWaterAreasAt(pendingLocation)`, then fill
  `areaCandidates`.
- Show the candidates as a card at the top of the form. Selecting one calls
  `startFlagging`. "As point" keeps the node flow.
- Run the lookup again when the pin is dragged. Keep the debounce, because of Overpass rate limits.

### Phase 3: Polish (optional)

- **Outline highlight:** when a way or relation pond is selected or a candidate is
  focused, load `out geom` and draw it as a temporary GeoJSON `fill` + `line` layer
  in `MainMap.vue`. This lets the user see which polygon is being tagged. This is the
  most important visual aid for flow B.
- **Tap on water to flag:** in "add" mode, query the Protomaps `water` layer at the
  tapped point. Protomaps does not carry OSM IDs, so this only detects that there is
  water there, and the actual lookup still runs through 2.1.
- **"Add suction point at the shore"** as a quick action on the pond info panel.
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
| A lake or river is flagged by mistake | Large-water warning plus a suggestion to add a suction point |
| The static extract shows an unflagged pond again | Tombstone in `deleteMapNode` |
| Overpass rate limit during the candidate search | Debounce, a single query, `out … 10` limit, reuse the existing cool-down pool |
| Concurrent edit on the area | The existing `baseTags` conflict check, now type-aware |
| `is_in` does not work on an instance (area index missing) | Fall back to the `around:30` part; the query has both parts |

---

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
| `src/components/MainMap.vue` | no drag marker for areas; (Phase 3) outline layer |
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
5. Same place, "As point": a node is created.
6. Offline: node creation goes into the queue. A way pond edit goes into the queue
   and syncs correctly after reconnecting (type `way`).
7. Unflag a way pond: the way stays in OSM, the marker disappears, and it does not
   come back after a reload (tombstone).
8. Conflict: change the way's tags in OSM in the meantime, then sync. The edit is
   marked as a conflict.
9. `npm run lint` and `npm run build` pass.
