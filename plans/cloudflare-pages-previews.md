# Cloudflare Pages preview deployments

Per-branch / per-PR preview builds of the web app on **Cloudflare Pages** (free
plan, Git integration). Production stays on GitHub Pages (`app.fireyak.org`,
`.github/workflows/main.yml`). Nothing in this repo deploys to Cloudflare. The
Cloudflare dashboard builds every push on its own.

## 1. Create the Pages project

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**:

1. Authorize the Cloudflare GitHub app for `steinerjakob/fireyak` only.
2. **Project name:** e.g. `fireyak`. This sets the domain `fireyak.pages.dev`,
   and every OSM redirect URI below depends on it.
3. **Production branch:** `main`.
4. **Framework preset:** None (or Vue). **Build command:** `npm run build`.
   **Build output directory:** `dist`. **Root directory:** empty.
5. **Environment variables** (Settings → Variables and Secrets; set
   *Production* and *Preview* separately):

   | Variable | Production | Preview |
   |---|---|---|
   | `NODE_VERSION` | `22` | `22` |
   | `VITE_PROTOMAPS_API_KEY` | key (Secret) | key (Secret) |
   | `VITE_OSM_URL` | *(unset)* | `https://master.apis.dev.openstreetmap.org` |
   | `VITE_OSM_CLIENT_ID` | *(unset)* | client ID from step 3 |

   Leaving `VITE_OSM_*` unset makes a build use the real
   www.openstreetmap.org with the production client, as on app.fireyak.org.
   That client only knows the app.fireyak.org redirect URI, so OSM login does
   not work on `*.pages.dev` production builds. Only Preview builds are meant
   for login testing.

## 2. Branch / preview settings

Settings → **Builds & deployments → Branch control**:

- **Production branch:** `main`. You can also turn off automatic production
  deployments, because app.fireyak.org is the real production site and the
  Cloudflare "production" deployment is just another preview.
- **Preview branches:** *Custom branches*, with include `*` and exclude
  `dependabot/*`. Dependabot (`.github/dependabot.yml`) opens many short-lived
  branches that would each use up a build.
- Release commits are tagged `[skip ci]`. Cloudflare Pages honours `[skip ci]`
  / `[CI SKIP]` in the commit message, so those are not built.

Each deployment gets two URLs:

- `https://<sha8>.fireyak.pages.dev`: per commit, never changes.
- `https://<branch-alias>.fireyak.pages.dev`: per branch, always the latest
  commit (branch name lower-cased, `/` and other characters → `-`, truncated).

Cloudflare posts the preview link on the PR as a check/comment.

## 3. OSM login on previews (OSM dev server)

Previews log in against **master.apis.dev.openstreetmap.org** so that test
edits never touch real OSM data.

1. Create an account on https://master.apis.dev.openstreetmap.org. It is
   separate from your osm.org account.
2. My Settings → **OAuth 2 applications → Register new application**:
   - Name: `FireYak preview`
   - Confidential application: **unchecked** (public PKCE client, no secret)
   - Permissions: *Read user preferences* (`read_prefs`) and *Modify the map*
     (`write_api`)
   - Redirect URIs, one per line, **exact match**:
     ```
     https://fireyak.pages.dev/land.html
     https://<branch-alias>.fireyak.pages.dev/land.html
     http://localhost:5173/land.html
     ```
3. Copy the Client ID into `VITE_OSM_CLIENT_ID` (Preview).

OSM compares redirect URIs exactly and does not accept wildcards. Login
therefore only works on hosts listed above. The per-commit `<sha8>.` URLs
**cannot** log in. Use the stable branch alias, and add an alias to the OAuth
app when you need login on a new long-lived branch. Everything except login
and editing works on any preview URL.

To test locally against the dev server, put the same two `VITE_OSM_*` lines in
`.env.local` and run `npm run dev`.

### How the app uses these variables

`src/services/osmConfig.ts` reads `VITE_OSM_URL` / `VITE_OSM_CLIENT_ID` and
falls back to `https://www.openstreetmap.org` and the production client ID when
they are unset. When `VITE_OSM_URL` is set, it calls
`OSM.configure({ apiUrl })`. osm-api then sends API calls **and** its OAuth
popup/token exchange to the dev host. The "view on OSM", "edit on OSM" and "OSM
account" links use the same base URL. Native (Capacitor) builds ignore both
variables, so their behaviour is unchanged.

### Caveat: map data still comes from production OSM

Markers are loaded from the production Overpass API / `data.fireyak.org`. Their
node IDs do not exist (or are unrelated nodes) on the dev server. So on a
preview:

- **Adding** a new marker works and creates a node on the dev server. The node
  will not show up on the preview's map.
- **Editing or deleting** an existing marker targets an ID that is missing on
  the dev server, so it fails (or hits an unrelated node). Treat preview edits
  as login/flow testing only.

## 4. Other hostname-dependent parts (checked)

| Area | Depends on hostname? | Notes |
|---|---|---|
| Protomaps tiles (`VITE_PROTOMAPS_API_KEY`) | **Yes** | The key's *allowed origins* (protomaps.com dashboard) must include the pages.dev domain, e.g. `https://*.fireyak.pages.dev` and `https://fireyak.pages.dev`. Without it the base map stays blank. Using a separate preview key is cleaner. |
| Overpass referrer (`overPassApi.ts`) | Uses `location.origin` | Works as is. The Referer becomes `https://<host>/overpass-client/<id>`, which is fine. |
| `land.html` OAuth landing | Same-origin | Served from `public/`, works on any host. It must be listed exactly as a redirect URI (see §3). |
| PWA manifest / service worker (`vite.config.ts`) | No | No absolute URLs, `base: '/'`. Each preview host gets its own SW scope. |
| `public/.well-known` (App Links / Universal Links) | Only for app.fireyak.org | Harmless on previews. The apps don't claim pages.dev. |
| `index.html` canonical / OG / JSON-LD | Hard-coded app.fireyak.org | Fine. Previews are not meant to be indexed. You can add `X-Robots-Tag: noindex` for previews via a `_headers` file if needed. |
| Share link (`MarkerInfoHeader.vue`) | Hard-coded app.fireyak.org | Shared links from a preview open production. This is intended. |
| `data.fireyak.org` static extract | CORS | Must allow the pages.dev origin (check the R2 bucket CORS policy). Otherwise those fetches fail on previews. |
| SPA routing | No | The router uses hash history, so no `_redirects` is needed. |

## 5. Install / build in Cloudflare's CI

- Cloudflare runs `npm clean-install` **with** lifecycle scripts, so
  `prepare: husky` runs. husky v9 only installs git hooks in the build
  container's checkout and exits 0 (checked locally with `CI=true npm ci`).
  To skip it anyway, set `HUSKY=0`.
- `npm run build` passes locally on Node 22 with and without the `VITE_OSM_*`
  variables.
