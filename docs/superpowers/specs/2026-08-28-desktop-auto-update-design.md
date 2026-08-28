# Desktop auto-update

Status: approved in chat (2026-08-28). Implementation is split into GitHub
issues (tracking issue in the repo) worked by the Sandcastle loop; macOS-only
steps are `human-only` issues.

## Behaviour

- The desktop app checks for a newer published release 10 s after
  `backend-ready` and every 6 h afterwards, and on demand from Settings.
- A newer version shows as a footer button `↑ X.Y.Z` (opens Settings → Obecné)
  and in Settings → Obecné → section „Aktualizace“ (current version, available
  version, „Zkontrolovat nyní“, „Stáhnout a nainstalovat“ with progress,
  „Co je nového“ link to the GitHub release page).
- Download + install happens only after the user clicks. Installation
  replaces `Portuni.app` on disk; the running process keeps the old version
  until the user clicks „Restartovat“. The footer keeps saying the restart is
  pending until then; the next launch runs the new version regardless.
- „Restartovat“ runs the same guards as Cmd+Q (dirty editor, unsynced files),
  then kills all sidecars and restarts the app.
- Download or signature failure leaves the old version running and shows the
  error in the section; retry is manual.
- Outside Tauri (Vite in a browser) the section says updates are available only
  in the desktop app; no check runs. Debug builds (`cargo tauri dev`) never
  report an update.

## Release pipeline

- Update signing key: minisign keypair from `cargo tauri signer generate`.
  Private key + password → GitHub secrets `TAURI_SIGNING_PRIVATE_KEY`,
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; backup in Bitwarden item
  „Portuni updater signing“. Public key → `plugins.updater.pubkey` in
  `apps/desktop/tauri.conf.json`. Losing the private key means installed apps
  can never update again (users must download a DMG).
- Endpoint: `https://github.com/honzapav/portuni/releases/latest/download/latest.json`.
  Draft releases are not served, so publishing the draft is the rollout gate.
  Rollback = unpublish or delete the release.
- Updater artefacts (`Portuni.app.tar.gz`, `.sig`, `latest.json`) are built
  only in CI: `apps/desktop/tauri.release.conf.json` sets
  `bundle.createUpdaterArtifacts: true` and `release.yml` passes it via
  `--config tauri.release.conf.json`. The bundle list must be `app,dmg`:
  with `--bundles dmg` alone Tauri warns „no updater-enabled targets were
  built“ and produces no tarball (verified locally, tauri-cli 2.11.4). The
  `.app` then stays next to the DMG; `scripts/verify-app-bundle.sh` keeps
  verifying the DMG. Local `scripts/build-signed.sh` builds stay unchanged and
  need no updater key.
- `release.yml`: the two new secrets in tauri-action env; `includeUpdaterJson:
  true`; the verify step asserts `Portuni.app.tar.gz` + `.sig` + `latest.json`
  exist and that `latest.json` `version` equals the tag without `v`.
- `notes` in `latest.json` are not shown in the UI (generated from the draft
  body before it is edited).
- release-please is unchanged.

## Rust shell (`apps/desktop`)

- `tauri-plugin-updater = "2"` registered in `lib.rs`. No updater permission in
  `capabilities/default.json`: the webview never touches the plugin directly.
- New module `src/updater.rs`, commands:
  - `check_update() -> Option<UpdateInfo { version, current_version, date }>`
    — `Updater::check()`; the found `Update` is kept in managed state so
    install does not re-fetch. Returns `None` in debug builds.
  - `install_update()` — `download_and_install`; emits `update-progress
    { downloaded, total }` while downloading.
  - `restart_app()` — `kill_all_sidecars` then `AppHandle::restart()`
    (`restart()` does not go through `RunEvent::Exit`, so the kill is explicit).
  - `get_app_version() -> String` from `package_info`.
- Apple signing identity is unchanged (Developer ID), so Keychain grants and
  Gatekeeper trust survive an update.

## Web (`apps/web`)

- `src/lib/updater.ts`: invoke wrappers + `useAppUpdate()` hook with state
  `idle | checking | available(info) | downloading(pct) | ready | error(msg)`.
  One instance in `App.tsx`; footer and Settings receive it through props.
- The `app-exit-requested` guard logic in `App.tsx` becomes a reusable
  function used by both the exit path and „Restartovat“.
- `StatusFooter`: update button on the right; `UpdateSection` in
  `SettingsPage` general tab.

## Documentation (same branch)

- `sites/docs/src/content/docs/clients/desktop-app.md`: „Aktualizace“ section.
- `docs/release-process.md`: Status, signing checklist (updater key), remove
  the auto-updater entry from „What we explicitly aren't doing“.
- `.github/workflows/release.yml` header: secrets list.
- `CLAUDE.md` desktop section: updater artefacts are CI-only.

## Verification

Agent (Linux container, CI): `npm run qa`, `apps/web` typecheck + build,
`cargo check` + `cargo test` + `cargo clippy` in `apps/desktop`, `sites/docs`
build.

Human (macOS):
- Generate the real key, set the secrets, store the backup.
- End-to-end on a branch: test config with endpoint
  `http://localhost:4012/latest.json` and
  `dangerousInsecureTransportProtocol: true`; install a signed „old“ build,
  serve a signed „new“ build with a temporarily higher version, verify: footer
  offer → download → guarded restart → new version running, no new Keychain
  prompt, no orphan sidecars.
- First real release with this feature: assets include `.app.tar.gz`, `.sig`,
  `latest.json`. Users on 0.7.0 or older download a DMG one last time.

## Acceptance criteria

```gherkin
Feature: Desktop auto-update

  Scenario: Newer release published
    Given the installed app is 0.8.0 and release 0.8.1 is published
    When the app has been running for 10 seconds after backend-ready
    Then the footer shows "↑ 0.8.1"
    And Settings → Obecné → Aktualizace offers "Stáhnout a nainstalovat"

  Scenario: No newer release
    Given the installed app version equals the latest published release
    When the user clicks "Zkontrolovat nyní"
    Then the section shows the current version as up to date
    And the footer shows no update button

  Scenario: Install then restart with a dirty editor
    Given an update was downloaded and installed
    And the editor has unsaved changes
    When the user clicks "Restartovat"
    Then the same confirmation as Cmd+Q appears
    And on confirmation all sidecars stop and the app restarts on the new version

  Scenario: Download fails
    Given an update is available
    When the download or signature verification fails
    Then the section shows the error
    And the app keeps running the current version

  Scenario: Browser or debug build
    Given the UI runs in Vite in a browser or in a debug Tauri build
    Then no update check runs
    And the section explains updates are desktop-only

  Scenario: Release artefacts
    Given a v* tag is pushed
    When release.yml finishes
    Then the draft release has the DMG, Portuni.app.tar.gz, its .sig and latest.json
    And latest.json version equals the tag
```
