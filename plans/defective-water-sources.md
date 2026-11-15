# Plan: Mark water sources as out of service (issue #118)

## Context

Issue #118 asks for a way to mark a hydrant as **damaged, dry or unusable**, to
show that on the map, and to pull a report out of FireYak that can be handed to
the local authority (water utility / fire brigade).

OSM already has tagging for this, so FireYak does not need its own data store:
the status lives on the OSM object, every other OSM app sees it, and FireYak
reads it with the data it already downloads.

## 1. OSM tagging

| Situation | Tagging | Effect in FireYak |
|---|---|---|
| Temporarily unusable (broken, no water, blocked, closed) | `operational_status=out_of_order` (also seen: `broken`, `closed`) | **Out of service** (red) |
| Usable but faulty (leaking, stiff valve, missing cap, damaged sign) | `operational_status=needs_maintenance` (also `restricted`) | **Caution** (amber) |
| Working (again) | `operational_status=operational` or no tag | normal |
| Free-text reason | `operational_status:note=*` | shown in the info panel |
| When it was checked | `survey:date=YYYY-MM-DD` (FireYak already edits this key; `check_date` is read as an alias) | "reported 3 weeks ago" |
| Permanently gone / decommissioned | lifecycle prefix: `disused:emergency=fire_hydrant`, `removed:emergency=…` | drops out of the queries automatically — this is the existing *delete* path, not this feature |

Notes:

- `operational_status` is documented on the OSM wiki and is already used on
  hydrants. It works the same on `suction_point`, `water_tank` and
  `fire_water_pond`, so the feature covers every water source, not only hydrants.
- **"Dry" is ambiguous.** A US *dry hydrant* (`fire_hydrant:type=pipe`) is a
  working suction pipe, not a fault. The UI must say "no water" / "out of
  order", never "dry". A pond that dries out in summer is `intermittent=yes` /
  `seasonal=*`, which FireYak already edits — not `operational_status`.
- Unknown `operational_status` values are treated as **caution**, never as OK,
  and never as out of service (we don't hide a source on a value we don't
  understand).

## 2. Data plumbing (no query change needed)

The Overpass area query (`out qt center 2000 tags`) and the static extract
already deliver all tags, so `operational_status` is in the data today.

- **New pure helper `src/helper/operationalStatus.ts`** (+ spec):
  `sourceStatus(tags) → 'ok' | 'caution' | 'outOfService'`,
  `statusDate(tags)` (`survey:date` ‖ `check_date`), `statusNote(tags)`.
  Single place for the value mapping in §1.
- **`markerHandler.ts`**: add `status: sourceStatus(element.tags)` to each GeoJSON
  feature's `properties` in `getMarkersForView`.
- **`renderSignature()` must include the status.** Today it is
  `ref:iconKey:lat,lng`; without the status, a live refresh that only flips
  `operational_status` would be judged "nothing changed" and the map would keep
  the old symbol until the next full reload.

## 3. Display on the map (proposal)

Keep the type icon (hydrant/underground/wall/pump/…) so the user still sees
*what* it is, and overlay the *state*:

```
   normal            caution            out of service
   ┌───┐             ┌───┐ ●!           ┌───┐ ●✕
   │ H │             │ H │ (amber)      │ H │ (red)
   └───┘             └───┘              └───┘  icon at 50 % opacity
```

Implementation in `MainMap.vue`, all data-driven on the existing marker source:

1. **Fade the base icon** on `unclustered-point`:
   `'icon-opacity': ['match', ['get','status'], 'outOfService', 0.5, 1]`
   (paint property; no new per-type icon variants needed).
2. **New badge layer** `marker-status-badge` directly above `unclustered-point`,
   same source, `filter: ['all', ['!', ['has','point_count']], ['!=', ['get','status'], 'ok']]`,
   `icon-image: ['match', ['get','status'], 'outOfService', 'status-out', 'status-caution']`,
   `icon-offset` to the top-right corner, `icon-allow-overlap: true`.
   Two small new assets (`status-out.png` red circle with white ✕,
   `status-caution.png` amber circle with white !), registered via
   `markerIconUrls`-style loading. Readable in light, dark and satellite.
3. **Clicks**: add the badge layer to `interactiveLayers` so tapping the badge
   opens the marker like tapping the icon.
4. **Clusters**: unchanged by default. Optional later: `clusterProperties`
   counting `outOfService` and a small red count on the cluster circle.

Why an overlay and not recoloured icons: it works for all 7 icon types with 2
assets instead of 14, and it stays consistent if new icon types are added.

### Filter

In `LayerSelectorModal.vue` add one toggle under the category filters:
**"Show out-of-service sources"** (default **on** — in an incident it is useful
to *see* that the nearest hydrant is broken rather than have it silently
missing). Stored in `settingsStore.markerFilters` as `outOfService`; applied in
`getMarkersForView` next to the category filter.

## 4. Marker info panel

- **Status banner** at the top of `MarkerInfo.vue` when status ≠ ok: red/amber
  `ion-item` with icon, "Out of order" / "Needs maintenance", the note, and
  "reported 12 Oct 2026 (5 weeks ago)". If the date is older than ~6 months, add
  "may have been repaired since".
- `operational_status`, `operational_status:note` and `check_date` join
  `relevantTags` in `MarkerInfo.vue`/`MarkerEdit.vue` so they are not listed
  under "other tags".

## 5. Nearby list, routing and pump calculation

- **Nearby list** (`nearbyWaterSource.ts` / `NearbyMarker.vue`): out-of-service
  sources move to the end of the list (still listed, greyed, red chip "Out of
  order"); caution sources keep their rank with an amber chip. Reuse the chip
  styling from `routeLabel.ts`.
- **Pump calculation**: when the chosen suction/supply point is out of
  service, show a warning chip in the pump panel.

## 6. Reporting a problem (writing the status)

A **"Report problem"** action in `MarkerInfoHeader.vue` (next to edit) opens a
small sheet — much quicker than the full edit form, which matters on site:

```
  Report a problem with this hydrant
  ( ) Out of order — cannot be used
  ( ) Needs maintenance — usable, but faulty
  ( ) Working again
  Note (optional): [ leaking at the cap          ]
  [ Cancel ]                          [ Save ]
```

Saving sets `operational_status`, `operational_status:note` and
`survey:date=<today>` ("Working again" removes `operational_status` and the note
and updates the date). It reuses `markerEditStore` + `editQueue`, so it works
offline and through the OSM dev-server dry runs on previews (via
`osmWrite.ts`). Changeset comment: e.g. "Mark fire hydrant as out of order".
The full edit form also gets an "Operational status" select for completeness.

**Without an OSM account:** offer "Report via OSM note" instead, which creates
an anonymous [OSM note](https://wiki.openstreetmap.org/wiki/Notes) at the
location with the same text. Local mappers (and authorities that watch notes
in their area) pick it up; no login needed. The Notes API accepts anonymous
notes. Take the host from `osmConfig.ts` (`OSM_WEB_URL`), never hard-coded,
so preview builds post notes to the OSM dev server.

## 7. Report for the authorities (phase 3)

A "Defective water sources" list reachable from the layer/filter popover or
Settings:

- scope: the current map view, or a downloaded offline area;
- rows: type, ref/name, status, note, date, coordinates, OSM link;
- actions: **Share** (Capacitor Share → plain-text summary for email/messenger)
  and **Export CSV / GeoJSON**.

FireYak does not know who the responsible authority is, so it hands the user a
report to send rather than sending anything itself.

## 8. Phasing

| Phase | Scope | User-facing |
|---|---|---|
| 1 | Helper + spec, feature `status`, render signature, map overlay, info banner, filter toggle | Yes — whats-new entry |
| 2 | "Report problem" sheet, edit-form field, OSM note fallback, nearby/pump chips | Yes — whats-new entry |
| 3 | Defective-sources report + export | Yes — whats-new entry |

Phase 1 is useful on its own: hydrants that are already tagged in OSM show up
straight away.

## 9. Open questions

1. Default of the "show out-of-service" filter — on (proposed) or off?
2. Nearby list: sink out-of-service sources to the end (proposed) or drop them?
3. Note key: `operational_status:note` (precise, less common) vs. plain `note`
   (common, but often already used for other things).
4. Is the anonymous OSM-note path wanted in phase 2, or only logged-in edits?
