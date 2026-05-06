# Release process & versioning – plan

Self-contained spec for the release pipeline and versioning hygiene.
Written so a fresh Claude/Codex session can pick it up without redoing
the discovery that produced it.

## Status (as of 2026-05-06)

- **DMG build pipeline.** Shipped as `.github/workflows/release.yml`.
  Tag-triggered (`v*`), matrix on `macos-14` (Apple Silicon) +
  `macos-13` (Intel), uses `tauri-apps/tauri-action@v0` to build and
  attach both DMGs to a draft GitHub Release on the tag. No code
  signing yet — first launch shows the Gatekeeper "unidentified
  developer" dialog.
- **First-run onboarding wizard.** Shipped in `app/src/components/
  TursoSetupGate.tsx` + `src-tauri/src/lib.rs`. A fresh install (no
  `config.json`) now sees a wizard that asks "connect to existing
  organisation" (URL + token) or "start locally", then writes the
  config and Keychain entry itself. Replaces the previous flow where
  the user had to hand-edit `config.json` before launching the app.
- **release-please.** Not yet wired. See "Plan" below.
- **PR / branch hygiene.** Not yet enforced. See "Plan" below.
- **Code signing + notarisation.** Not in scope until an Apple
  Developer account exists (US$99/yr).

## Why this exists

The repo carries the version string in **four manifests**: `package.json`
(server), `app/package.json` (frontend), `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json`. There is no `CHANGELOG.md`. Today releases
happen by running `cargo tauri build` on the maintainer's laptop and
copying the `.app` to `/Applications/`. That's fine for one user; it
does not survive a second contributor or a second machine.

Concrete pain points the plan below addresses:

1. **Manifest drift.** Bumping the version in only three of four files
   ships a `0.1.1` server with a `0.1.0` `Portuni.app` bundle ID. There
   is no compile-time check that catches this.
2. **No DMG distribution.** Onboarding a new teammate today means
   handing them the repo URL and walking them through ~15 minutes of
   toolchain installs (rustup, bun, npm) plus a first build. Most
   non-developers will give up.
3. **No changelog.** `git log --oneline` is the only source of truth
   for "what changed in this version". Fine for the maintainer, useless
   for someone deciding whether to upgrade.
4. **Direct pushes to `main`.** Works while the project is solo; once
   release-please is involved, it expects clean conventional-commit
   history per merge — which a stream of unsupervised direct pushes
   cannot guarantee.

## How releases will work

Once the plan below is in place, the end-to-end flow is:

```
feat/foo branch → PR "feat(scope): summary"
  → CI (server lint/test/build, app typecheck/build, PR title check)
  → squash merge to main → "feat(scope): summary (#NN)"
  → release-please-bot updates open PR "chore: release 0.1.1"
       └─ bumps version in all 4 manifests
       └─ regenerates CHANGELOG.md from feat:/fix: since v0.1.0
  → review + squash merge release PR
  → release-please-bot tags v0.1.1 + creates GitHub Release
  → release.yml fires on the tag → builds aarch64 + x86_64 DMGs
  → tauri-action attaches DMGs to the Release (still draft)
  → maintainer edits release notes, clicks Publish
  → users go to /releases and download the DMG matching their CPU
```

For the user the path is: download DMG → drag to /Applications →
right-click → Open (one-time Gatekeeper dance) → onboarding wizard
(URL + token, or "start locally") → done.

## Plan

### Manifest update (release-please config)

`release-please-config.json` + `.release-please-manifest.json` at the
repo root. Drives version bumps in:

- `package.json` (`packageJson` strategy)
- `app/package.json` (`packageJson` strategy)
- `src-tauri/Cargo.toml` (`extra-files` regex)
- `src-tauri/tauri.conf.json` (`extra-files` regex)

The `extra-files` regex approach is the canonical pattern for non-npm
manifests; it matches `version = "..."` / `"version": "..."` lines and
substitutes the new value. Keep the regex tight — one line per file —
to avoid clobbering unrelated `version` keys (e.g. JSON Schema
`$schema` or transitive Cargo metadata).

### Hygiene rules

These cannot be set from code; the maintainer enables them in the
GitHub repo Settings UI:

1. **Branch protection on `main`.** Require pull request before
   merging; require status checks `Server (lint, typecheck, test,
   build)`, `App (typecheck, build)`, and `PR title` (added below) to
   be green; require linear history; tick "Include administrators".
2. **Squash merges only.** Repo Settings → Pull Requests → enable
   "Allow squash merging", disable "Allow merge commits" and "Allow
   rebase merging". Default commit message: "Pull request title". This
   guarantees every commit on `main` is a conventional commit, which
   release-please reads.

### Workflows to add

1. **`.github/workflows/release-please.yml`** — runs on push to
   `main`, calls `googleapis/release-please-action@v4` with the config
   files above. Result: an always-open PR titled
   `chore: release X.Y.Z` whose body is a preview of the next
   `CHANGELOG.md` entry.
2. **`.github/workflows/pr-title.yml`** — runs on `pull_request` open
   /edit, calls `amannn/action-semantic-pull-request@v5` to enforce
   that the PR title starts with `feat:`, `fix:`, `chore:`,
   `refactor:`, `docs:`, `perf:`, `test:`, `ci:`, or `build:`. Without
   this, a PR with a title like "update stuff" merges silently and
   release-please skips its content from the changelog (lost entry).

### Repo metadata

- `.github/pull_request_template.md` — Summary + Test plan checklist.
  Forces the author to write something useful in the PR body, which
  release-please uses as the changelog entry detail.
- `CODEOWNERS` — `* @honzapav` for now. Symbolic, but ready for the
  first external contributor.

### CHANGELOG.md seed

Before release-please runs the first time, drop a hand-written stub at
the repo root:

```markdown
# Changelog

## [Unreleased]

## [0.1.0] - 2026-05-06

### Added
- Initial alpha: MCP server, Tauri desktop app, file sync via OpenDAL,
  Turso shared graph, …  (≤6 bullets)
```

Keep it short — `git log --oneline | head -30` is the source of truth
for anyone who wants the gory detail. The stub exists so release-please
has something to append to instead of generating a giant first entry
from 228 commits of pre-release work.

## What we explicitly aren't doing

- **Rewriting pre-`v0.1.0` history.** The 228-commit log is ~95 %
  conventional-commit clean, with 5 merge commits across the whole
  history. Cleaner than most. `git filter-repo` would break every
  existing clone and reference for negligible benefit; release-please
  reads only commits *after* the last tag, so past noise costs nothing.
- **Code signing + notarisation.** Requires an Apple Developer account
  (US$99/yr) plus secrets wired into `release.yml` (`APPLE_CERTIFICATE`,
  `APPLE_ID`, `APPLE_TEAM_ID`, …). Worth doing the day there's a second
  user complaining about Gatekeeper; not before.
- **Auto-updater.** Tauri 2 has `tauri-plugin-updater` with built-in
  signature verification, but it requires signed builds plus a hosted
  update manifest. Defer until after signing.
- **Intel build.** The `release.yml` matrix already includes
  `macos-13` for `x86_64-apple-darwin`. If GitHub deprecates Intel
  runners (likely within a year) and the user base is Apple Silicon
  only, drop that matrix entry.

## Sequence

When the maintainer is ready to flip the switch, the order is:

1. Land this doc + the existing `release.yml` + onboarding wizard on
   `main`.
2. Add `release-please-config.json` + manifest + workflow.
3. Add PR title linter workflow + PR template + CODEOWNERS.
4. Hand-author `CHANGELOG.md` stub for `v0.1.0`.
5. Tag `v0.1.0` on the current `main`. `release.yml` fires, the first
   DMG release goes up.
6. Enable branch protection + squash-only in GitHub UI.
7. From here on, every change is a PR; release-please owns version
   bumps and changelog growth.

Steps 1–4 can be done in a single PR; step 5 is a tag push; step 6 is
GitHub UI. After that the loop runs itself.
