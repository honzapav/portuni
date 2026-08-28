# Release process & versioning – plan

Self-contained spec for the release pipeline and versioning hygiene.
Written so a fresh Claude/Codex session can pick it up without redoing
the discovery that produced it.

## Status (as of 2026-05-06)

- **DMG build pipeline.** Shipped as `.github/workflows/release.yml`.
  Tag-triggered (`v*`), `macos-14` (Apple Silicon only — Intel dropped
  2026-07-04, no Intel users), uses `tauri-apps/tauri-action@v0` to
  build and attach the DMG to a draft GitHub Release on the tag.
  Builds are Developer ID signed and notarized (see below).
- **Auto-updater artefacts.** Shipped (2026-08-28). `release.yml` builds with
  `--bundles app,dmg --config apps/desktop/tauri.release.conf.json`
  (`createUpdaterArtifacts: true`) and `includeUpdaterJson: true`, so the
  draft release also gets `Portuni.app.tar.gz`, its minisign `.sig`, and
  `latest.json`. Signed with the `TAURI_SIGNING_PRIVATE_KEY` secret (see the
  signing checklist below); the verify step fails the job if any of the
  three is missing or `latest.json`'s version doesn't match the tag.
- **First-run onboarding wizard.** Shipped in `apps/web/src/components/
  TursoSetupGate.tsx` + `apps/desktop/src/lib.rs`. A fresh install (no
  `config.json`) now sees a wizard that asks "connect to existing
  organisation" (URL + token) or "start locally", then writes the
  config and Keychain entry itself. Replaces the previous flow where
  the user had to hand-edit `config.json` before launching the app.
- **release-please.** Wired (2026-07-05). `release-please-config.json` +
  `.release-please-manifest.json` at the repo root drive version bumps across
  the four manifests (`package.json`, `apps/web/package.json`,
  `apps/desktop/tauri.conf.json`, `apps/desktop/Cargo.toml` — the latter via a
  `# x-release-please-version` annotation) and generate `CHANGELOG.md`.
  `.github/workflows/release-please.yml` runs on push to `main` and maintains
  the `chore: release X.Y.Z` PR; merging it tags `vX.Y.Z`, which triggers
  `release.yml`. The tag is pushed with the fine-grained PAT secret
  `RELEASE_PLEASE_TOKEN` (Contents + Pull requests RW, scoped to this repo;
  copy in Bitwarden "Portuni release-please PAT") — NOT `GITHUB_TOKEN`, whose
  tags don't trigger downstream workflows. `bootstrap-sha` in the config
  anchors the first changelog at wiring time so it doesn't replay all history.
  Flow + commit conventions: `CONTRIBUTING.md`. The "Plan" section below is the
  original design; the paths there (`app/`, `apps/desktop/`) predate the `apps/`
  restructure — the shipped config uses `apps/web` / `apps/desktop`.
- **PR / branch hygiene.** Not yet enforced. See "Plan" below.
- **Code signing + notarisation.** Wired (2026-07-04, account exists).
  `release.yml` passes the `APPLE_*` secrets to tauri-action;
  `apps/desktop/Entitlements.plist` carries the hardened-runtime
  exceptions the bun-compiled sidecar needs (JIT, unsigned executable
  memory, library validation off for the dlopen'ed libsql `.node`
  modules). Local signed build + verification:
  `scripts/build-signed.sh` (use `--no-notarize` while iterating).
  Remaining manual steps — see "Signing setup checklist" below.

## Signing setup checklist (manual, one-time)

Portal/keychain work that code cannot do; everything lands in the
Bitwarden item **"Portuni Apple signing"** and in GitHub repo secrets.

1. Create a **Developer ID Application** certificate (Xcode → Settings →
   Accounts → Manage Certificates → +, requires the Account Holder
   role). It ends up in the login Keychain.
2. Export it from Keychain Access as `.p12` (include the private key,
   choose a password), then `base64 -i cert.p12 | pbcopy`.
3. Generate an **app-specific password** at appleid.apple.com and note
   the **Team ID** (developer.apple.com → Membership details).
4. Add the six GitHub repo secrets listed in the header of
   `.github/workflows/release.yml` (`gh secret set NAME`).
5. Verify locally before cutting a tag: export `APPLE_SIGNING_IDENTITY`
   (+ `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`) and run
   `scripts/build-signed.sh`. First run `--no-notarize` to shake out
   entitlement problems cheaply, then the full run, then launch the
   built app from a fresh user session / after
   `xattr -w com.apple.quarantine ...` to confirm Gatekeeper is happy.

6. **Updater signing key** (done 2026-08-28): minisign keypair from
   `cargo tauri signer generate`, private key + password as repo secrets
   `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
   backup in Bitwarden item **"Portuni updater signing"**, public key in
   `apps/desktop/tauri.conf.json` → `plugins.updater.pubkey`. Losing the
   private key means installed apps can never auto-update again (users must
   download a DMG). Rotating it has the same effect.

Done 2026-07-04. Values live in the Bitwarden item; ad-hoc `notarytool`
commands (history, log, submit) can also use the Keychain credential
profile `portuni-notary` (`--keychain-profile portuni-notary`) without
touching Bitwarden. Note the CI DMG carries no stapled ticket of its
own (tauri-action notarizes the .app inside, which is stapled);
`build-signed.sh` additionally notarizes + staples the local DMG.

## Why this exists

> **Historical motivation.** This section describes the pre-release-please
> state (before 2026-07-05) that justified the automation now live — see the
> Status section at the top for what actually shipped. Kept as the "why".

The repo carries the version string in **four manifests**: `package.json`
(server), `apps/web/package.json` (frontend), `apps/desktop/Cargo.toml`,
`apps/desktop/tauri.conf.json`. Before release-please there was no
`CHANGELOG.md`, and releases happened by running `cargo tauri build` on the
maintainer's laptop and copying the `.app` to `/Applications/`. That was
fine for one user; it did not survive a second contributor or a second
machine.

Concrete pain points the automation below addressed:

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

## How releases work

The end-to-end flow (all wired since 2026-07-05):

```
feat/foo branch → PR "feat(scope): summary"
  → CI (server lint/test/build, app typecheck/build, PR title check)
  → squash merge to main → "feat(scope): summary (#NN)"
  → release-please-bot updates open PR "chore: release 0.1.1"
       └─ bumps version in all 4 manifests
       └─ regenerates CHANGELOG.md from feat:/fix: since v0.1.0
  → review + squash merge release PR
  → release-please-bot tags v0.1.1 + creates GitHub Release
  → release.yml fires on the tag → builds the aarch64 DMG + updater artefacts
  → tauri-action attaches the DMG, Portuni.app.tar.gz, .sig and
    latest.json to the Release (still draft)
  → maintainer edits release notes, clicks Publish
  → users go to /releases and download the DMG matching their CPU
```

**Before merging the release PR — review the published docs site.**
release-please only bumps the version and regenerates `CHANGELOG.md`; it does
**not** touch `sites/docs/` (the public Netlify docs). Any behaviour, tool, or
API change in the release must be reflected there, or the shipped docs are
wrong. Quick check:

```
# what changed in this release, vs what the docs describe
git diff v<prev>..HEAD --stat -- apps/server/mcp apps/server/domain apps/server/api
grep -rn "<changed concept>" sites/docs/src   # e.g. staged, .portuni-scope, a renamed tool
npm --prefix sites/docs run build             # must pass before merge
```

Add tool reference pages for new MCP tools (`sites/docs/src/content/docs/reference/`)
and update any concept page whose model changed. Fold the docs-site edits into
the feature branch (a `docs:` commit) so they ship in the same release — not a
follow-up.

For the user the path is: download DMG → drag to /Applications →
right-click → Open (one-time Gatekeeper dance) → onboarding wizard
(URL + token, or "start locally") → done.

## Plan (shipped 2026-07-05)

> The steps below were the build plan and are all done — they now double as a
> reference for how the release-please config is wired. See the Status section
> at the top for the current state.

### Manifest update (release-please config)

`release-please-config.json` + `.release-please-manifest.json` at the
repo root. Drives version bumps in:

- `package.json` (`packageJson` strategy)
- `apps/web/package.json` (`packageJson` strategy)
- `apps/desktop/Cargo.toml` (`extra-files` regex)
- `apps/desktop/tauri.conf.json` (`extra-files` regex)

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
- **Intel build.** Dropped 2026-07-04: GitHub retired `macos-13` in
  2025-12 and the user base has no Intel Macs. If ever needed again,
  `macos-15-intel` is the last x86_64 runner image (until 2027-08).

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
