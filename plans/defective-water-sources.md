# Plan: Show out-of-service water sources (issue #118)

## Context

Issue #118 asks for a way to mark a hydrant as **damaged, dry or unusable** and
to see that on the map.

OSM already has tagging for this, so FireYak does not need its own data store:
the status lives on the OSM object, every other OSM app sees it, and FireYak
reads it with the data it already downloads.

Decided scope (review of the first draft):

- Out-of-service sources are **shown by default** (filter toggle on).
- The nearby list keeps them **in their normal place**, with the same badges as
  the map. No reordering, no removal.
- **No note key** is written. A free-text `note`/`description` that is already on
  the object keeps showing as it does today.
- **No status banner** in the marker info; the status is a normal tag row.
- **The date is never autofilled**; users set `survey:date` themselves.
- **No separate "report problem" sheet, no OSM notes, no export / authority
  report.** Setting the status is a field in the existing edit form.

## 1. OSM tagging

The hydrant wiki page (Tag:emergency=fire_hydrant) says hydrants are in service
by default and an **out-of-service** one takes the lifecycle prefix:
`emergency=fire_hydrant` is **replaced** by `disused:emergency=fire_hydrant`.
FireYak writes it that way, for every water-source type.

| Situation                                                | Tagging FireYak writes                      | Also read (other mappers)                                   | Effect in FireYak        |
| -------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| Temporarily unusable (broken, no water, blocked, closed) | `disused:emergency=<type>` (no `emergency`) | `operational_status=out_of_order` / `broken` / `closed` / … | **Out of service** (red) |
| Usable but faulty (leaking, stiff valve, missing cap)    | `operational_status=needs_maintenance`      | `operational_status=restricted`, unknown values             | **Caution** (amber)      |
| Working (again)                                          | `emergency=<type>`, no `operational_status` | `operational_status=operational`                            | normal                   |

Notes:

- "Needs maintenance" does not conflict with the wiki: the source is still in
  service, so it keeps `emergency=*`.
- `disused:emergency` is only read for the four water-source types
  (`fire_hydrant`, `suction_point`, `water_tank`, `fire_water_pond`).
- **"Dry" is ambiguous.** A US _dry hydrant_ (`fire_hydrant:type=pipe`) is a
  working suction pipe, not a fault. The UI says "out of order", never "dry".
  A pond that dries out in summer is `intermittent=yes` / `seasonal=*`, which
  FireYak already edits.
- Unknown `operational_status` values count as **caution**: never as OK, never
  as out of service.

## 2. Data plumbing

- **Pure helper `src/helper/operationalStatus.ts`** (+ spec):
  `sourceStatus(tags) → 'ok' | 'caution' | 'outOfService'`, `emergencyOf(tags)`
  (`emergency`, else a water-source `disused:emergency`), and
  `splitLifecycle` / `applyLifecycle` for the edit form.
- **Every type check uses `emergencyOf`**, so a disused hydrant is still a
  hydrant: icon and filter category, titles, marker info/header, pond outline,
  nearby candidates, pump calculation, pond-area lookup, `isMarkerTags`,
  flag/unflag detection (taking a pond out of service is not an unflag) and the
  changeset comment ("Mark fire_hydrant as out of service" / "… back in service").
- **Overpass area query** also asks for `node["disused:emergency"~…]` and
  `nwr["disused:emergency"=fire_water_pond]`.
- **Static extract (data.fireyak.org)**: built outside this repo. Its filter must
  also keep `disused:emergency=fire_hydrant,suction_point,water_tank,fire_water_pond`.
  Until then, disused sources come only from the live Overpass top-up (and are not
  in downloaded offline areas).
- **`markerHandler.ts`**: `status` on each GeoJSON feature; `renderSignature()`
  includes it, so a live refresh that only changes the status redraws the marker.

## 3. Map

Keep the type icon (hydrant/underground/wall/pump/…) so the user still sees
_what_ it is, and overlay the _state_:

```
   normal            caution            out of service
   ┌───┐             ┌───┐ ●!           ┌───┐ ●✕
   │ H │             │ H │ (amber)      │ H │ (red)
   └───┘             └───┘              └───┘  icon at 50 % opacity
```

In `MainMap.vue`, data-driven on the existing marker source:

1. **Fade the base icon** on `unclustered-point`:
   `'icon-opacity': ['match', ['get','status'], 'outOfService', 0.5, 1]`.
2. **New badge layer** `marker-status-badge` directly above `unclustered-point`,
   same source, `filter: ['all', ['!', ['has','point_count']], ['!=', ['get','status'], 'ok']]`,
   `icon-image: ['match', ['get','status'], 'outOfService', 'status-out', 'status-caution']`,
   `icon-offset` to the top-right corner, `icon-allow-overlap: true`.
   Two badges (red disc with a white ✕, amber disc with a dark !, white ring,
   20 px), drawn on a canvas at runtime (`src/mapHandler/statusBadges.ts`) and
   shared with the nearby list and the filter row. The mark sits well inside the
   disc. Must read on light, dark and satellite.
3. **Clicks**: add the badge layer to `interactiveLayers`.
4. **Clusters**: unchanged.

Two assets instead of a red variant of all 7 icon types, and new icon types get
the badge for free.

### Filter

`LayerSelectorModal.vue` gets one toggle under the category filters:
**"Out of Service"** (with the red badge as its icon), default **on**. Stored as
`markerFilters.outOfService` in `settingsStore`, applied in `getMarkersForView`
next to the category filter. Caution sources are always shown.

## 4. Marker info panel

No banner. `operational_status` becomes a normal labelled row like the other
tags (a disused source shows it as _Out of order_): it joins `tagTranslationKeys` / `relevantTags` in `MarkerInfo.vue` (and
`relevantTags` in `MarkerEdit.vue`, so it is not listed under "other tags"),
with translated values (_Out of order_, _Needs maintenance_, …; unknown values
shown raw). `survey:date` keeps showing as it does today.

## 5. Nearby list

`NearbyMarker.vue`: the row icon gets the **same badge and fade** as on the map
(CSS overlay on the existing icon, same two assets). Order and routing are
unchanged.

## 6. Setting the status

The existing edit form (`MarkerEdit.vue`) gets an **"Operational status"**
select for all water-source types: _Working_ (`emergency=<type>`, no
`operational_status`) / _Needs maintenance_ (`operational_status`) / _Out of
order_ (`disused:emergency=<type>`, via the store's `outOfService` flag; the form
itself always edits the plain type). Changing it does **not** touch `survey:date`; the
user sets the date themselves with the existing date field if they want one.
It goes through `markerEditStore` + `editQueue` like every other edit, so it
works offline and as a dry run on preview builds. An existing `broken` /
`closed` / unknown value is shown as-is and kept unless the user changes it.

## 7. Delivery

One PR (`feature/118-out-of-service`): helper + spec, feature/nearby `status`,
render signature, Overpass query, map layers + badges, filter toggle, info-panel row, nearby badge,
edit-form select, en/de strings, one `whats-new.json` entry.
