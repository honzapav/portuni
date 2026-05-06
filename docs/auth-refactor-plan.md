# Desktop auth refactor – plan

Self-contained spec for the upcoming PR. Written so a fresh Claude/Codex
session can execute it without re-doing the research that produced it.

## Status (as of 2026-05-05)

- **Phase A — Keychain for Turso secrets.** Shipped on
  `auth-refactor-phase-a` (commit `bc88ec3`). Plaintext
  `turso_auth_token` field gone from `config.json`; existing installs
  migrate transparently on first launch.
- **Phase B — Tauri-command HTTP proxy.** Shipped on the same branch
  (commit `cb13c04`). Webview JS no longer holds the per-launch
  bearer; `api_request` Tauri command injects it server-side. Bundled
  JS verified free of `Bearer` / `Authorization` / `getAuthToken`.
- **Phase C — First-run UX for Turso token.** Shipped on the same
  branch. New teammate launches the app, sees the
  "Připojení k Turso" modal, pastes the org's shared service token,
  sidecar restarts and the modal goes away. Replaces the dev-tools
  `window.__TAURI__.core.invoke('set_turso_token', ...)` voodoo.

The three "rules of thumb" at the bottom of this doc are now
upstream-able into project-level CLAUDE.md.

## Why this exists

Today the desktop app ships secrets and trust patterns that a session
audit (May 2026) flagged as fragile:

1. **Plaintext Turso JWT in `~/Library/Application Support/ooo.workflow.portuni/config.json`.**
   Anyone with the user account, any backup mechanism, any errant `cat`
   reads it. The token has no `exp` claim — leaked = forever.
2. **Frontend (webview) holds the bearer token.** The Tauri host generates
   a per-launch random token, exposes it via the `get_auth_token` Tauri
   command, and the React app injects it as `Authorization: Bearer ...`
   on every fetch. Webview JS, dev tools, and any extension running in
   that webview can read it. There is no defensible reason for the JS
   side to know it — Tauri host and sidecar are the same trust domain.
3. **Loopback HTTP + bearer is a known-fragile pattern for desktop apps.**
   See CVE-2026-33898 (Incus, March 2026, CVSS 8.8): exact same setup,
   the server's token validation accepted invalid values, full local
   auth bypass. The class of bug is easy to introduce.

Pluggable identity providers (Google first, then whichever IdP a given
org runs — Microsoft, Okta, GitHub, SAML, …) is the long-term direction
for multi-user Portuni. This refactor is the cleanup that has to happen
first, regardless of which adapter ships next.

## End state we want

```
┌─────────────────────────────────────────────────────────────┐
│ Portuni.app (Tauri host – Rust)                             │
│                                                             │
│  ┌─ Webview (React) ────────┐    ┌─ Rust core ───────────┐  │
│  │                          │    │                       │  │
│  │  apiFetch(path, ...)     │    │ #[tauri::command]     │  │
│  │     │                    │    │ api_request {         │  │
│  │     │  invoke()          │───▶│   inject Bearer       │  │
│  │     ▼                    │    │   from AuthToken      │  │
│  │  (no token in JS)        │    │   state               │  │
│  │                          │    │   POST/GET to         │  │
│  └──────────────────────────┘    │   sidecar             │  │
│                                  │ }                     │  │
│                                  │                       │  │
│                                  │ Turso secrets:        │  │
│                                  │   keyring crate       │  │
│                                  │   (macOS Keychain)    │  │
│                                  └───────┬───────────────┘  │
│                                          │                  │
│                            ┌─────────────┴───────────┐      │
│                            │ Spawn sidecar with      │      │
│                            │ TURSO_AUTH_TOKEN env    │      │
│                            └─────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

Invariants:

- **No secret in webview JS, ever.** `get_auth_token` Tauri command goes
  away. There is no `Authorization` header constructed in JS.
- **No secret in plaintext on disk.** `turso_auth_token` leaves
  `config.json`, lives only in OS keychain (`keyring` crate, macOS
  Keychain Services backend).
- **`config.json` keeps non-secret prefs only:** `turso_url`,
  `portuni_workspace_root`. Future fields go here only if they're
  non-secret.
- **Loopback HTTP between Rust core and sidecar stays.** It's already
  intra-process-trust-domain (Tauri host spawned the sidecar with a
  random per-launch token). The token's job is "defend against other
  local processes that hit our random port" — that role survives.

## Phased implementation

Three phases, each landable as its own commit inside one PR. Order
matters — Phase B depends on A's keyring work for the case where the
user wants Turso (otherwise the sidecar boots in local libSQL mode and
no Keychain entry exists yet).

### Phase A: Keychain for Turso secrets

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`,
`src-tauri/README.md` (config docs).

**Steps:**

1. Add `keyring = "3"` to `src-tauri/Cargo.toml`.
2. In `lib.rs`, add helpers:
   ```rust
   const KEYCHAIN_SERVICE: &str = "ooo.workflow.portuni";
   const KEYCHAIN_TURSO_ACCOUNT: &str = "turso_auth_token";

   fn keychain_get_turso_token() -> Option<String> {
       keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_TURSO_ACCOUNT)
           .ok()
           .and_then(|e| e.get_password().ok())
   }

   #[tauri::command]
   fn set_turso_token(token: String) -> Result<(), String> {
       keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_TURSO_ACCOUNT)
           .map_err(|e| e.to_string())?
           .set_password(&token)
           .map_err(|e| e.to_string())
   }

   #[tauri::command]
   fn clear_turso_token() -> Result<(), String> {
       keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_TURSO_ACCOUNT)
           .map_err(|e| e.to_string())?
           .delete_password()
           .map_err(|e| e.to_string())
   }
   ```
3. In `spawn_sidecar`, replace
   `let turso_token = config.turso_auth_token.unwrap_or_default();`
   with `let turso_token = keychain_get_turso_token().unwrap_or_default();`.
4. Remove the `turso_auth_token` field from `DesktopConfig` struct.
   `serde(default)` means existing config.json files with the field
   are silently tolerated, but no code reads it.
5. Register the new commands in `invoke_handler`:
   ```rust
   .invoke_handler(tauri::generate_handler![
       get_backend_port, set_turso_token, clear_turso_token
   ])
   ```
   (Note: `get_auth_token` is removed in Phase B; until then keep it
   for compatibility while phase A lands.)
6. Add capability for `set_turso_token` / `clear_turso_token` in
   `src-tauri/capabilities/default.json`.
7. **Migration:** on first run after upgrade, if `config.json` still
   has `turso_auth_token` and Keychain is empty, copy it into Keychain
   then rewrite config.json without that field. One-shot, in
   `load_config`. Log a single info line "migrated turso_auth_token
   from config.json to Keychain".
8. Update `src-tauri/README.md` Config section: drop
   `turso_auth_token` from the documented JSON shape, add a section
   "Setting the Turso token" pointing at the future first-run UI (or,
   for now, a one-liner: open dev tools, run
   `await window.__TAURI__.core.invoke('set_turso_token', {token: '...'})`).

**Test plan for Phase A:**
- Cargo check + cargo build succeed.
- Manual: with Turso URL configured, set token via the new command,
  restart app, sidecar boots with the token.
- Manual: clear Keychain entry, restart app — sidecar gets empty
  token; if `turso_url` is remote, sidecar refuses to boot with the
  expected auth-required error (good — surfaces the missing token
  via the existing PORTUNI_BACKEND_ERROR marker channel).

### Phase B: Tauri-command HTTP proxy

**Files:** `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml` (maybe `reqwest`),
`src-tauri/capabilities/default.json`, `app/src/lib/backend-url.ts`,
`app/src/api.ts` (or wherever fetches happen).

**Steps:**

1. Add `reqwest = { version = "0.12", features = ["json"] }` to
   `src-tauri/Cargo.toml` if not already present (Tauri uses it
   transitively but we want our own client config).
2. Add a Rust-side HTTP client kept in app state, configured to talk
   to `127.0.0.1:<backend_port>` and inject the bearer header from
   `AuthToken` state automatically. Sketch:
   ```rust
   #[tauri::command]
   async fn api_request(
       state_port: tauri::State<'_, BackendPort>,
       state_token: tauri::State<'_, AuthToken>,
       method: String,
       path: String,
       body: Option<serde_json::Value>,
   ) -> Result<ApiResponse, String> {
       let port = state_port.0.lock().unwrap()
           .ok_or("backend not ready")?;
       let url = format!("http://127.0.0.1:{port}{path}");
       let client = reqwest::Client::new();
       let mut req = client.request(parse_method(&method)?, &url)
           .header("Authorization", format!("Bearer {}", state_token.0))
           .header("Origin", "tauri://localhost");
       if let Some(b) = body {
           req = req.json(&b);
       }
       let res = req.send().await.map_err(|e| e.to_string())?;
       Ok(ApiResponse {
           status: res.status().as_u16(),
           body: res.text().await.map_err(|e| e.to_string())?,
       })
   }
   ```
3. Capability allowlist: add `api_request` to
   `src-tauri/capabilities/default.json`.
4. Frontend rewrite: `app/src/lib/backend-url.ts` and `app/src/api.ts`
   stop calling `fetch()` directly. New `apiFetch(path, init?)` that
   internally calls `invoke('api_request', { method, path, body })`
   and hands back something fetch-shaped (`{ status, json(), text() }`)
   so call sites don't change much.
5. Remove `get_auth_token` Tauri command from Rust + remove all its
   call sites in JS. `apiFetch` no longer needs to know the token
   exists.

**Test plan for Phase B:**
- App boots, graph loads (covers GET).
- Click node detail (covers GET with path param).
- Edit responsibility (covers PATCH with body).
- Search dev tools network panel: there should be **no
  `Authorization` header in any request originating from the
  webview**. The Tauri commands appear instead.
- Sidecar logs still show `Authorization: Bearer ...` reaching it
  (the Rust proxy injected the header).

### Phase C: First-run UX for Turso token

**Files:** `app/src/...` (a small modal/route), `src-tauri/src/lib.rs`
(maybe a `is_turso_configured` query command).

**Steps:**

1. Add Tauri command `get_turso_status() -> { url_set: bool, token_set: bool }`
   so the frontend can detect the misconfigured-on-first-run state
   without sniffing for backend errors.
2. Frontend: on app start, if `url_set && !token_set` and the URL is
   remote (`libsql://`), show a modal asking the user to paste their
   Turso auth token. Submitting calls `set_turso_token` then
   reloads the backend (call `restart_sidecar` Tauri command — to be
   added — or just nudge the user to relaunch the app).

This phase is optional from a security POV — Phase A + B fix the
substantive issues. Its real role is the **Phase 1.5 onboarding step**
described in `vision/portuni-as-workspace.md` (line ~200, "Otevřená
otázka: …multi-user / per-user auth"): a new teammate joining an
existing Portuni org pastes the org's shared Turso token once
instead of fishing in dev tools. The token is a service credential
distributed by the org admin out-of-band; per-user identity +
permissions live in the Phase 2 design (`specs.md` → "Security
model"), not here.

## Out of scope

- **Pluggable identity adapters.** Separate later PR. The shape this
  refactor leaves behind makes adding any IdP (Google first, then
  whatever a given org runs) a strictly additive change: another
  Tauri command per adapter, another keychain entry, sidecar gets
  the IdP-issued ID token instead of the random per-launch token.
  Don't try to bundle.
- **Refresh tokens for Turso.** Turso JWTs we use today don't expire,
  so no rotation logic needed for now. If we later move to short-lived
  Turso tokens, refresh logic lives in the same `keyring`-backed
  abstraction.
- **Cross-platform.** macOS first; `keyring` crate handles Linux
  (Secret Service / kwallet) and Windows (Credential Manager) with
  zero code change, but we won't smoke-test those in this PR.

## Background research (for context)

If a future Claude session re-derives this from scratch they'll waste
20 min repeating it. Pinning the citations here:

- **Tauri's own docs explicitly recommend Tauri commands over local
  HTTP for webview ↔ backend communication.** Capabilities allowlist
  is the trust boundary, not a hand-rolled bearer header.
  ([Capabilities | Tauri](https://v2.tauri.app/security/capabilities/),
  [Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/))

- **Tauri Stronghold plugin is being deprecated in v3 — do not use it
  for new code.** Use `keyring` crate (or `tauri-plugin-keyring`).
  ([Stronghold | Tauri](https://v2.tauri.app/plugin/stronghold/),
  [tauri-plugin-keyring](https://github.com/HuakunShen/tauri-plugin-keyring))

- **Electron's analogue is `safeStorage` API or `node-keytar` —
  both wrap OS keychain.** Same conceptual model as `keyring` crate.
  ([safeStorage | Electron](https://www.electronjs.org/docs/latest/api/safe-storage),
  [How to securely store sensitive information in Electron with node-keytar | Cameron Nokes](https://cameronnokes.com/blog/how-to-securely-store-sensitive-information-in-electron-with-node-keytar/))

- **CVE-2026-33898 (Incus, March 2026)** is the cautionary tale:
  loopback web server + bearer-token-in-URL pattern, validation bug,
  full local auth bypass. The fix Portuni adopts (token never reaches
  client) eliminates the entire class of vulnerability.
  ([Incus webui Local Authentication Bypass](https://www.thehackerwire.com/incus-webui-local-authentication-bypass-cve-2026-33898/))

- **Docker Desktop precedent for "no token, just FS permissions" via
  Unix domain socket** is cleanest in theory but doesn't help here
  because webview can't speak UDS. Tauri-command proxy is the
  webview-compatible equivalent of "secret stays out of caller-land".
  ([dockerd | Docker Docs](https://docs.docker.com/reference/cli/dockerd/))

- **Tauri's general security stance:** "you cannot hide secrets from
  a malicious actor and should assume all outward communication is
  entirely public" — i.e. PKCE-flow OAuth, never client secrets.
  Aligns with the pluggable-IdP direction.
  ([Security | Tauri](https://v2.tauri.app/security/))

## Three rules of thumb (post-mortem of recurring bugs)

To not repeat this:

1. **No secret in webview JS, ever.** If a JS module needs to know it,
   it can be exfiltrated trivially.
2. **No secret in plaintext on disk.** OS keychain or encrypted vault
   with OS-derived key.
3. **Webview ↔ backend through Tauri commands, not HTTP.** Tauri's
   capabilities allowlist already enforces the trust boundary; HTTP
   plus a hand-rolled bearer duplicates that worse.

These should be in CLAUDE.md as project-level rules (next pass).
