## Gate

`scripts/agent-gate.sh`: server qa, web typecheck + build, `cargo test` + `cargo clippy -D warnings`, docs site build (the same checks `ci.yml` runs). The first `cargo` run in a fresh worktree takes about 10 minutes; later runs are incremental.

## Sync conflicts

Lockfiles are regenerated, never hand-edited: `npm install --package-lock-only` for `package-lock.json`, `cargo update -p <crate>` for the crates in conflict in `Cargo.lock`.

## Tests

- Server: `test/*.test.ts`, node test runner (`npm run qa`).
- Desktop: Rust unit tests in `apps/desktop`.
- Web: typecheck + build; no browser tests.

## Documentation

`CLAUDE.md`, `docs/`, and the public docs site `sites/docs/` for any behaviour, tool or API change. release-please never touches `sites/docs/`, so a change shipped without a docs edit leaves the published site wrong.

## Repo rules

- Never edit release-please files (`release-please-config.json`, `.release-please-manifest.json`, `CHANGELOG.md`) or the version in `package.json`, `apps/web/package.json`, `apps/desktop/tauri.conf.json`, `apps/desktop/Cargo.toml`.
- No secret in webview code, ever; the webview reaches the Rust host only through Tauri commands.
- UI strings in Czech with diacritics.
- macOS-only verification (signed `.app` builds, updater, Keychain, desktop end-to-end) is not yours: implement what the container can verify, describe the fix and the verification steps in a comment on the issue and leave it open.
- Batch PR title: Conventional Commit covering the batch, e.g. `feat(web): create the local mirror from the node detail`; `pr-title.yml` rejects anything else.
