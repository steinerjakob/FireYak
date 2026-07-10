# CI/CD Release Pipeline Overhaul

Goal: harden the pipelines against supply-chain attacks, fix iOS export
compliance, switch Android to the internal testing track, add one unified
release pipeline (web + iOS + Android), and generate changelogs automatically —
both for the GitHub release tag and as fastlane release notes.

## Current state (observed)

| Workflow | Trigger | Problems |
|---|---|---|
| `main.yml` (web) | dispatch | Owns semver bump + git tag → implicit "web first" ordering for the other two |
| `android.yml` | dispatch | `--track beta` (want internal); creates the GitHub release with placeholder body; deprecated `actions/create-release` / `upload-release-asset`; relies on preinstalled fastlane instead of the repo `Gemfile` |
| `ios.yml` | dispatch | `ITSAppUsesNonExemptEncryption` missing from `Info.plist` → manual compliance question on every TestFlight build |

Fastlane metadata dirs already exist and `supply` already syncs metadata
(only screenshots/images are skipped), so Play changelogs will be picked up
automatically from `fastlane/metadata/android/<locale>/changelogs/<versionCode>.txt`
once those files exist. Current stale file: `214.txt`; current versionCode is 265.

---

## Phase 0 — Supply-chain hardening (do this first)

Threat model: this is a **public repo whose CI holds the Android signing
keystore, the Play Store service-account key, and the App Store Connect API
key**. Together those allow shipping a signed, auto-updating release to every
user's phone. Today all of them are exposed to arbitrary third-party code in a
single job. Every later phase builds on these workflows, so harden first.

### 0a. Pin all third-party actions to commit SHAs
Mutable tags can be re-pointed at malicious code (the `tj-actions/changed-files`
attack, March 2025, worked exactly this way). Affected:

- `Devofure/advance-android-version-actions@v1.4` — small personal-account
  action; **replace with two `sed` lines** on `android/app/build.gradle`
  instead of pinning (Phase 3 removes it anyway).
- `shimataro/ssh-key-action@v2` → pin to SHA (or inline: `mkdir ~/.ssh`,
  write key + known_hosts, `chmod 600` — 4 lines, no third-party code).
- `paulhatch/semantic-version@v5.4.0`, `maxim-lobanov/setup-xcode@v1` → pin to SHA.
- First-party `actions/*` are lower risk but pin them too for consistency.
- Add Dependabot config for `github-actions` ecosystem so SHA pins still get
  update PRs.

### 0b. Stop executing dependency scripts next to secrets
- `npm install` → `npm ci --ignore-scripts` in all workflows. Verify the build
  still works (Capacitor/Ionic deps sometimes need postinstall; if any do,
  allowlist by running that specific package's script explicitly, or accept
  scripts only in the secret-free build job per 0c).
- Benefit beyond security: lockfile is actually respected → reproducible builds.

### 0c. Privilege separation: build jobs get zero secrets
Split each platform workflow into two jobs with artifact handoff:

```
build (no secrets beyond VITE_PROTOMAPS_API_KEY*)
  npm ci, web build, gradle bundleRelease (unsigned) → upload artifact
sign-and-deploy (secrets, runs no npm/gradle dependency code)
  download artifact → sign (apksigner/jarsigner) → fastlane upload
```

- Android: build unsigned AAB/APK in job 1; job 2 signs with `jarsigner`/
  `apksigner` and runs `fastlane supply`. The keystore and Play JSON key never
  coexist with dependency code.
- iOS is harder to split (xcodebuild needs signing via match during archive);
  mitigate instead: keep match/pilot steps in the same job but apply 0a/0b
  strictly, and scope the ASC API key to the minimum role (App Manager, not
  Admin).
- `VITE_PROTOMAPS_API_KEY` is baked into the client bundle anyway (domain-
  restrict it in the Protomaps dashboard); treat it as public, not a secret.

### 0d. Token hygiene
- `persist-credentials: false` on every `actions/checkout` that doesn't push.
  Where a push is needed, check out with the default `GITHUB_TOKEN` and only
  use the PAT in the specific push step (env var, not on-disk git config).
- Set explicit least-privilege `permissions:` blocks per job (e.g. web build:
  `contents: read`; release job: `contents: write`).
- Rotate the current PAT after hardening lands (it has been exposed to
  postinstall scripts on every past run) — or replace it with a fine-grained
  PAT (contents: write on this repo only) / a GitHub App token.
- Consider rotating `PLAY_STORE_JSON_KEY` and the keystore password on the same
  occasion; the keystore itself can't be rotated cheaply (Play App Signing
  upload key reset requires a support request) — check whether Play App
  Signing is enabled; if yes, a leaked upload key is recoverable, which lowers
  (not removes) the stakes.

### 0e. Guardrails for an OSS repo
- Release workflows: `if: github.ref == 'refs/heads/main'` and rely on
  workflow_dispatch being write-access-only. Never add `pull_request_target`.
- Add GitHub **environments** (`play-store`, `testflight`, `pages`) holding the
  deploy secrets, with required reviewers if a second maintainer ever joins —
  secrets then exist only in deploy jobs that reference the environment.

---

## Phase 1 — Quick fixes to existing pipelines

### 1a. iOS: auto-accept "no encryption" compliance
The app only uses standard HTTPS (exempt), so declare it once in the project:

- Add to `ios/App/App/Info.plist`:
  ```xml
  <key>ITSAppUsesNonExemptEncryption</key>
  <false/>
  ```
This permanently answers the export-compliance question for every future build.
No CI change needed. (Alternative — `deliver` `submission_information` — only
covers App Store submission, not TestFlight builds; the plist key covers both.)

### 1b. Android: internal testing instead of closed beta
- `android.yml`: `--track beta` → `--track internal`.
- Optionally move the raw `fastlane supply` call into a proper `internal` lane in
  `fastlane/Fastfile` (the existing `android deploy` lane is stale/unused):
  ```ruby
  lane :internal do |options|
    upload_to_play_store(
      track: "internal",
      aab: options[:aab],
      skip_upload_screenshots: true,
      skip_upload_images: true
    )
  end
  ```

### 1c. Housekeeping (while touching the files)
- Replace archived `actions/create-release` + `actions/upload-release-asset`
  with `softprops/action-gh-release@v2` (single step: creates release + uploads APK).
- `actions/setup-node@v3` → `@v4`, `actions/setup-java@v3` → `@v4`.
- Android job: `bundle install` (repo has a `Gemfile`) and run fastlane via
  `bundle exec` instead of relying on the runner image.

---

## Phase 2 — Automatic changelog generation

**Tool: git-cliff** (single binary, conventional-commit based — the repo already
uses conventional commits: the `paulhatch/semantic-version` config keys off
`feat`/`BREAKING CHANGE`). Alternatives considered: `release-please` (PR-based,
heavier process change), GitHub auto-generated notes (PR-title based — this repo
releases from direct commits, so commit-based generation fits better).

- Add `cliff.toml` at repo root (group by feat/fix/perf/chore, link commits,
  skip `[skip ci]` version bumps).
- **Commit discipline for OSS contributors**: changelog and semver quality
  depend on conventional commits, which outside contributors won't know.
  Mitigation: squash-merge-only repo setting (PR title becomes the commit) +
  the PR template (added in `.github/PULL_REQUEST_TEMPLATE.md`) asking for a
  conventional title; optionally enforce with `amannn/action-semantic-pull-request`
  (SHA-pinned) once PRs from others become common.
- Maintain `CHANGELOG.md` in the repo (good OSS practice; also F-Droid-friendly
  if that's ever a target).

Store release notes are a **static standard phrase** ("Bug fixes and
improvements" / "Fehlerbehebungen und Verbesserungen"), committed once — the
detailed changelog surfaces in-app instead (What's New popup, see
`plans/whats-new-popup.md`). Outputs per release:

1. **GitHub release body** — `git cliff --unreleased --strip all` (generated
   per release).
2. **Android / Play Store** — static
   `fastlane/metadata/android/{en-US,en-GB,de-DE}/changelogs/default.txt`
   (supply's built-in fallback when no `<versionCode>.txt` exists). Committed
   once, no per-release generation, 500-char Play limit trivially met.
3. **iOS** — static `fastlane/metadata/ios/<locale>/release_notes.txt` for
   App Store submissions. TestFlight "What to test" is skipped entirely, which
   keeps `skip_waiting_for_build_processing: true` (saves ~10–15 macOS minutes
   per release that setting a changelog would cost).
4. **In-app What's New popup** — curated bilingual entries in
   `src/assets/whats-new.json`, maintained at development time by AI agents
   (mandated via `AGENTS.md` §6) and human contributors (PR checklist). The
   release prepare job only *stamps* the `unreleased` block with version +
   date — and fails a `feat` release whose `unreleased` is empty. Feature
   details in `plans/whats-new-popup.md`.

---

## Phase 3 — Unified release pipeline (`release.yml`)

### Structure

Convert the three existing workflows to reusable (`workflow_call` with a
`version` input, keeping `workflow_dispatch` for single-platform releases), then:

```
release.yml (workflow_dispatch, main only)
└── prepare (ubuntu)
    ├── semver from conventional commits (paulhatch/semantic-version, as today)
    ├── bump package.json, android versionName+versionCode, iOS version
    ├── git-cliff → CHANGELOG.md + GitHub release body
    ├── stamp whats-new.json unreleased → vX.Y.Z (fail if empty on feat release)
    ├── ONE commit "chore: release vX.Y.Z [skip ci]" + annotated tag vX.Y.Z
    ├── push, create GitHub Release (softprops/action-gh-release, body from git-cliff)
    └── outputs: version, tag
        ├── web     (needs: prepare, checks out tag) → GitHub Pages
        ├── android (needs: prepare, checks out tag) → Play internal + APK → release asset
        └── ios     (needs: prepare, checks out tag) → TestFlight
```

Platform workflows keep the Phase 0 structure internally (secret-free build job
→ sign/deploy job), so the fan-out calls reusable workflows that are already
hardened.

### Why prepare does *all* version bumps
Today three jobs each commit-and-push their own bump (`git pull` rebase races,
3 bot commits per release). Moving every bump + changelog into one prepare
commit means platform jobs are **read-only** (checkout the tag, build, upload) —
no races, retriable, and a failed platform job can be re-run against the exact
tag without side effects.

- Version bumps in prepare via plain `sed`/`npm version` (the
  `Devofure/advance-android-version-actions` action can be replaced by two sed
  lines on `android/app/build.gradle`; versionCode = current + 1).
- iOS: keep fastlane's `increment_version_number` in the lane **or** move it to
  prepare via `agvtool`-free plist edit; simplest is to leave the existing lane
  logic (it reads package.json, which prepare already bumped).
- Platform jobs `checkout` with `ref: v<version>` so all three build the same commit.

### Trigger & OSS considerations
- `workflow_dispatch` only (maintainer-initiated). No tag-push trigger needed —
  prepare creates the tag itself, and pushing it with the PAT would otherwise
  risk double-triggering.
- Secrets are repo secrets → never exposed to fork PRs; release workflow is
  restricted to `main` (`if: github.ref == 'refs/heads/main'`).
- Keep `GITHUB_TOKEN` where sufficient (release creation, pages); PAT only for
  the version-bump push to main (branch protection / follow-up triggers).
- Individual `android.yml` / `ios.yml` / `web` dispatches remain for hotfix /
  single-platform releases; they take the version as optional input as today.

### main.yml changes
Web workflow loses the semver/tag/commit logic (moves to prepare) and becomes a
pure build+deploy of the given ref — fixes the hidden "web must release first"
coupling.

---

## Files touched

| File | Change |
|---|---|
| `ios/App/App/Info.plist` | + `ITSAppUsesNonExemptEncryption=false` |
| `.github/workflows/android.yml` | SHA pins, `npm ci --ignore-scripts`, build/sign job split, internal track, `workflow_call`, drop release-creation, gh-release v2, bundle exec |
| `.github/workflows/ios.yml` | SHA pins, `npm ci --ignore-scripts`, token hygiene, `workflow_call` |
| `.github/workflows/main.yml` | SHA pins, `npm ci --ignore-scripts`, least-privilege permissions, `workflow_call`, strip versioning logic |
| `.github/dependabot.yml` | **new** — `github-actions` ecosystem updates for SHA pins |
| `.github/workflows/release.yml` | **new** — prepare + fan-out |
| `cliff.toml` | **new** — changelog config |
| `CHANGELOG.md` | **new** — generated |
| `fastlane/Fastfile` | `internal` android lane |
| `fastlane/metadata/android/*/changelogs/default.txt` | **new** — static standard phrase; delete stale `214.txt` |
| `fastlane/metadata/ios/*/release_notes.txt` | **new** — static standard phrase |
| `src/assets/whats-new.json` | **new** — curated bilingual What's New entries, stamped per release (see `plans/whats-new-popup.md`) |
| `AGENTS.md` | §6 What's New maintenance rule for AI agents |

## Order of implementation
1. Phase 0 (hardening: pins + `npm ci --ignore-scripts` + checkout hygiene first,
   job split next; rotate PAT/Play key after it lands. Verify each platform
   with a normal dispatch run).
2. Phase 1 (three small, independently testable changes; dispatch run to verify).
3. Phase 2 (`cliff.toml`, verify output locally with `git cliff --unreleased`).
4. Phase 3 (release.yml + reusable conversion; first run with a patch release).

## Open questions
- Exact wording of the static store phrase per locale (en/de) — trivial, decide
  when committing the metadata files.
- ~~What's New popup content language~~ — resolved: entries are hand/agent-
  curated in en + de at development time (`AGENTS.md` §6), not derived from
  commits.