# In-App "What's New" Popup

Goal: after an app update, show the release notes in-app once. Store changelogs
(Play / App Store) stay a static standard phrase — the detailed changelog lives
here instead. Counterpart to `plans/ci-release-pipeline.md` Phase 2.

## Data source: curated `src/assets/whats-new.json` (AI-agent maintained)

Not auto-generated from commits — entries are **written in both English and
German at development time** by whoever (human or AI agent) makes a
user-facing change. `AGENTS.md` §6 makes this mandatory for AI agents; the PR
template checklist covers human contributors. git-cliff still generates
`CHANGELOG.md` and the GitHub release body from commits; this file is the
user-facing, translated layer on top.

- Shape — `unreleased` collects entries during development, the release
  pipeline stamps them into `releases`:
  ```json
  {
    "unreleased": [
      { "type": "feature", "en": "Water tanks can now be added directly on the map.",
        "de": "Wassertanks können jetzt direkt auf der Karte hinzugefügt werden." }
    ],
    "releases": [
      { "version": "2.15.0", "date": "2026-07-15", "entries": [ … ] }
    ]
  }
  ```
  Entry `type`: `feature` | `improvement` | `fix`. Cap `releases` at the last
  ~10 versions to bound bundle size.
- **Bundled, not fetched**: FireYak is offline-first and also runs as a web
  app — no runtime GitHub API dependency, works in the field with no signal.
  The tagged build ships exactly its own notes.
- Release stamping: prepare job runs `scripts/stamp-whats-new.mjs` — moves
  `unreleased` into a new `releases` entry with version + date, trims to 10,
  commits with the version bump. **Fails the release if `unreleased` is empty
  for a minor (`feat`) release** — the guard that "forces" the entries to
  exist.

## Keeping entries honest — `AGENTS.md` §6 + PR checklist

- `AGENTS.md` gains a required section: any user-facing change must add an
  `unreleased` entry with **both** `en` and `de` (native-quality German, not
  literal translation), written from the user's perspective, plain language,
  no code identifiers, ≤ ~120 chars; refactors/CI/docs/deps get no entry;
  `releases` is never edited by hand.
- PR template checklist line: "What's New entry added (en + de) for
  user-facing changes".
- Optional later: CI guard that fails a PR containing `feat`/`fix` commits
  without a `whats-new.json` diff (override label `no-changelog`).

## Trigger logic — `src/composable/whatsNew.ts`

Mirrors the existing `useInAppReview` pattern (hooked in `App.vue`):

- Current version from `import { version } from '@/../package.json'` — same
  source AboutView already uses, and the same value the release pipeline bumps.
- Persist `lastSeenVersion` via `@capacitor/preferences` (same storage as
  `composable/settings.ts`; localStorage-backed on web).
- On startup:
  - no stored version → **first install**: store current, don't show;
  - stored < current → show modal with entries in `(stored, current]`,
    store current on dismiss;
  - stored ≥ current (rollback / dev build) → store current, don't show;
  - entry range empty (release had only chore commits) → skip, still store.
- Simple numeric `major.minor.patch` split-compare is enough (versions come
  from the semver action).
- **Popup pile-up**: coordinate with `useInAppReview` — if What's New is shown,
  skip the review prompt that session (a user reading release notes shouldn't
  immediately get a rating dialog). What's New wins.

## UI — `src/components/WhatsNewModal.vue`

- `ion-modal` (card style), consistent with the MD3 theme work.
- Title `whatsNew.title` → "What's new in v{version}" / "Neu in v{version}".
- Entry text picked by current vue-i18n locale (`entry.de` when German,
  fallback `entry.en`).
- Grouped lists with icons: Features / Improvements / Fixes (only non-empty
  groups).
- Single dismiss button (`whatsNew.dismiss`).
- Multiple skipped versions: render one section per version, newest first.
- Optional: "What's new" entry in `AboutView.vue` that reopens the modal with
  the full bundled history.

## Files

| File | Change |
|---|---|
| `src/assets/whats-new.json` | **new** — curated bilingual entries (seeded, then agent-maintained) |
| `AGENTS.md` | §6: mandatory What's New maintenance rule for AI agents |
| `.github/PULL_REQUEST_TEMPLATE.md` | checklist line for What's New entries |
| `scripts/stamp-whats-new.mjs` | **new** — unreleased → versioned entry at release |
| `src/composable/whatsNew.ts` | **new** — version compare + Preferences |
| `src/components/WhatsNewModal.vue` | **new** — modal UI |
| `src/App.vue` | hook composable (next to `useInAppReview`) |
| `src/locales/en.json`, `de.json` | `whatsNew.*` keys |
| `.github/workflows/release.yml` | prepare job runs stamp script; fails on empty unreleased for feat releases |

## Order
1. Seed `whats-new.json` (empty `unreleased`, `releases` back-filled for the
   current version) + `AGENTS.md` §6 + PR checklist line — **done**; the
   convention starts collecting entries immediately, before the popup exists.
2. Composable + modal + i18n; verify via the `verify` skill (web) by faking a
   lower `lastSeenVersion`.
3. Stamp script + wiring into the release prepare job (ci plan Phase 3).
