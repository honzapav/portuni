# Sync settings: one-button Google Drive connect + agent-guided SA path

**Date:** 2026-07-05
**Status:** approved design, pre-implementation

## Problem

File sync to Google Drive is configurable only through MCP tools
(`portuni_setup_remote`, `portuni_set_routing_policy`) and requires a Google
service account — a ~15-minute trip through Google Cloud Console that is
hostile to non-technical users. Nothing in the app tells the user that sync
is unconfigured; `portuni_store` just fails with "No remote routing
configured" and the error never surfaces in the UI.

The fix is not a prettier service-account wizard. The service account is the
complexity. For desktop users we replace it with user OAuth (the PKCE
loopback flow already implemented in `apps/desktop/src/auth.rs` for central
login); the service account remains only where it belongs — the headless
central server, set up once by an admin, guided by an agent (section 7).

## 1. Scope and modes

New sub-tab **Synchronizace** in Settings (`SettingsPage.tsx` `SubTab`
union + new `SyncSection.tsx` component).

- **Local workspace** (no `data_mode: "central"`): shows the Drive connect
  flow described below.
- **Central workspace**: shows a single informational line — "Synchronizaci
  souborů spravuje server \<server_url\>" — and nothing else. Drive
  credentials live on the central server; there is nothing to configure on
  the device.
- **Service account**: never gets UI. It stays MCP-only (section 7).

Prerequisite for the connect flow: the active workspace has
`google_client_id` + `google_client_secret` in `config.json` (the same
fields central login uses; a Google Workspace *internal* OAuth client, so
even the full Drive scope needs no Google verification). When absent, the
section shows the prerequisite with a docs link instead of the button.

## 2. Connect flow (OAuth, no secret in the webview)

Button **Propojit Google Drive** invokes a new Tauri command
`google_drive_connect` in `auth.rs`:

1. Reuses the existing PKCE + loopback listener machinery
   (`start_loopback`, browser handoff) with scope
   `openid email https://www.googleapis.com/auth/drive`.
2. Exchanges the code for tokens in Rust.
3. POSTs `{ refresh_token, client_id, client_secret, account_email }`
   directly to the workspace sidecar over loopback
   (`POST /sync/drive/connect`, bearer-authenticated) — the webview never
   sees any token (security rule 1). The command returns only
   `{ account_email, shared_drives: [{id, name}] }` to the webview.

Keychain is not written by Rust here; the sidecar owns sync credentials via
its token store (`getTokenStore()` → keychain backend on desktop), keeping a
single owner for remote auth material.

## 3. Sidecar endpoints

All under the existing HTTP server (`apps/server/http/server.ts`), bearer
auth like every other route. Handlers reuse the service functions that
already back the MCP tools (`setupRemoteService` et al. move from
`apps/server/mcp/tools/sync-remotes.ts` into
`apps/server/domain/sync/remote-service.ts`; the MCP file keeps only the
tool registrations).

- `POST /sync/drive/connect` — body from the Rust command. Writes the token
  store entry for remote name `gdrive`:
  `{ mode: "refresh_token", refresh_token, client_id, client_secret,
  account_email }`. Returns the account email plus the shared drives the
  user can access (one Drive API `drives.list` call).
- `POST /sync/drive/target` — body `{ shared_drive_id }` **or**
  `{ my_drive: true }`. For My Drive, ensures a `Portuni` folder at the
  Drive root and stores its id as `root_folder_id`. Upserts the `gdrive`
  remote (`upsertRemote`), then creates the wildcard routing rule
  `{priority: 1, node_type: null, org_slug: null, remote_name: "gdrive"}`
  — **only if `remote_routing` is empty**; an existing policy is never
  overwritten from the UI.
- `GET /sync/drive/status` — `{ configured, connected, account_email,
  target: {kind: "my_drive"|"shared_drive", name}, prerequisite_missing }`.
  Cheap: reads the remotes table + token presence, no Drive API call.
- `GET /sync/drive/targets` — `drives.list` using the stored token; backs
  the target select when the section is (re)opened in the
  connected-without-target state, so that state survives an app restart.
- `POST /sync/drive/test` — lists the target root via the adapter. Returns
  ok or a typed error: `TOKEN_INVALID`, `DRIVE_UNREACHABLE`,
  `TARGET_NOT_FOUND`.
- `POST /sync/drive/disconnect` — deletes routing rules referencing
  `gdrive` (FK is `ON DELETE RESTRICT`, so rules first), deletes the
  remote, deletes the token-store entry, invalidates the adapter cache.

Fixed single remote name `gdrive` in the UI path. Multi-remote setups stay
MCP-only.

## 4. Drive adapter: refresh-token auth mode

`drive-config.ts` / `drive-adapter.ts` changes:

- `DriveConfig.shared_drive_id` becomes optional. Validation moves to auth
  mode: **service_account requires `shared_drive_id`** (SAs have no My
  Drive quota — unchanged behavior); refresh_token mode accepts either
  `shared_drive_id` or `root_folder_id` (My Drive).
- New `drive-user-auth.ts` beside `drive-sa-auth.ts`: exchanges the stored
  refresh token at `https://oauth2.googleapis.com/token` (endpoint
  allowlisted the same way `assertSafeTokenUri` does for SA), caches the
  access token until expiry.
- `authHeaders()` in the adapter picks the auth module by the token-store
  entry's `mode`.
- Queries without `shared_drive_id` drop `driveId`/`corpora: "drive"` and
  use `corpora: "user"`.

Existing SA-based remotes keep working with zero config changes.

## 5. UI states and hints

`SyncSection.tsx` state machine, driven by `GET /sync/drive/status`:

1. **Prerequisite missing** — explains the Google client requirement, docs
   link.
2. **Not connected** — one button: Propojit Google Drive.
3. **Connected, no target** — select: "Můj disk (složka Portuni)" + shared
   drives from `GET /sync/drive/targets`. One confirm button.
4. **Active** — account email, target name, buttons **Otestovat připojení**
   (shows the typed result inline) and **Odpojit** (confirm dialog).
5. **Token invalid** (test or store returned `TOKEN_INVALID`) — "Propojení
   vypršelo — přihlas se znovu" + the connect button. No silent failure.

Node-detail hint: a new app-level context fetches `GET /sync/drive/status`
once per session; when the workspace is local and `configured === false`,
`DetailPane.files.tsx` shows a banner: "Soubory se ukládají jen lokálně —
propoj Google Drive v Nastavení → Synchronizace" with a link that opens the
settings tab (`?settingsTab=sync`). The banner never blocks any local
functionality.

## 6. Error handling and testing

- Connect-flow errors (user closes browser, Google denies scope) surface in
  the section as plain Czech messages; the Rust command maps them to typed
  strings.
- `POST /sync/drive/connect` validates the payload shape before touching
  the token store; a failed target step leaves the token stored so the user
  resumes at state 3, not from scratch.
- Unit tests: `drive-user-auth` (mocked fetch: exchange, expiry cache,
  invalid_grant → `TOKEN_INVALID`), remote-service functions (routing
  only-if-empty guard, disconnect ordering), config validation matrix
  (SA×My Drive rejected, refresh×both accepted).
- REST tests: auth required on all five endpoints, connect/target happy
  path against an in-memory DB with a stubbed adapter.
- Manual E2E: connect → target → mirror a node → store a file → verify it
  on Drive → disconnect.

## 7. Agent-guided service-account path (central server)

The SA flow keeps no UI but becomes discoverable and guided:

- **Skill** `portuni-remote-setup` in the tempo-skills marketplace repo
  (`plugins/portuni/skills/`, separate deliverable outside this repo):
  walks an admin through GCP Console (project → enable Drive API → create
  SA → download JSON key), sharing the shared drive with the SA email as
  Content manager, then calls `portuni_setup_remote` +
  `portuni_set_routing_policy` and verifies with a test upload.
- **Self-guiding errors**: the "No remote routing configured" failure in
  the store path gains actionable text — desktop users are pointed to
  Nastavení → Synchronizace; agents are pointed to `portuni_list_remotes`
  and the setup tools with a one-line recipe. Same enrichment for
  `remote_scaffold.remote_name === null` results.
- **MCP prompt** `setup-drive-remote` registered in
  `apps/server/mcp/server.ts` — surfaces in Claude Code as
  `/mcp__portuni__setup-drive-remote`, so the setup is explicitly
  discoverable, not only reactive to errors.

## Out of scope

- Service-account UI of any kind.
- Admin UI for configuring Drive on the central server.
- An embedded public OAuth client for distribution outside the
  workflow.ooo Workspace (would require scope/verification rework —
  revisit when Portuni ships publicly).
- Multi-remote management in the UI; routing-policy editing in the UI.
- Migrating existing SA-configured workspaces to OAuth (both modes coexist).
