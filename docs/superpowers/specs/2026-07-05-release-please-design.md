# release-please + contribution docs

**Date:** 2026-07-05
**Status:** approved design, pre-implementation

## Problem

Releases are manual: a maintainer bumps the version in **four** manifests by
hand, tags `v*`, and `release.yml` builds the DMG. Nothing enforces that the
four versions agree, there is no `CHANGELOG.md`, and the process lives only in
a planning doc (`docs/release-process.md`, whose paths predate the `apps/`
restructure). This works solo but is fragile and undocumented for anyone —
human or agent — who wasn't there.

Goal: automate version bumps + changelog + tagging via release-please so that
merging a release PR fires the existing DMG build, and document the
release/contribution process for both humans (`CONTRIBUTING.md`) and agents
(`AGENTS.md`).

## The four version manifests (current paths)

All currently `0.1.0`, must stay in lockstep:

- `package.json` (root / server) — release-please `node` strategy, native.
- `apps/web/package.json` — JSON extra-file, `$.version`.
- `apps/desktop/tauri.conf.json` — JSON extra-file, `$.version`.
- `apps/desktop/Cargo.toml` — `version = "0.1.0" # x-release-please-version`
  annotation (release-please generic updater keys off the comment).

## A. The PAT

release-please creates the tag; a tag pushed by the default `GITHUB_TOKEN`
does **not** trigger other workflows (GitHub's loop-prevention), so
`release.yml` would never fire. Bridge: a **fine-grained PAT** stored as the
GitHub Actions repo secret `RELEASE_PLEASE_TOKEN`.

- Repository access: only the Portuni repo.
- Permissions: **Contents: RW**, **Pull requests: RW**, Metadata: RO (auto).
  Add **Issues: RW** only if PR-label operations error.
- Set an expiry the maintainer will rotate; keep a copy in Bitwarden as the
  durable record (mirrors the existing `APPLE_*` signing-secret pattern).
- GitHub Actions cannot read the macOS Keychain / varlock — those are
  local-only; the operative copy MUST be the GitHub secret.

## B. release-please config (repo root)

- `release-please-config.json`: single component at `.`, `release-type:
  node`, `extra-files` for the three non-root manifests above, changelog at
  root.
- `.release-please-manifest.json`: `{ ".": "0.1.0" }`.
- Bootstrap so the first release PR's changelog starts from *now*, not the
  full history, and no baseline `v0.1.0` DMG build is triggered: set
  `last-release-sha` (in the workflow's action inputs or config) to the repo
  HEAD at wiring time.

## C. release-please workflow

`.github/workflows/release-please.yml`:

- Trigger: `push` to `main`.
- `permissions: { contents: write, pull-requests: write }`.
- `googleapis/release-please-action@v4` with
  `token: ${{ secrets.RELEASE_PLEASE_TOKEN }}`.

Flow: push to main → action opens/updates "chore: release X.Y.Z" PR → merge it
→ action bumps the four manifests, writes CHANGELOG, tags `vX.Y.Z`, creates the
GitHub Release → the PAT-pushed tag fires `release.yml` → signed DMG attaches
→ maintainer edits notes + Publishes.

## D. Minimal PR-title check

`.github/workflows/pr-title.yml`:

- Trigger: `pull_request` (opened / edited / synchronize).
- `amannn/action-semantic-pull-request` validating conventional-commit title.
- Runs only on PRs — does NOT block direct pushes to `main` (the
  maintainer + parallel Claude sessions keep pushing directly). Keeps
  squash-merge commit subjects conventional when PRs are used.

No branch protection, no commitlint hooks (minimal enforcement, per decision).

## E. Docs

- **`CONTRIBUTING.md`** (human-facing): conventional-commit types and what
  each bumps (`feat`→minor, `fix`→patch; on `0.x`, breaking stays minor per
  release-please 0.x rules); the end-to-end release flow; the rule "never
  hand-edit the four version manifests — release-please owns them"; how to run
  the local checks (`npm run qa`).
- **`AGENTS.md`** (the `CLAUDE.md` symlink target): a concise section —
  conventional-commit subjects (already de-facto here), releases are
  automated (don't hand-bump versions or push `v*` tags), and where the
  release PR comes from. Cross-link `CONTRIBUTING.md`.

Update `docs/release-process.md` status: mark release-please as wired and
correct the stale `app/` / `src-tauri/` paths to `apps/web` / `apps/desktop`.

## Out of scope

- Branch protection on `main`.
- commitlint / husky pre-commit hooks.
- A CI "four manifests in sync" guard (release-please owning bumps makes drift
  unlikely; can add later as belt-and-suspenders).

## Validation

release-please cannot be fully exercised until a commit lands on `main` and its
release PR opens. Static validation before then: the config is valid JSON and
matches release-please's schema; the four updater targets resolve (the
`# x-release-please-version` annotation exists on the Cargo.toml version line;
the two JSON `$.version` paths exist). The first live release PR is the proof;
call this out at handoff.
