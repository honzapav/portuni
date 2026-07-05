# Contributing to Portuni

Thanks for your interest in contributing!

## Before you start

Read the [documentation](https://docs.portuni.com) first. Portuni is built on specific concepts (POPP framework, intentional knowledge capture, graph-not-tree) and understanding them will help your contribution fit naturally.

## How to contribute

1. Fork the repo and create a branch
2. Make your changes
3. Run `npm run qa` to verify (lint + typecheck + tests + build)
4. Open a pull request with a Conventional Commit title (see below)

## Commit messages: Conventional Commits

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/).
This is not cosmetic — release-please reads the history to decide the next
version and to generate `CHANGELOG.md`, so the prefix determines what ships.

```
<type>(<optional scope>): <summary>
```

| Type | Example | Version effect |
|------|---------|----------------|
| `feat` | `feat(sync): one-click Drive connect` | minor bump, shows in changelog |
| `fix` | `fix(api): 409 on unconnected target` | patch bump, shows in changelog |
| `docs`, `chore`, `refactor`, `test`, `build`, `ci`, `style` | `chore(ci): bump action pin` | no bump |

While the project is on `0.x`, a breaking change (`feat!:` or a
`BREAKING CHANGE:` footer) bumps the **minor**, not the major — this is
release-please's 0.x behaviour, intentional until we cut `1.0.0`.

Keep scopes consistent with what's already in `git log` (`sync`, `mcp`,
`desktop`, `web`, `auth`, `docs`, `ci`, …).

If you open a PR, its **title** must be a valid Conventional Commit — the
`PR title` check enforces it, and a squash-merge uses the title as the
commit subject. There is no branch protection; direct commits to `main`
are allowed and the check does not gate them.

## Versioning and releases

**Never hand-edit the version.** It lives in four manifests that must stay in
lockstep — `package.json`, `apps/web/package.json`,
`apps/desktop/tauri.conf.json`, and `apps/desktop/Cargo.toml` — and
release-please owns all four. Bumping one by hand ships a mismatched bundle.

The release flow is automated:

1. Land conventional commits on `main` (directly or via merged PRs).
2. **release-please** opens/maintains a `chore: release X.Y.Z` PR that bumps
   the four manifests and updates `CHANGELOG.md`. Review it like any PR.
3. **Merge the release PR.** release-please tags `vX.Y.Z` and creates a draft
   GitHub Release.
4. The tag triggers `release.yml`, which builds the signed, notarized macOS
   DMG and attaches it to that release.
5. A maintainer edits the release notes and clicks **Publish**.

The tag is pushed by a fine-grained PAT (`RELEASE_PLEASE_TOKEN`), not the
default `GITHUB_TOKEN` — otherwise it would not trigger the DMG build. See
`docs/release-process.md` for signing/notarization and the one-time secret
setup.

## Reporting bugs

Open an issue with steps to reproduce, expected behavior, and actual behavior.

## License

By contributing, your changes are licensed under the same [Apache 2.0 license](LICENSE) that covers the project.
