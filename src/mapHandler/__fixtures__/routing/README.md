# Routing test fixtures

Real map data for the five validation scenes of `plans/hose-routing-optimized.md`
(section 5). They are **test data, not app assets**: Vite bundles only modules
reachable from `src/main.ts`, specs read these files with `node:fs`, and app
code must never import anything from this folder (eslint `no-restricted-imports`).
`public/` is the only folder copied verbatim into `dist/`; fixtures never go there.

## What is committed and what is not

| Committed | Gitignored (fetch locally) |
|---|---|
| this README, every `*/scene.json` | `*/basemap/**/*.mvt`, `*/dem/**/*.webp` |

The tiles are gitignored until it is confirmed that Protomaps' terms (and
Mapterhorn's per-source licences) allow redistributing them in a public
repository. Every `*.scenes.spec.ts` and the tile checks in
`src/testing/routingFixtures.spec.ts` are skipped (`describe.skipIf(!fixturesPresent)`)
when any tile is missing; all other specs always run.

## Layout

```
1-rural-pond/   scene.json  basemap/15/<x>/<y>.mvt  dem/14/<x>/<y>.webp  dem/12/<x>/<y>.webp
2-melk/         scene.json  basemap/15/…            dem/14/…
3-persenbeug/   scene.json  basemap/15/…            dem/14/…
4-vienna/       scene.json  basemap/15/… (cropped to 4 tiles, about +-500 m)  dem/14/…
5-innsbruck/    scene.json  basemap/15/…            dem/14/…  dem/12/…
```

`scene.json` holds the fetch date, the anchor, the tile ranges (the fetch script
downloads exactly these), the named `cases` (scene 1), the ring `rings`
(vehicle positions already moved to the nearest road, as in the research, so
tests do not depend on that rule) and, for scene 1, the pond outline. Expected
values live in the spec files as tolerant ranges, not in the JSON.

Notes on the data:

- The pond outline of scene 1 is the OSM outline of relation 7228761 (outer
  ring and island), taken from the OSM API during the research.
- Scene 4 (Vienna) is cropped to +-500 m, so only the 150 m and 300 m rings
  are kept (30 positions).
- Scene 5 has `rings` (8, the strict rule: road within 60 m) and `ringsRelaxed`
  (29, road or track within 150 m).
- The `pond` case vehicle is the research position (48.1300, 15.2725), which is
  645 m from the shore. The owner's screenshot (terrain 528 m, hydrant 295 m /
  232 m) used vehicle positions that were not recorded, so those numbers cannot
  be reproduced; the baseline specs pin what today's code gives for the
  research position.

## Regenerating

```sh
VITE_PROTOMAPS_API_KEY=<key> node scripts/fetch-routing-fixtures.mjs [--scene <id>]
```

The key is read from the environment only and is never written to a file.
Mapterhorn needs no key. Behind an HTTPS proxy that Node does not use by default
add `NODE_USE_ENV_PROXY=1` (and `NODE_EXTRA_CA_CERTS=<ca bundle>`).
Re-fetching changes the data slightly over time, which is why specs use
ranges. The plan, not the fixtures, is the record of the research.

## Sources and attribution

- Basemap: `https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt` (z15)
- Terrain: `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` (terrarium, 512 px; z14, z12)
- (c) OpenStreetMap contributors, ODbL. Vector tiles: Protomaps. Terrain:
  Mapterhorn (per-source attribution at mapterhorn.com/attribution).

Fetched 2026-11-10.
