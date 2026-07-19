# Onboarding: Central-Mode Team Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh install of Portuni.app lets a teammate join the organization by entering only the server URL (Google login follows), replacing the Turso-credentials form nobody can fill in — and after first login guides them to open a terminal so the first mirror materializes.

**Architecture:** A new public server endpoint `GET /auth/desktop-config` serves the Google OAuth client id + secret (for a Google *desktop* OAuth client the secret is not confidential — every installed app ships it). A new Tauri command `setup_central(server_url)` fetches that endpoint and writes `config.json` (`server_url`, `google_client_id`, `google_client_secret`, `data_mode: "central"`). The fresh-install wizard (`TursoSetupGate`) swaps its Turso form for a one-field "Připojit se k týmu" card; after reload the existing `CentralLoginGate` takes over with Google login, then shows a one-time "first steps" screen pointing at the terminal → mirror flow.

**Tech Stack:** Node HTTP server (no framework) + node:test, Tauri 2 (Rust, reqwest, serde), React + Vite, Astro/Starlight docs site.

**Asana:** closes [onboarding teammates (central mode)](https://app.asana.com/1/14933110711900/project/1213984083659233/task/1215586868152190) and [navedení ke spuštění terminálu → portuni_mirror](https://app.asana.com/1/14933110711900/project/1213984083659233/task/1216448111633878).

## Global Constraints

- Conventional Commits are load-bearing (release-please). Scopes from git log: `auth`, `desktop`, `web`, `docs`.
- Never hand-bump versions; never touch the four version manifests.
- Public docs site (`sites/docs/`) must be updated in the SAME branch as the behaviour change.
- No secret in webview JS; webview ↔ backend only through Tauri commands (security rules). The OAuth client secret of a Google desktop client is by Google's definition non-confidential — it may pass through the wizard's Rust command and land in `config.json`, exactly as it does today for hand-edited configs. It must NOT be rendered in the webview. The desktop-config fetch must go over `https://` — plain `http://` only for loopback dev hosts (`normalize_server_url` enforces this).
- UI copy is Czech with diacritics; em dash "—" never "--"; Czech spaced en dash "–" in Czech copy. No emoji in code.
- Rust error strings stay English (matches existing codebase style, e.g. "cwd is required").
- All work on branch `feat/onboarding-central` cut from `main`.

## Pre-existing context an implementer needs

- Fresh install flow today: no `config.json` → `get_turso_status` returns `config_exists: false` → `TursoSetupGate` renders the wizard (`apps/web/src/components/TursoSetupGate.tsx`). Gate order in `apps/web/src/main.tsx`: `WorkspaceMigrationGate > TursoSetupGate > CentralLoginGate`.
- `save_config` (`apps/desktop/src/lib.rs:690`) shows the exact fresh-install dance: `workspace::load`, `Missing → migrate_v1_value(&json!({}), "default")`, mutate active workspace, `workspace::save`, `spawn_all_sidecars(&app)` when fresh. `setup_central` reuses that dance.
- `WorkspaceConfig` (`apps/desktop/src/workspace.rs:20`) already has `server_url`, `google_client_id`, `google_client_secret`, `data_mode` fields — nothing to add to the model.
- `CentralLoginGate` (`apps/web/src/components/CentralLoginGate.tsx`) already handles central + logged-out → Google login via `googleLogin()` from `../lib/central`. It reloads on success.
- Server router: `apps/server/api/router.ts:134` mounts `/auth/login` first ("login is public in google mode"); the min-scope gate above it passes GET routes for the placeholder identity (read). Bearer-token allowlist: `AUTH_PUBLIC_PATHS` in `apps/server/http/middleware.ts:131`.
- Server tests live in `test/*.test.ts`, run by `npm test` (`node --import tsx --test`). Model: `test/rest-auth.test.ts` (in-process server on a fixed port, real `fetch`). Ports in use: grep `test/*.test.ts` for `process.env.PORT` before picking one.
- The terminal button that creates a mirror is labeled **"Otevřít terminál v Portuni"** (`apps/web/src/components/DetailPane.files.tsx:1067`); its tooltip says the working folder is created if missing. That is the flow the first-steps screen points to.

---

### Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
cd /Users/honzapav/Dev/side-projects/portuni
git checkout main && git pull && git checkout -b feat/onboarding-central
```

---

### Task 1: Server — public `GET /auth/desktop-config`

**Files:**
- Modify: `apps/server/api/auth.ts` (add handler at end of file)
- Modify: `apps/server/api/router.ts:134` (mount before `/auth/login`)
- Modify: `apps/server/http/middleware.ts:131` (`AUTH_PUBLIC_PATHS`)
- Modify: `docs/env-vars.md` (two new rows in the google-mode table near `PORTUNI_GOOGLE_CLIENT_IDS`)
- Test: `test/rest-desktop-config.test.ts` (create)

**Interfaces:**
- Produces: `GET /auth/desktop-config` → `200 {"google_client_id": string, "google_client_secret": string}` when both `PORTUNI_DESKTOP_GOOGLE_CLIENT_ID` and `PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET` env vars are non-empty; otherwise `404 {"error": "desktop config not available"}`. No auth required. Env is read per-request (lazily), not cached — Task 2's Rust client and the test below both rely on this contract.

- [ ] **Step 1: Write the failing test**

Pick a port: `grep -h "process.env.PORT" test/*.test.ts | sort` and use one not listed (assume `14927`; adjust if taken). Create `test/rest-desktop-config.test.ts`:

```ts
// GET /auth/desktop-config: public endpoint serving the desktop OAuth client
// (id + secret) so the onboarding wizard can join a central server from just
// its URL. Env-gated, mode-independent, read per request.

process.env.PORT = "14927";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";
delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID;
delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET;

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";

const base = "http://127.0.0.1:14927";

let handle: HttpServerHandle;
let db: Client;

before(async () => {
  resetGateCachesForTesting();
  db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);
  handle = startHttpServer({ port: 14927, host: "127.0.0.1", registerSigint: false });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
});

describe("GET /auth/desktop-config", () => {
  it("404s when the desktop client env vars are not set", async () => {
    delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID;
    delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET;
    const res = await fetch(`${base}/auth/desktop-config`);
    assert.equal(res.status, 404);
  });

  it("returns the client id and secret when configured", async () => {
    process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
    process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET = "GOCSPX-test-secret";
    try {
      const res = await fetch(`${base}/auth/desktop-config`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.google_client_id, "123-abc.apps.googleusercontent.com");
      assert.equal(body.google_client_secret, "GOCSPX-test-secret");
    } finally {
      delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID;
      delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET;
    }
  });

  it("404s again when one of the two vars is missing", async () => {
    process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID = "123-abc.apps.googleusercontent.com";
    try {
      const res = await fetch(`${base}/auth/desktop-config`);
      assert.equal(res.status, 404);
    } finally {
      delete process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID;
    }
  });
});
```

Note: if `rest-auth.test.ts`'s `before` needs `PORTUNI_WORKSPACE_ROOT`/`resetLocalDbForTests` for the server to boot, copy those lines too — mirror whatever `test/rest-auth.test.ts` does to boot; the describe blocks above are the contract.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build && node --import tsx --test test/rest-desktop-config.test.ts
```
Expected: FAIL — the two positive assertions get 404/route-not-found.

- [ ] **Step 3: Implement the handler**

In `apps/server/api/auth.ts`, append:

```ts
// Public desktop OAuth client config. The onboarding wizard fetches this
// from just a server URL so a teammate never types client id/secret by
// hand. A Google *desktop app* OAuth client's secret is non-confidential
// by Google's own definition (it ships inside every installed app), so
// serving it unauthenticated is deliberate. Env is read per request so
// tests (and ops) can flip it without a restart.
export function handleDesktopConfig(res: ServerResponse): void {
  const id = (process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID ?? "").trim();
  const secret = (process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!id || !secret) {
    respondJson(res, 404, { error: "desktop config not available" });
    return;
  }
  respondJson(res, 200, { google_client_id: id, google_client_secret: secret });
}
```

In `apps/server/api/router.ts`, import `handleDesktopConfig` alongside `handleLogin` and mount it immediately BEFORE the `/auth/login` block (line ~134):

```ts
  if (url.pathname === "/auth/desktop-config" && req.method === "GET") {
    handleDesktopConfig(res);
    return true;
  }
```

In `apps/server/http/middleware.ts` (line ~131), extend the bearer-gate allowlist and its comment:

```ts
// ... /auth/desktop-config serves only the Google desktop OAuth client
// (non-confidential by design) so the onboarding wizard works before any
// token exists.
const AUTH_PUBLIC_PATHS = new Set(["/health", "/mcp/info", "/auth/desktop-config"]);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run build && node --import tsx --test test/rest-desktop-config.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Document the env vars**

In `docs/env-vars.md`, add to the google/auth table next to `PORTUNI_GOOGLE_CLIENT_IDS`:

```markdown
| `PORTUNI_DESKTOP_GOOGLE_CLIENT_ID` | — | No | Google desktop OAuth client id served by public `GET /auth/desktop-config` (onboarding wizard). Must also be listed in `PORTUNI_GOOGLE_CLIENT_IDS` |
| `PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET` | — | No | Secret of that desktop OAuth client — non-confidential per Google's installed-app model; served alongside the id |
```

(Match the table's actual column layout — open the file and copy an existing row's shape.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/api/auth.ts apps/server/api/router.ts apps/server/http/middleware.ts docs/env-vars.md test/rest-desktop-config.test.ts
git commit -m "feat(auth): public /auth/desktop-config endpoint serving the desktop OAuth client"
```

---

### Task 2: Desktop — `setup_central` Tauri command

**Files:**
- Modify: `apps/desktop/src/workspace.rs` (add pure `normalize_server_url` + tests)
- Modify: `apps/desktop/src/lib.rs` (add `setup_central` next to `save_config` at ~line 690; register in `generate_handler!` at line ~1849)

**Interfaces:**
- Consumes: `GET {server}/auth/desktop-config` from Task 1.
- Produces: Tauri command `setup_central(server_url: String) -> Result<(), String>` — invoked from the webview as `invoke("setup_central", { serverUrl })`. On success `config.json` holds a v2 config whose active workspace has `server_url`, `google_client_id`, `google_client_secret`, `data_mode: "central"`, `turso_url: None`, and sidecars are spawned on fresh install. Also `workspace::normalize_server_url(&str) -> Result<String, String>`.

- [ ] **Step 1: Write the failing Rust unit tests**

In `apps/desktop/src/workspace.rs`, inside the existing `#[cfg(test)] mod` (find it at the bottom of the file), add:

```rust
#[test]
fn normalize_server_url_adds_https_and_strips_slash() {
    assert_eq!(
        normalize_server_url("api.portuni.com").unwrap(),
        "https://api.portuni.com"
    );
    assert_eq!(
        normalize_server_url("https://api.portuni.com/").unwrap(),
        "https://api.portuni.com"
    );
    assert_eq!(
        normalize_server_url(" http://localhost:4011 ").unwrap(),
        "http://localhost:4011"
    );
    assert_eq!(
        normalize_server_url("http://127.0.0.1:4011").unwrap(),
        "http://127.0.0.1:4011"
    );
}

#[test]
fn normalize_server_url_rejects_empty_and_garbage() {
    assert!(normalize_server_url("").is_err());
    assert!(normalize_server_url("   ").is_err());
    assert!(normalize_server_url("ftp://x").is_err());
}

#[test]
fn normalize_server_url_rejects_non_loopback_http() {
    // Plain http on a real host would let a MITM swap the OAuth client in
    // the desktop-config response — https only, loopback excepted for dev.
    assert!(normalize_server_url("http://api.example.com").is_err());
    assert!(normalize_server_url("http://192.168.1.10:4011").is_err());
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/desktop && cargo test normalize_server_url
```
Expected: compile error — `normalize_server_url` not defined.

- [ ] **Step 3: Implement `normalize_server_url`**

In `apps/desktop/src/workspace.rs` (near the other pure helpers):

```rust
/// Normalize the server URL a user types into the onboarding wizard:
/// trim, default to https:// when no scheme, strip the trailing slash.
/// Plain http:// is allowed only for loopback (local dev) — on a real
/// host a MITM could tamper with the desktop-config response and swap
/// the OAuth client. Rejects non-http(s) schemes rather than guessing.
pub(crate) fn normalize_server_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("server URL is required".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or("");
        if host == "localhost" || host == "127.0.0.1" {
            return Ok(trimmed.to_string());
        }
        return Err("http:// is allowed only for localhost — use https://".to_string());
    }
    if trimmed.starts_with("https://") {
        return Ok(trimmed.to_string());
    }
    if trimmed.contains("://") {
        return Err(format!("unsupported URL scheme: {trimmed}"));
    }
    Ok(format!("https://{trimmed}"))
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/desktop && cargo test normalize_server_url
```
Expected: 2 tests PASS.

- [ ] **Step 5: Implement the command**

In `apps/desktop/src/lib.rs`, directly below `save_config` (after line ~729):

```rust
// Onboarding wizard "join a team" path: from just a server URL, fetch the
// public desktop OAuth client (/auth/desktop-config) and commit a central-
// mode config. Mirrors save_config's fresh-install dance: create the v2
// `default` workspace when config.json is missing and spawn sidecars so
// the wizard's reload finds a running backend. After the reload,
// CentralLoginGate sees data_mode=central + configured and runs the
// Google login.
#[derive(serde::Deserialize)]
struct DesktopClientConfig {
    google_client_id: String,
    google_client_secret: String,
}

#[tauri::command]
async fn setup_central(app: AppHandle, server_url: String) -> Result<(), String> {
    let server = workspace::normalize_server_url(&server_url)?;
    let resp = reqwest::Client::new()
        .get(format!("{server}/auth/desktop-config"))
        .send()
        .await
        .map_err(|e| format!("server unreachable: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Err(format!(
            "{server} does not serve a desktop client config — ask your admin to set PORTUNI_DESKTOP_GOOGLE_CLIENT_ID/SECRET"
        ));
    }
    if !resp.status().is_success() {
        return Err(format!(
            "desktop-config request failed: HTTP {}",
            resp.status().as_u16()
        ));
    }
    let client: DesktopClientConfig = resp
        .json()
        .await
        .map_err(|e| format!("invalid desktop-config response: {e}"))?;
    if client.google_client_id.trim().is_empty() || client.google_client_secret.trim().is_empty() {
        return Err("desktop-config response is missing the client id or secret".to_string());
    }

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let loaded = workspace::load(&data_dir)?;
    let fresh_install = matches!(loaded, workspace::LoadedConfig::Missing);
    let mut file = match loaded {
        workspace::LoadedConfig::V2(f) => f,
        workspace::LoadedConfig::Missing => {
            workspace::migrate_v1_value(&serde_json::json!({}), "default")
        }
        workspace::LoadedConfig::V1(_) => {
            return Err("config awaiting workspace migration".to_string())
        }
    };
    let active = file.active_workspace.clone();
    let cfg = file
        .workspaces
        .get_mut(&active)
        .ok_or_else(|| "active workspace missing from config".to_string())?;
    cfg.server_url = Some(server);
    cfg.google_client_id = Some(client.google_client_id.trim().to_string());
    cfg.google_client_secret = Some(client.google_client_secret.trim().to_string());
    cfg.data_mode = Some("central".to_string());
    cfg.turso_url = None;
    workspace::save(&data_dir, &file)?;
    if fresh_install {
        spawn_all_sidecars(&app);
    }
    Ok(())
}
```

Register it in the `generate_handler!` list (line ~1849), next to `save_config`:

```rust
            save_config,
            setup_central,
```

- [ ] **Step 6: Compile + full crate tests**

```bash
cd apps/desktop && cargo check && cargo test
```
Expected: clean check, all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/workspace.rs apps/desktop/src/lib.rs
git commit -m "feat(desktop): setup_central command — join a central server from just its URL"
```

---

### Task 3: Web — wizard joins a team instead of asking for Turso credentials

**Files:**
- Modify: `apps/web/src/components/TursoSetupGate.tsx`

**Interfaces:**
- Consumes: `invoke("setup_central", { serverUrl: string })` from Task 2.
- Produces: fresh-install wizard with exactly two cards: "Připojit se k týmu" (one URL field) and "Začít lokálně". The Turso URL+token form is removed from the wizard. The `needs-token` modal (case 2: existing config with `libsql://` URL but missing Keychain token) is untouched.

- [ ] **Step 1: Rewrite the fresh-install branch**

In `TursoSetupGate.tsx`:

1. Update the header comment's case 1 description: the wizard's two paths are now "join the org's central server (enter its URL; Google login follows after reload)" and "start locally". Note that the Turso path is config.json-only now (owner setup).
2. Delete `handleConnectOrg` entirely. Keep `handleSaveToken` and `handleStartLocal` (unchanged) and the `token` state (used by the needs-token modal).
3. Add:

```tsx
  async function handleJoinTeam() {
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setError("Adresa serveru nesmí být prázdná.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("setup_central", { serverUrl: trimmed });
      // Reload: CentralLoginGate now sees data_mode=central + configured
      // and takes over with the Google login screen.
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }
```

4. Replace the first card ("Připojit se k existující organizaci" with the libsql input + token textarea) with:

```tsx
            <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="text-[13px] font-medium text-[var(--color-text)]">
                Připojit se k týmu
              </div>
              <div className="mt-1 text-[12px] text-[var(--color-text-dim)]">
                Tvoje organizace už provozuje Portuni server. Zadej jeho adresu
                – přihlásíš se pak svým Google účtem.
              </div>
              <div className="mt-3 flex flex-col gap-2">
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="api.tvoje-firma.com"
                  spellCheck={false}
                  autoFocus
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-text-dim)]"
                />
                <button
                  disabled={saving}
                  onClick={() => void handleJoinTeam()}
                  className="self-end rounded bg-[var(--color-text)] px-4 py-1.5 text-[13px] font-medium text-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? "Připojuji…" : "Připojit"}
                </button>
              </div>
            </div>
```

The "Začít lokálně" card and the error line stay as they are.

- [ ] **Step 2: Type-check and build**

```bash
npm --prefix apps/web run build
```
Expected: clean tsc + vite build. If `token`/`setToken` or other leftovers become unused-var errors, remove exactly the now-dead ones (the needs-token modal still uses `token`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/TursoSetupGate.tsx
git commit -m "feat(web): onboarding wizard joins a team via server URL instead of Turso credentials"
```

---

### Task 4: Web — post-login first-steps screen (terminal → mirror guidance)

**Files:**
- Modify: `apps/web/src/components/CentralLoginGate.tsx`

**Interfaces:**
- Consumes: existing `getDataMode`, `authStatus`, `googleLogin` from `../lib/central`.
- Produces: one-time screen after the first successful Google login in central mode, guiding the user to open a node and click "Otevřít terminál v Portuni" so the mirror materializes. Keyed by `localStorage` flag `portuni.first-steps-pending` — set just before the post-login reload, cleared on dismissal.

- [ ] **Step 1: Implement the first-steps state**

In `CentralLoginGate.tsx`:

1. Extend the status union:

```tsx
type GateStatus =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "not-configured" }
  | { kind: "login" }
  | { kind: "first-steps" };
```

2. In `check()`, in the `s.logged_in` branch:

```tsx
      } else if (s.logged_in) {
        // First login on this install: show the one-time guidance that
        // mirror folders appear only after a terminal is opened on a node.
        if (localStorage.getItem("portuni.first-steps-pending") === "1") {
          setStatus({ kind: "first-steps" });
        } else {
          setStatus({ kind: "ready" });
        }
      } else {
```

3. In `handleLogin`, after `await googleLogin();` and before `window.location.reload();`:

```tsx
      localStorage.setItem("portuni.first-steps-pending", "1");
```

4. Add the dismissal handler:

```tsx
  function handleFirstStepsDone() {
    localStorage.removeItem("portuni.first-steps-pending");
    setStatus({ kind: "ready" });
  }
```

5. Render the screen — insert BEFORE the existing `return` (which handles not-configured/login), as its own early return:

```tsx
  if (status.kind === "first-steps") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-bg)] p-6">
        <div className="flex w-full max-w-[480px] flex-col gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-8 py-8 shadow-2xl">
          <div className="text-[17px] font-semibold tracking-tight text-[var(--color-text)]">
            Přihlášení proběhlo
          </div>
          <div className="text-[13.5px] leading-relaxed text-[var(--color-text-muted)]">
            Sdílený graf uvidíš hned – co je v něm vidět, řídí oprávnění na
            serveru.
          </div>
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
            Pracovní složky na Macu vznikají po uzlech: otevři uzel v grafu a
            klikni na <span className="font-medium text-[var(--color-text)]">Otevřít terminál v Portuni</span>.
            Portuni založí lokální složku uzlu, spustí v ní agenta a stáhne
            soubory. Bez tohoto kroku zůstává obsah jen na serveru.
          </div>
          <button
            type="button"
            onClick={handleFirstStepsDone}
            className="self-end rounded-md border border-[var(--color-accent-dim)] bg-[var(--color-accent-soft)] px-5 py-2.5 text-[14px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-dim)]"
          >
            Rozumím, otevřít Portuni
          </button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 2: Type-check and build**

```bash
npm --prefix apps/web run build
```
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/CentralLoginGate.tsx
git commit -m "feat(web): post-login first-steps screen points to the terminal-creates-mirror flow"
```

---

### Task 5: Docs — public site, env inventory pointers, CLAUDE.md

**Files:**
- Modify: `sites/docs/src/content/docs/getting-started/team-setup.md`
- Modify: `CLAUDE.md` (the desktop central-server gotcha's "Teammate setup" sentence)

**Interfaces:**
- Consumes: behaviour shipped in Tasks 1–4.

- [ ] **Step 1: Update team-setup.md**

1. In the "Server environment" table, add two rows after `PORTUNI_GOOGLE_CLIENT_IDS`:

```markdown
| `PORTUNI_DESKTOP_GOOGLE_CLIENT_ID` | Desktop OAuth client id served publicly at `GET /auth/desktop-config` so the app's onboarding wizard can configure itself from just the server URL |
| `PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET` | That client's secret — non-confidential for Google installed apps; served alongside the id |
```

2. Replace the "Join as a teammate" section body (keep the heading) with:

```markdown
As a teammate you install the regular desktop app and point it at your organization's server. All you need from your admin is the **server URL**.

1. Install `Portuni.app` from [GitHub releases](https://github.com/honzapav/portuni/releases) as in [Setup](/getting-started/setup/).
2. On first launch the app asks how to start — choose **Připojit se k týmu** and enter the server URL. The app fetches the organization's sign-in configuration from the server (`GET /auth/desktop-config`) and switches the workspace to central data mode.
3. Sign in with your Google account when prompted. The app stores a device token in the macOS Keychain; no database or Drive credentials ever touch your machine.

That's it. The graph you see — and everything your AI agents can do — is filtered through your permissions on the server.

Mirror folders work in central mode too: the local sidecar runs as a **sync agent** that keeps your mirror folders and file status current, brokering every read and write through the central server with your device token. Folders materialize per node — open a node and hit **Otevřít terminál v Portuni** (or run a sync) and the app creates the local mirror for you. The app walks you through this right after your first sign-in.

Advanced: the same settings can still be written by hand into the app's `config.json` (`~/Library/Application Support/ooo.workflow.portuni/config.json`, keys `server_url`, `google_client_id`, `google_client_secret`, `data_mode: "central"`) — useful when the server does not serve `/auth/desktop-config`.
```

3. Also update the Google Workspace prerequisites item 1: append ", and — so the wizard can self-configure — into `PORTUNI_DESKTOP_GOOGLE_CLIENT_ID`/`PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET`" to the sentence about where the OAuth client goes, and drop "and into each teammate's app config".

- [ ] **Step 2: Build the docs site**

```bash
npm --prefix sites/docs run build
```
Expected: clean Astro build.

- [ ] **Step 3: Update CLAUDE.md**

In the "Desktop central-server config" gotcha, replace the sentence
`Teammate setup = config.json se server_url, google_client_id, google_client_secret, data_mode.` with:

```markdown
Teammate setup = onboarding wizard („Připojit se k týmu": zadá se jen server URL; app si stáhne OAuth client z veřejného `GET /auth/desktop-config` — `setup_central` command — a zapíše config.json s `data_mode: "central"`). Ruční config.json se stejnými klíči dál funguje jako fallback.
```

- [ ] **Step 4: Commit**

```bash
git add sites/docs/src/content/docs/getting-started/team-setup.md CLAUDE.md
git commit -m "docs: team onboarding via the in-app wizard + desktop-config env vars"
```

---

### Task 6: Full verification

- [ ] **Step 1: Full test suites**

```bash
npm run build && npm test
cd apps/desktop && cargo test && cd ../..
npm --prefix apps/web run build
```
Expected: all green.

- [ ] **Step 2: Live smoke of the endpoint**

```bash
npm run build
PORTUNI_DESKTOP_GOOGLE_CLIENT_ID=test-id PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET=test-secret \
  PORT=14999 node dist/index.js &
sleep 2
curl -s http://127.0.0.1:14999/auth/desktop-config
kill %1
```
Expected: `{"google_client_id":"test-id","google_client_secret":"test-secret"}`. (Adapt env — if the server refuses to boot without `TURSO_URL`, run via `varlock run --` like the tmux loop does.)

- [ ] **Step 3: Manual end-to-end (requires human + signed build)**

Not automatable — hand back to Honza with these steps:
1. Set `PORTUNI_DESKTOP_GOOGLE_CLIENT_ID`/`SECRET` on the VPS server env and restart the unit; `curl https://api.portuni.com/auth/desktop-config` returns the client.
2. Build the signed app (`scripts/build-signed.sh --no-notarize`), move the existing `~/Library/Application Support/ooo.workflow.portuni/config.json` aside, launch: wizard shows "Připojit se k týmu" + "Začít lokálně".
3. Enter the server URL → reload → Google login screen → login → first-steps screen → app.
4. Restore the original config.json afterwards.

---

## Out of scope (explicitly)

- Invite links / multi-org discovery.
- Changing the `needs-token` Turso modal or the owner's (hand-edited) local-mode Turso setup.
- Auto-launching a terminal from the first-steps screen (guidance only — launching needs a node selection).
- Revoking shared Turso tokens after teammate migration (ops task in Asana, not code).
