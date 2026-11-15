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

| Situation                                                | Tagging                                                           | Effect in FireYak                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Temporarily unusable (broken, no water, blocked, closed) | `operational_status=out_of_order` (also seen: `broken`, `closed`) | **Out of service** (red)                                                       |
| Usable but faulty (leaking, stiff valve, missing cap)    | `operational_status=needs_maintenance` (also `restricted`)        | **Caution** (amber)                                                            |
| Working (again)                                          | no tag, or `operational_status=operational`                       | normal                                                                         |
| Permanently gone / decommissioned                        | lifecycle prefix `disused:emergency=…` / `removed:emergency=…`    | drops out of the queries; this is the existing _delete_ path, not this feature |

Notes:

- `operational_status` is documented on the OSM wiki and works the same on
  `fire_hydrant`, `suction_point`, `water_tank` and `fire_water_pond`, so the
  feature covers every water source.
- **"Dry" is ambiguous.** A US _dry hydrant_ (`fire_hydrant:type=pipe`) is a
  working suction pipe, not a fault. The UI says "out of order", never "dry".
  A pond that dries out in summer is `intermittent=yes` / `seasonal=*`, which
  FireYak already edits.
- Unknown `operational_status` values count as **caution**: never as OK, never
  as out of service.

## 2. Data plumbing (no query change needed)

The Overpass area query (`out qt center 2000 tags`) and the static extract
already deliver all tags.

- **New pure helper `src/helper/operationalStatus.ts`** (+ spec):
  `sourceStatus(tags) → 'ok' | 'caution' | 'outOfService'`. Single place for
  the value mapping in §1.
- **`markerHandler.ts`**: add `status: sourceStatus(element.tags)` to each GeoJSON
  feature's `properties` in `getMarkersForView`, and to `NearbyMarker` entries.
- **`renderSignature()` must include the status.** Today it is
  `ref:iconKey:lat,lng`; without the status, a live refresh that only flips
  `operational_status` is judged "nothing changed" and the map keeps the old
  symbol.

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
   Two new assets (`status-out.png`: red circle, white ✕; `status-caution.png`:
   amber circle, white !), loaded alongside `markerIconUrls`. Must read on light,
   dark and satellite.
3. **Clicks**: add the badge layer to `interactiveLayers`.
4. **Clusters**: unchanged.

Two assets instead of a red variant of all 7 icon types, and new icon types get
the badge for free.

### Filter

`LayerSelectorModal.vue` gets one toggle under the category filters:
**"Show out-of-service sources"**, default **on**. Stored as
`markerFilters.outOfService` in `settingsStore`, applied in `getMarkersForView`
next to the category filter. Caution sources are always shown.

## 4. Marker info panel

No banner. `operational_status` becomes a normal labelled row like the other
tags: it joins `tagTranslationKeys` / `relevantTags` in `MarkerInfo.vue` (and
`relevantTags` in `MarkerEdit.vue`, so it is not listed under "other tags"),
with translated values (_Out of order_, _Needs maintenance_, …; unknown values
shown raw). `survey:date` keeps showing as it does today.

## 5. Nearby list

`NearbyMarker.vue`: the row icon gets the **same badge and fade** as on the map
(CSS overlay on the existing icon, same two assets). Order and routing are
unchanged.

## 6. Setting the status

The existing edit form (`MarkerEdit.vue`) gets an **"Operational status"**
select for all water-source types: _Working_ (removes the tag) / _Needs
maintenance_ / _Out of order_. Changing it does **not** touch `survey:date`; the
user sets the date themselves with the existing date field if they want one.
It goes through `markerEditStore` + `editQueue` like every other edit, so it
works offline and as a dry run on preview builds. An existing `broken` /
`closed` / unknown value is shown as-is and kept unless the user changes it.

## 7. Delivery

One PR (`feature/118-out-of-service`): helper + spec, feature/nearby `status`,
render signature, map layers + assets, filter toggle, info-panel row, nearby badge,
edit-form select, en/de strings, one `whats-new.json` entry.
