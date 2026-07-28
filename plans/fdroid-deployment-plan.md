# F-Droid Deployment Plan

Goal: get FireYak into the F-Droid ecosystem (official main repo and/or a
faster alternative) without breaking the existing Play Store / App Store /
GitHub release pipeline (`plans/ci-release-pipeline.md`).

## 1. Why this isn't just "submit the APK"

F-Droid builds every app **from source, on its own infrastructure, with no
access to your repo secrets**, and only accepts apps that are 100% free
software end to end — app code *and* every bundled library. Two
consequences drive this whole plan:

1. Any dependency that pulls in a proprietary component (most commonly
   Google Play Services / Play Core) is an inclusion blocker unless removed
   or gated out of the build F-Droid uses.
2. Anything the build needs that lives in a GitHub Actions secret today
   (signing keystore, API keys) is invisible to F-Droid's build server —
   the recipe has to work from what's committed in the repo alone.

## 2. Audit of the current codebase

Checked license, all Capacitor plugin `android/build.gradle` files (pulled
directly via `npm pack` and inspected, not assumed from memory), the Android
project, `index.html`, and `vite.config.ts`.

| Area | Finding | Blocking? |
|---|---|---|
| License | `LICENSE` is GPL-3.0 (whole repo) | ✅ compatible, no action |
| `@capacitor/geolocation@8` | Depends on `com.google.android.gms:play-services-location:21.3.0` (confirmed in the plugin's `android/build.gradle` and its Kotlin source imports `com.google.android.gms.location.LocationServices`). Used for GPS throughout `MainMap.vue` / nearby-sources. | 🚫 yes |
| `@capacitor-community/in-app-review@8` | Depends on `com.google.android.play:review:2.0.2` (Play Core). Used only in `src/composable/inAppReview.ts` / `src/App.vue` for the Play Store rating prompt. | 🚫 yes |
| `google-services.json` handling | Not committed; `android/app/build.gradle` conditionally applies `com.google.gms.google-services` if the file exists, and `android/build.gradle` always adds `classpath 'com.google.gms:google-services:4.4.4'` to the build graph. No Firebase/push-notification code anywhere in `src/`. | 🚫 dead weight, remove |
| `index.html` | Loads `fonts.googleapis.com` directly via `<link>` tags at runtime, **in addition to** `unplugin-fonts` already self-hosting Roboto in the build (`vite.config.ts`). Redundant live call to Google at every app start. | 🚫 privacy/anti-feature flag |
| `VITE_PROTOMAPS_API_KEY` | Baked into the JS bundle at build time from GitHub secret `PROTOMAPS_API_KEY_ANDROID` (`src/offline/offlineProtocol.ts`, `src/views/OfflineAreasView.vue`). Required for online map tiles. | ⚠️ reproducibility issue, needs a strategy (not a hard blocker) |
| Everything else | `@capacitor/app`, `filesystem`, `network`, `preferences`, `screen-orientation`, `share`, `inappbrowser`, `maplibre-gl`, `@protomaps/basemaps` — no Google/Firebase/analytics/tracking deps in any of their `build.gradle`s or in `src/`. OSM OAuth2 `CLIENT_ID` in `osmAuthStore.ts` is a public PKCE client id, fine to keep committed. | ✅ clean |
| CI shape | `android.yml` already builds **unsigned** `assembleRelease`/`bundleRelease` in a job with no secrets, then signs in a separate job. This is exactly the artifact shape F-Droid's own build+sign process wants. | ✅ reusable |
| Store listing | `fastlane/metadata/android/{en-US,en-GB,de-DE}/` already has title/description/changelogs. F-Droid can import this directly. | ✅ reusable |

## 3. Required code changes

### 3.1 Geolocation — remove the Play Services dependency

Ranked options:

- **A. Try the browser Geolocation API first.** Capacitor's WebView exposes
  `navigator.geolocation` once `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`
  are granted (already declared in `AndroidManifest.xml`). If it behaves
  well enough for `getCurrentPosition`/`watchPosition` inside the native
  shell, the native plugin can be dropped for Android entirely — cheapest
  fix, zero new native code. Needs on-device testing for permission-prompt
  UX and accuracy/latency vs. the current plugin.
- **B. Small custom Capacitor plugin over `android.location.LocationManager`.**
  Fallback if A doesn't hold up. `@capacitor/geolocation` used
  `LocationManager` directly before it switched to the fused provider; the
  app only needs single-shot + watch position, roughly 100 lines of Kotlin.
  No proprietary dependency, full control.
- **C. Audit for an existing maintained FOSS-only geolocation plugin** —
  lowest priority; most alternatives in the wild wrap Play Services too, so
  don't assume without checking their `build.gradle`.

**Recommendation:** prototype A, fall back to B if accuracy/UX regresses.

### 3.2 Gate out `@capacitor-community/in-app-review`

The Play Store rating prompt has no meaning off Play. Add a build flag
(e.g. `FDROID=true`, mirroring how `google-services.json` is already
conditionally applied) so the F-Droid variant:
- excludes the Gradle dependency, and
- makes `useInAppReview()` (`src/composable/inAppReview.ts`) a no-op.

### 3.3 Drop the raw Google Fonts `<link>` tags in `index.html`

`unplugin-fonts` already self-hosts Roboto at build time — delete the two
`fonts.googleapis.com` `<link>` tags. Independent good fix (privacy +
one less network dependency for the PWA/offline case too), not F-Droid-only.

### 3.4 Remove the leftover Google Services Gradle wiring

- `android/build.gradle`: drop `classpath 'com.google.gms:google-services:4.4.4'`.
- `android/app/build.gradle`: drop the whole `google-services.json` /
  `com.google.gms.google-services` conditional block.

Nothing currently uses it (no committed `google-services.json`, no push
notification code), so it's pure dead weight that adds a proprietary
classpath entry F-Droid's scanner will flag.

### 3.5 Protomaps API key — reproducible-build strategy

F-Droid builds strictly from the tagged git ref with no secrets, so the key
either has to be committed or the feature has to degrade gracefully without
one. Two realistic options:

- **A. Commit a second, free-tier Protomaps API key** dedicated to
  F-Droid/self-builds, separate from the paid key used for Play/App Store
  builds. Protomaps' client-embedded keys are designed to be public
  (rate-limited, not billing-metered the way a typical secret API key is) —
  confirm current free-tier limits/ToS before committing one.
- **B. Ship without a baked-in key**: online tiles disabled by default in
  F-Droid/self-builds, with a Settings field where the user pastes their own
  free Protomaps key (self-service signup). More purist, worse first-run UX.

**Recommendation:** A, given how Protomaps' key model is designed; revisit
B only if abuse becomes a real problem.

## 4. F-Droid build recipe & submission

- F-Droid metadata lives in `fdroiddata` (GitLab). A recipe for FireYak
  needs, roughly: `npm ci`, `npm run buildAndSync`, then
  `cd android && ./gradlew assembleRelease` (or `bundleRelease`), targeting
  Node 22 + JDK 21 (matching `.github/workflows/android.yml`) — verify these
  versions are available on F-Droid's current buildserver image before
  submitting, and adjust if not.
- `versionName`/`versionCode` are already bumped programmatically and tagged
  (`vX.Y.Z`) by `release.yml` — the F-Droid recipe just points at those
  existing tags, no versioning-scheme changes needed.
- The build-time fetch of Google Fonts by `unplugin-fonts` needs outbound
  HTTPS during the *build* (not runtime) — F-Droid's buildserver does allow
  network access while building (it needs it for npm/gradle too), so this
  should work, but is worth confirming on a real F-Droid build rather than
  assuming.
- Signing is handled entirely by F-Droid's own key, independent of the
  `KEYSTORE_FILE`/`KEY_ALIAS`/`KEY_PASSWORD` secrets used for Play — nothing
  from those needs to be shared.
- Store listing: point F-Droid's metadata importer at the existing
  `fastlane/metadata/android/**` — reuse as-is rather than duplicating.
- Submission: fork `fdroiddata`, add `metadata/at.jst.fireyak.yml`, open an
  MR. F-Droid's automated scanner re-checks for non-free deps/anti-features
  on every build; expect iteration based on reviewer/bot feedback. Review
  queue is volunteer-run and can take weeks to months.

### Faster/parallel options

- **IzzyOnDroid**: a secondary F-Droid-compatible repo with a much faster
  review turnaround, commonly used either as a stopgap while the official
  MR is in review, or as a permanent alternative. Same non-free-dependency
  constraints apply, so items in §3 are still required first.
- **Self-hosted F-Droid repo** (`fdroidserver` + the already-signed GitHub
  Release APK, served from e.g. `app.fireyak.org`): doesn't go through
  F-Droid's review at all, so it could ship almost immediately — even
  before §3 is finished — but it isn't "on F-Droid" in the sense most users
  browse, and still shouldn't ship the Play-Services-dependent build if the
  point is to offer a Play-free alternative.

## 5. Suggested order of operations

1. §3.3 + §3.4 — no-risk cleanup, can land immediately.
2. §3.1 — decide geolocation approach, implement, test on-device (Android).
3. §3.2 — gate `in-app-review` behind the same build flag.
4. §3.5 — decide + implement the Protomaps key strategy.
5. Add a cheap CI tripwire, e.g. `grep -rE "com\.google\.android\.(gms|play)" android/` in
   the F-Droid build job, so a future dependency bump can't silently
   reintroduce a proprietary dep.
6. Cut a normal tagged release once 1–4 land (existing `release.yml`
   already tags + builds unsigned artifacts — no pipeline changes needed
   for this part).
7. Write the `fdroiddata` metadata and open the MR (and/or submit to
   IzzyOnDroid / stand up a self-hosted repo, per the decision in §6).

## 6. Decisions needed before implementation starts

- Geolocation: try browser API first (3.1-A), or go straight to a custom
  plugin (3.1-B)?
- Protomaps key: commit a free-tier public key (3.5-A), or bring-your-own-key
  settings field (3.5-B)?
- Distribution target(s): official F-Droid main repo, IzzyOnDroid,
  self-hosted repo, or a combination — and in what order?
