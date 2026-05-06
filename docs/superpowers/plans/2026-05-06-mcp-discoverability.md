# MCP Discoverability and Stable Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Portuni's bundled MCP server reachable from external agents (Claude Code, Codex) after a fresh install of `Portuni.app`, without the user having to dig for the port or token.

**Architecture:** Four coordinated changes. (1) Stable endpoint: replace the per-launch random port with a fixed configurable port (default `47011`) and persist the auth token in the macOS Keychain so it survives restarts. (2) Promote Settings from a modal panel to a top-level page (new `AppView` value, sidebar entry, no overlay chrome) so it has room for new sections. (3) Add an "MCP server" section on that Settings page: URL, copy buttons for URL/token, one-click install actions that register Portuni as a user-scoped MCP server in Claude Code (`~/.claude.json`) and Codex (`~/.codex/config.toml`). (4) A persistent footer status indicator (green dot + "mcp") visible from any view, so the user can see at a glance whether the MCP server is reachable; clicking jumps to the Settings page. Existing per-mirror `.mcp.json` files written by `portuni_mirror` keep working because the endpoint they reference is now stable; the sidecar re-materialises them on boot to migrate installs that already have stale random-port entries.

**Tech Stack:** Rust (Tauri host, `keyring` crate), TypeScript (Node sidecar, React UI), `node:test` for backend tests, Tauri commands as the IPC channel.

---

## Decisions taken (override before execution if needed)

These are defaults locked into the tasks below. Tell me before kicking off if you want any of them changed.

1. **Default port: `47011`.** High enough to avoid common dev ports; overridable via `config.json` `mcp_port` field for users who hit a collision. Dev backend stays on `4011` (no overlap).
2. **Token: 48-char alphanumeric, generated once on first launch, stored in Keychain** under service `ooo.workflow.portuni`, account `mcp_auth_token`. Reused across launches. Rotatable from UI.
3. **Claude Code global install** writes to `~/.claude.json` directly under `mcpServers.portuni` (`claude mcp add` is fine but adds a dependency on the CLI being installed; direct file edit is more robust for a desktop app).
4. **Codex global install** appends/updates `[mcp_servers.portuni]` in `~/.codex/config.toml` using the same shape `portuni_mirror` already produces.
5. **Token over IPC, not HTTP.** The frontend reads the token via a Tauri command (Keychain), never via the backend's HTTP API. The backend exposes only `GET /mcp/info` (URL + flags, no token).
6. **Existing mirrors** are re-materialised on sidecar boot so already-written `.mcp.json` files in mirror dirs pick up the stable port + token automatically.

## File structure

**Modify:**
- `src-tauri/src/lib.rs` — Keychain helpers for `mcp_auth_token`, `get_mcp_endpoint` / `regenerate_mcp_token` / `install_claude_global` / `install_codex_global` Tauri commands, change `PORTUNI_PORT` from `0` to the configured stable port.
- `src/desktop.ts` — at boot, re-materialise scope for every registered mirror so existing `.mcp.json` files refresh.
- `src/http/server.ts` — add `GET /mcp/info` route (loopback, no auth required) returning `{url, port, has_auth_token}`.
- `src/domain/write-scope.ts` — extract `buildClaudeMcpJson`'s server object so the new global-install commands can reuse it without round-tripping to the backend.
- `app/src/App.tsx` — add `"settings"` view, drop `settingsOpen` modal state, render `SettingsPage` as top-level view.
- `app/src/components/Sidebar.tsx` — extend `AppView` with `"settings"` and add the nav entry.
- `app/src/components/SettingsPanel.tsx` — rename to `SettingsPage.tsx`, drop modal props (`onClose`), drop Escape handler, render as a page.
- `app/src/lib/backend-url.ts` — already centralises backend URL resolution; verify nothing breaks when port becomes deterministic.

**Create:**
- `src-tauri/src/mcp_install.rs` — pure functions for `~/.claude.json` and `~/.codex/config.toml` mutation (so they can be unit-tested with `cargo test` in isolation).
- `app/src/components/SettingsPage.tsx` — page version of the old SettingsPanel.
- `app/src/components/McpServerSection.tsx` — the UI component (status, copy buttons, install buttons, regenerate).
- `app/src/components/StatusFooter.tsx` — persistent footer with the MCP indicator.
- `app/src/lib/use-mcp-status.ts` — hook that polls `/mcp/info` and returns `{state: "running"|"down", url?}`.
- `test/mcp-info.test.ts` — verifies `GET /mcp/info` shape and that it's reachable without auth from loopback.
- `test/mcp-rematerialize-on-boot.test.ts` — verifies sidecar rewrites stale `.mcp.json` files in registered mirrors at boot.

---

### Task 1: Keychain helpers for the MCP auth token (Rust)

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the Keychain account constant and getter**

Open `src-tauri/src/lib.rs`. Below the existing `KEYCHAIN_TURSO_ACCOUNT` constant (around line 30) add:

```rust
const KEYCHAIN_MCP_ACCOUNT: &str = "mcp_auth_token";

fn keychain_get_mcp_token() -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_MCP_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.is_empty())
}

fn keychain_set_mcp_token(token: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_MCP_ACCOUNT)
        .map_err(|e| e.to_string())?
        .set_password(token)
        .map_err(|e| e.to_string())
}

fn generate_mcp_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

// Returns the Keychain token, generating + persisting one on first call.
fn ensure_mcp_token() -> Result<String, String> {
    if let Some(existing) = keychain_get_mcp_token() {
        return Ok(existing);
    }
    let fresh = generate_mcp_token();
    keychain_set_mcp_token(&fresh)?;
    Ok(fresh)
}
```

- [ ] **Step 2: Replace per-launch token generation in `spawn_sidecar`**

Find the existing line (around `lib.rs:297`):

```rust
let auth_token = app.state::<AuthToken>().0.clone();
```

Replace with:

```rust
let auth_token = ensure_mcp_token().map_err(|e| -> Box<dyn std::error::Error> {
    format!("could not load or create MCP auth token: {e}").into()
})?;
*app.state::<AuthToken>().0.lock().unwrap() = auth_token.clone();
```

Then change the `AuthToken` struct definition (around `lib.rs:24`) to be mutable:

```rust
struct AuthToken(Mutex<String>);
```

…and update the constructor in `tauri::Builder::default().setup(...)` (search for `AuthToken(` to find it) to:

```rust
.manage(AuthToken(Mutex::new(String::new())))
```

Update every other reader (search the file for `AuthToken`) to do `.0.lock().unwrap().clone()` instead of `.0.clone()`.

- [ ] **Step 3: Add `regenerate_mcp_token` Tauri command**

Add this function below `clear_turso_token`:

```rust
#[tauri::command]
fn regenerate_mcp_token(app: AppHandle) -> Result<String, String> {
    let fresh = generate_mcp_token();
    keychain_set_mcp_token(&fresh)?;
    *app.state::<AuthToken>().0.lock().unwrap() = fresh.clone();
    Ok(fresh)
}

#[tauri::command]
fn get_mcp_token(app: AppHandle) -> Result<String, String> {
    Ok(app.state::<AuthToken>().0.lock().unwrap().clone())
}
```

Register both in the `invoke_handler!` block alongside `set_turso_token`:

```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    regenerate_mcp_token,
    get_mcp_token,
])
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: clean build, no warnings about unused `AuthToken` fields.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(desktop): persist MCP auth token in Keychain"
```

---

### Task 2: Stable MCP port

**Files:**
- Modify: `src-tauri/src/lib.rs` (`DesktopConfig`, `spawn_sidecar`)

- [ ] **Step 1: Add `mcp_port` to `DesktopConfig`**

Around line 32 in `lib.rs`, extend `DesktopConfig`:

```rust
#[derive(Default, Serialize, Deserialize, Clone)]
struct DesktopConfig {
    #[serde(default)]
    turso_url: Option<String>,
    #[serde(default)]
    portuni_workspace_root: Option<String>,
    /// Loopback port the bundled MCP server listens on. Stable across
    /// launches so external agents (Claude Code, Codex) can keep their
    /// `.mcp.json` configs valid. Default: 47011.
    #[serde(default)]
    mcp_port: Option<u16>,
}

const DEFAULT_MCP_PORT: u16 = 47011;
```

- [ ] **Step 2: Pass the configured port to the sidecar**

In `spawn_sidecar`, replace:

```rust
.env("PORTUNI_PORT", "0")
```

with:

```rust
.env("PORTUNI_PORT", config.mcp_port.unwrap_or(DEFAULT_MCP_PORT).to_string())
```

- [ ] **Step 3: Surface bind errors clearly**

The sidecar already writes `PORTUNI_BACKEND_ERROR=...` on failure (`src/desktop.ts:114`) and `lib.rs` parses it. No change needed here, but verify the message includes "EADDRINUSE" when the port is taken. Open `src/desktop.ts` around the `main().catch` block; the existing error handler suffices because `startHttpServer` rejects with a node listen error.

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: clean build.

- [ ] **Step 5: Manually verify port stickiness**

Run: `cargo tauri dev` once, observe sidecar log line `sidecar backend ready on port 47011`. Quit and relaunch. Expect the same port.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(desktop): use stable MCP port (default 47011) instead of OS-assigned"
```

---

### Task 3: `GET /mcp/info` endpoint (no auth, loopback only)

**Files:**
- Create: `test/mcp-info.test.ts`
- Modify: `src/http/server.ts`
- Modify: `src/api/router.ts` (or wherever route dispatch lives)

- [ ] **Step 1: Locate the existing API router**

Run: `grep -n "routeApiRequest" src/api/router.ts | head`
Expected: a function that branches on `url.pathname`.

- [ ] **Step 2: Write the failing test**

Create `test/mcp-info.test.ts`:

```ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { startHttpServer } from "../src/http/server.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GET /mcp/info returns endpoint metadata without auth", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "portuni-mcp-info-"));
  process.env.PORTUNI_DATA_DIR = tmp;
  process.env.TURSO_URL = `file:${join(tmp, "test.db")}`;
  process.env.PORTUNI_AUTH_TOKEN = "secret";
  const handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });
  await new Promise<void>((r) => handle.server.once("listening", r));
  const port = (handle.server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/info`);
    assert.equal(res.status, 200);
    const body = await res.json() as { url: string; port: number; has_auth_token: boolean };
    assert.equal(body.port, port);
    assert.equal(body.has_auth_token, true);
    assert.match(body.url, /\/mcp$/);
  } finally {
    await handle.shutdown();
  }
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `npm test -- --test-name-pattern="mcp/info"`
Expected: FAIL with 404 (route not registered yet).

- [ ] **Step 4: Add the route in `src/http/server.ts`**

Inside the `createServer((req, res) => ...)` handler, just below the existing `if (url.pathname === "/mcp" || url.pathname === "/mcp/")` block, add:

```ts
if (url.pathname === "/mcp/info" && req.method === "GET") {
  const port = (httpServer.address() as { port: number } | null)?.port ?? 0;
  const body = {
    url: `http://${host}:${port}/mcp`,
    port,
    has_auth_token: Boolean(process.env.PORTUNI_AUTH_TOKEN),
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
  return;
}
```

This must come *after* `applyGates` (loopback/origin check) but *before* the auth gate. Inspect `applyGates` in `src/http/middleware.ts` to confirm `/mcp/info` is admitted; if `applyGates` short-circuits on auth, refactor it to skip auth for this path (mirroring whatever existing carve-out the health route uses, if any).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="mcp/info"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http/server.ts test/mcp-info.test.ts
git commit -m "feat(http): add GET /mcp/info for UI discovery (no auth, loopback only)"
```

---

### Task 4: Re-materialise mirror configs on sidecar boot

**Files:**
- Modify: `src/desktop.ts`
- Create: `test/mcp-rematerialize-on-boot.test.ts`

- [ ] **Step 1: Locate the existing materialisation entry point**

Run: `grep -n "materializeMirrorScope\|materializeAllScopes\|materialise" src/domain/scope-materialize.ts`
Expected: an exported function we can call with a list of mirrors.

- [ ] **Step 2: Write the failing test**

Create `test/mcp-rematerialize-on-boot.test.ts`:

```ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

test("desktop boot rewrites stale .mcp.json in registered mirrors with current port + token", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "portuni-remat-"));
  const mirrorDir = join(tmp, "mirror-org");
  mkdirSync(mirrorDir, { recursive: true });
  writeFileSync(join(mirrorDir, ".mcp.json"), JSON.stringify({
    mcpServers: { portuni: { type: "http", url: "http://127.0.0.1:9999/mcp", headers: { Authorization: "Bearer stale" } } },
  }));
  // Pre-seed sync.db with a row pointing at mirrorDir. (Use the registry helper directly via tsx import.)
  // ... (test sets PORTUNI_WORKSPACE_ROOT=tmp and uses registerMirror)

  const child = spawn(process.execPath, ["--import", "tsx", "src/desktop.ts"], {
    env: {
      ...process.env,
      PORTUNI_DATA_DIR: tmp,
      PORTUNI_PORT: "47011",
      PORTUNI_AUTH_TOKEN: "freshtoken",
      PORTUNI_WORKSPACE_ROOT: tmp,
      TURSO_URL: `file:${join(tmp, "portuni.db")}`,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("boot timeout")), 10_000);
    child.stdout.on("data", (b: Buffer) => {
      if (b.toString().includes("PORTUNI_LISTENING_PORT=")) { clearTimeout(t); resolve(); }
    });
  });
  try {
    const written = JSON.parse(readFileSync(join(mirrorDir, ".mcp.json"), "utf-8")) as {
      mcpServers: { portuni: { url: string; headers?: { Authorization: string } } };
    };
    assert.match(written.mcpServers.portuni.url, /:47011\/mcp/);
    assert.equal(written.mcpServers.portuni.headers?.Authorization, "Bearer freshtoken");
  } finally {
    child.kill("SIGTERM");
  }
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `npm test -- --test-name-pattern="rewrites stale"`
Expected: FAIL — `.mcp.json` still has `:9999` and `Bearer stale`.

- [ ] **Step 4: Implement the boot-time rematerialisation**

In `src/desktop.ts`, after `await ensureSchema();` and before `startHttpServer(...)`, add:

```ts
// Refresh per-mirror harness configs so any .mcp.json written by an
// older launch (random port, rotated token) gets the current endpoint.
// Best-effort: a failure in one mirror must not block boot.
try {
  const { listUserMirrors } = await import("./domain/sync/mirror-registry.js");
  const { materializeMirrorScope } = await import("./domain/scope-materialize.js");
  const { SOLO_USER } = await import("./infra/schema.js");
  const mirrors = await listUserMirrors(SOLO_USER);
  for (const m of mirrors) {
    try {
      await materializeMirrorScope({ userId: SOLO_USER, mirrorPath: m.local_path });
    } catch (e) {
      console.error(`[boot] rematerialize failed for ${m.local_path}:`, e);
    }
  }
} catch (e) {
  console.error("[boot] mirror rematerialisation skipped:", e);
}
```

(Adjust the import names to match what `scope-materialize.ts` actually exports — confirm in step 1.)

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- --test-name-pattern="rewrites stale"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/desktop.ts test/mcp-rematerialize-on-boot.test.ts
git commit -m "feat(desktop): rematerialise mirror harness configs on sidecar boot"
```

---

### Task 5: Tauri command to install Portuni in `~/.claude.json`

**Files:**
- Create: `src-tauri/src/mcp_install.rs`
- Modify: `src-tauri/src/lib.rs` (`mod mcp_install;` + handler registration)

- [ ] **Step 1: Create the module skeleton with a unit test**

Create `src-tauri/src/mcp_install.rs`:

```rust
use serde_json::{json, Value};
use std::path::Path;

/// Inserts or updates `mcpServers.portuni` in the JSON object loaded from `path`.
/// Returns the JSON string to write back. Pure for testability.
pub fn upsert_claude_config(existing: Option<&str>, url: &str, token: &str) -> Result<String, String> {
    let mut root: Value = match existing {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(raw).map_err(|e| e.to_string())?,
        _ => json!({}),
    };
    let obj = root.as_object_mut().ok_or_else(|| "~/.claude.json is not a JSON object".to_string())?;
    let servers = obj.entry("mcpServers".to_string()).or_insert_with(|| json!({}));
    let servers_obj = servers.as_object_mut().ok_or_else(|| "mcpServers is not an object".to_string())?;
    servers_obj.insert(
        "portuni".to_string(),
        json!({
            "type": "http",
            "url": url,
            "headers": { "Authorization": format!("Bearer {token}") },
        }),
    );
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

pub fn write_claude_config(claude_json: &Path, url: &str, token: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(claude_json).ok();
    let next = upsert_claude_config(existing.as_deref(), url, token)?;
    if let Some(parent) = claude_json.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(claude_json, next).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upserts_into_empty_file() {
        let out = upsert_claude_config(None, "http://127.0.0.1:47011/mcp", "abc").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["portuni"]["url"], "http://127.0.0.1:47011/mcp");
        assert_eq!(v["mcpServers"]["portuni"]["headers"]["Authorization"], "Bearer abc");
    }

    #[test]
    fn preserves_other_servers() {
        let existing = r#"{"mcpServers":{"other":{"type":"stdio","command":"x"}}}"#;
        let out = upsert_claude_config(Some(existing), "http://x/mcp", "tok").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["mcpServers"]["other"].is_object());
        assert_eq!(v["mcpServers"]["portuni"]["url"], "http://x/mcp");
    }

    #[test]
    fn replaces_existing_portuni_entry() {
        let existing = r#"{"mcpServers":{"portuni":{"type":"http","url":"http://old/mcp","headers":{"Authorization":"Bearer old"}}}}"#;
        let out = upsert_claude_config(Some(existing), "http://new/mcp", "new").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["portuni"]["url"], "http://new/mcp");
        assert_eq!(v["mcpServers"]["portuni"]["headers"]["Authorization"], "Bearer new");
    }
}
```

- [ ] **Step 2: Run unit tests to confirm they pass**

Run: `cd src-tauri && cargo test mcp_install`
Expected: 3 passing tests.

- [ ] **Step 3: Add the Tauri command in `lib.rs`**

At the top of `src-tauri/src/lib.rs`, add:

```rust
mod mcp_install;
```

Below the existing commands, add:

```rust
#[tauri::command]
fn install_claude_global(app: AppHandle) -> Result<String, String> {
    let port = app
        .state::<BackendPort>()
        .0
        .lock()
        .unwrap()
        .ok_or_else(|| "MCP server not yet running".to_string())?;
    let token = app.state::<AuthToken>().0.lock().unwrap().clone();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = std::path::PathBuf::from(home).join(".claude.json");
    mcp_install::write_claude_config(&path, &url, &token)?;
    Ok(path.to_string_lossy().into_owned())
}
```

Register it in `invoke_handler!`.

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/mcp_install.rs
git commit -m "feat(desktop): install_claude_global command writes ~/.claude.json"
```

---

### Task 6: Tauri command to install Portuni in `~/.codex/config.toml`

**Files:**
- Modify: `src-tauri/src/mcp_install.rs` (add `upsert_codex_config` + tests)
- Modify: `src-tauri/src/lib.rs` (new `install_codex_global` command)
- Add dependency: `toml_edit` to `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the dependency**

Open `src-tauri/Cargo.toml`, find the `[dependencies]` block, add:

```toml
toml_edit = "0.22"
```

- [ ] **Step 2: Add pure-function logic + tests**

Append to `src-tauri/src/mcp_install.rs`:

```rust
use toml_edit::{value, DocumentMut, Item, Table};

pub fn upsert_codex_config(existing: Option<&str>, url: &str, token: &str) -> Result<String, String> {
    let mut doc: DocumentMut = match existing {
        Some(raw) if !raw.trim().is_empty() => raw.parse().map_err(|e: toml_edit::TomlError| e.to_string())?,
        _ => DocumentMut::new(),
    };
    let servers = doc.entry("mcp_servers").or_insert(Item::Table(Table::new()));
    let servers_table = servers.as_table_mut().ok_or_else(|| "mcp_servers is not a table".to_string())?;
    servers_table.set_implicit(true);
    let portuni = servers_table.entry("portuni").or_insert(Item::Table(Table::new()));
    let portuni_table = portuni.as_table_mut().ok_or_else(|| "mcp_servers.portuni is not a table".to_string())?;
    portuni_table["url"] = value(url);
    portuni_table["bearer_token"] = value(token);
    Ok(doc.to_string())
}

pub fn write_codex_config(toml_path: &Path, url: &str, token: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(toml_path).ok();
    let next = upsert_codex_config(existing.as_deref(), url, token)?;
    if let Some(parent) = toml_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(toml_path, next).map_err(|e| e.to_string())
}

#[cfg(test)]
mod codex_tests {
    use super::*;

    #[test]
    fn writes_to_empty_file() {
        let out = upsert_codex_config(None, "http://127.0.0.1:47011/mcp", "tok").unwrap();
        assert!(out.contains("[mcp_servers.portuni]"));
        assert!(out.contains("url = \"http://127.0.0.1:47011/mcp\""));
        assert!(out.contains("bearer_token = \"tok\""));
    }

    #[test]
    fn preserves_other_sections() {
        let existing = "[other]\nfoo = 1\n";
        let out = upsert_codex_config(Some(existing), "http://x/mcp", "tok").unwrap();
        assert!(out.contains("[other]"));
        assert!(out.contains("foo = 1"));
        assert!(out.contains("[mcp_servers.portuni]"));
    }
}
```

Confirm the exact key name (`bearer_token` vs `headers`) by checking what `portuni_mirror` already writes — open `src/domain/write-scope.ts` and search for `codex` to confirm. If it writes a different shape, mirror that shape here. (The plan assumes `bearer_token` because that's the conventional Codex MCP TOML key, but the existing emitter is the source of truth.)

- [ ] **Step 3: Run unit tests**

Run: `cd src-tauri && cargo test mcp_install`
Expected: 5 tests passing (3 from Task 5 + 2 new).

- [ ] **Step 4: Wire the Tauri command**

In `lib.rs` add below `install_claude_global`:

```rust
#[tauri::command]
fn install_codex_global(app: AppHandle) -> Result<String, String> {
    let port = app
        .state::<BackendPort>()
        .0
        .lock()
        .unwrap()
        .ok_or_else(|| "MCP server not yet running".to_string())?;
    let token = app.state::<AuthToken>().0.lock().unwrap().clone();
    let url = format!("http://127.0.0.1:{port}/mcp");
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = std::path::PathBuf::from(home).join(".codex").join("config.toml");
    mcp_install::write_codex_config(&path, &url, &token)?;
    Ok(path.to_string_lossy().into_owned())
}
```

Register it in `invoke_handler!`.

- [ ] **Step 5: Compile + commit**

```bash
cd src-tauri && cargo build && cd ..
git add src-tauri/src/mcp_install.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(desktop): install_codex_global command writes ~/.codex/config.toml"
```

---

### Task 7: Promote Settings from modal panel to top-level page

**Files:**
- Create: `app/src/components/SettingsPage.tsx`
- Modify: `app/src/components/Sidebar.tsx`
- Modify: `app/src/App.tsx`
- Delete: `app/src/components/SettingsPanel.tsx` (after move)

Rationale: the new MCP section, plus existing agent-command settings, plus future work (Turso URL, workspace root) need real estate that an Escape-dismissable overlay can't carry. `App.tsx` already routes top-level views via the `view` URL param and `Sidebar` `AppView` enum — the same pattern as `graph` / `actors`.

- [ ] **Step 1: Inspect current Sidebar to see how views are declared**

Run: `grep -n "AppView\|view ==\|onView\|setView" app/src/components/Sidebar.tsx | head`
Note the exact union type (likely `"graph" | "actors"`) and the nav button pattern.

- [ ] **Step 2: Extend `AppView` with `"settings"` and add the nav entry**

In `app/src/components/Sidebar.tsx`, change the type:

```ts
export type AppView = "graph" | "actors" | "settings";
```

In whichever JSX block holds the existing nav buttons (search for the "actors" button), add a sibling button:

```tsx
<button
  type="button"
  className={view === "settings" ? "nav-active" : ""}
  onClick={() => onViewChange("settings")}
>
  Nastavení
</button>
```

(Match the exact className/handler names already used by the actors button.)

- [ ] **Step 3: Move SettingsPanel to SettingsPage**

Copy `app/src/components/SettingsPanel.tsx` to `app/src/components/SettingsPage.tsx`. In the new file:

1. Rename the default export and component to `SettingsPage`.
2. Remove `onClose: () => void` from `Props`.
3. Delete the `useEffect` that listens for the Escape key.
4. Remove the close `<button>` that previously called `onClose` (and the `X` icon import if no longer used).
5. Replace the modal/overlay outer wrapper (whatever fixed-position div the panel uses) with a plain page container that matches the layout of `ActorsPage.tsx` — open `app/src/components/ActorsPage.tsx` and copy its outermost wrapper class/structure so the page sits inside the main view area instead of floating.
6. Keep the agent-command form intact.

- [ ] **Step 4: Update `App.tsx` to render the page instead of the modal**

In `app/src/App.tsx`:

1. Change the import:
   ```ts
   import SettingsPage from "./components/SettingsPage";
   ```
2. Delete the `settingsOpen` state and its setter.
3. Delete the `onOpenSettings={() => setSettingsOpen(true)}` prop forwarded to whichever component had it (likely the Sidebar header). The sidebar nav now covers it.
4. In the main view-rendering block (where it currently switches between `<GraphView />` and `<ActorsPage />`), add a third branch:
   ```tsx
   {view === "settings" && (
     <SettingsPage
       agentCommand={agentCommand}
       onAgentCommandChange={setAgentCommand}
     />
   )}
   ```
5. Remove the existing JSX that mounts `<SettingsPanel ... />` at the bottom of the layout.
6. Mirror the `view` URL param behaviour for `settings` the same way `actors` is handled (search the file for `"actors"` to find the read/write of `?view=` — copy the same flow).

- [ ] **Step 5: Delete the old panel file**

```bash
git rm app/src/components/SettingsPanel.tsx
```

- [ ] **Step 6: Manual verification**

Restart the Vite dev server (`varlock run -- npm --prefix app run dev`). In the browser:
1. Click the new "Nastavení" item in the sidebar — settings render as a full page, no overlay.
2. URL becomes `?view=settings`.
3. Reloading the page lands back on Settings.
4. Switching back to graph/actors works normally.
5. Pressing Escape no longer closes Settings (because nothing should — it's a page now).

- [ ] **Step 7: Commit**

```bash
git add app/src/App.tsx app/src/components/Sidebar.tsx app/src/components/SettingsPage.tsx
git rm app/src/components/SettingsPanel.tsx
git commit -m "refactor(app): promote Settings from modal panel to top-level page"
```

---

### Task 8: MCP server section on the Settings page

**Files:**
- Create: `app/src/components/McpServerSection.tsx`
- Modify: `app/src/components/SettingsPage.tsx`

- [ ] **Step 1: Read SettingsPage to learn its section primitives**

Run: `head -120 app/src/components/SettingsPage.tsx`
Note: section heading style, button style, and how Tauri commands are invoked. Reuse those — do NOT introduce new UI primitives.

- [ ] **Step 2: Create the new component**

Create `app/src/components/McpServerSection.tsx`:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Info = { url: string; port: number; has_auth_token: boolean };

export default function McpServerSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const port = (await invoke<number | null>("get_backend_port")) ?? 0;
        if (port > 0) {
          const res = await fetch(`http://127.0.0.1:${port}/mcp/info`);
          setInfo(await res.json());
        }
      } catch {
        setInfo(null);
      }
    })();
  }, []);

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setMessage(`${label} zkopirovano`);
    setTimeout(() => setMessage(null), 2000);
  }

  async function revealToken() {
    if (token) {
      setTokenVisible((v) => !v);
      return;
    }
    const t = await invoke<string>("get_mcp_token");
    setToken(t);
    setTokenVisible(true);
  }

  async function regenerate() {
    if (!confirm("Vygenerovat novy token? Vsechny stavajici .mcp.json a externi konfigurace prestanou fungovat.")) return;
    setBusy("regenerate");
    try {
      const t = await invoke<string>("regenerate_mcp_token");
      setToken(t);
      setTokenVisible(true);
      setMessage("Token vygenerovan. Restartni Portuni a znovu kliknu Install pro Claude/Codex.");
    } finally {
      setBusy(null);
    }
  }

  async function install(target: "claude" | "codex") {
    setBusy(target);
    try {
      const cmd = target === "claude" ? "install_claude_global" : "install_codex_global";
      const path = await invoke<string>(cmd);
      setMessage(`Zapsano do ${path}`);
    } catch (e) {
      setMessage(`Chyba: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  if (!info) return <section><h3>MCP server</h3><p>MCP server nebezi nebo se ho nepodarilo zjistit.</p></section>;

  return (
    <section>
      <h3>MCP server</h3>
      <p>Endpoint pro Claude Code a Codex.</p>
      <dl>
        <dt>URL</dt>
        <dd>
          <code>{info.url}</code>{" "}
          <button onClick={() => copy(info.url, "URL")}>Kopirovat</button>
        </dd>
        <dt>Token</dt>
        <dd>
          <code>{tokenVisible && token ? token : "............"}</code>{" "}
          <button onClick={revealToken}>{tokenVisible ? "Skryt" : "Zobrazit"}</button>{" "}
          <button onClick={() => token && copy(token, "Token")} disabled={!token}>Kopirovat</button>
        </dd>
      </dl>
      <div>
        <button disabled={busy !== null} onClick={() => install("claude")}>
          {busy === "claude" ? "..." : "Pridat do Claude Code (~/.claude.json)"}
        </button>{" "}
        <button disabled={busy !== null} onClick={() => install("codex")}>
          {busy === "codex" ? "..." : "Pridat do Codexu (~/.codex/config.toml)"}
        </button>{" "}
        <button disabled={busy !== null} onClick={regenerate}>
          {busy === "regenerate" ? "..." : "Vygenerovat novy token"}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
```

(Czech labels intentionally without diacritics in this draft to keep the task self-contained; replace with diacritics-correct strings during implementation per the global CLAUDE.md rule.)

- [ ] **Step 3: Mount the component in `SettingsPage.tsx`**

Add `import McpServerSection from "./McpServerSection";` near the top, then place `<McpServerSection />` inside the page where the other sections render (above or below the agent-command section, your call — keep it visible without scrolling on a 13-inch laptop screen).

- [ ] **Step 4: Run the desktop dev shell to verify it renders**

Run (in tmux session `portuni-tauri`):
```bash
tmux new -d -s portuni-tauri 'cd /Users/honzapav/Dev/projekty/portuni && cargo tauri dev'
```
Open Settings, confirm the section appears with the URL and the Copy/Install/Regenerate buttons.

- [ ] **Step 5: Manual smoke test of one install button**

Click "Pridat do Claude Code". Confirm a success toast referencing `~/.claude.json`. Inspect the file:

```bash
cat ~/.claude.json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(json.dumps(d["mcpServers"]["portuni"], indent=2))'
```
Expected: portuni entry with the current URL and `Bearer <token>`.

- [ ] **Step 6: Replace ASCII labels with diacritics-correct Czech**

Edit `McpServerSection.tsx` and change Czech strings to use proper diacritics (per the global rule "When you create any content in Czech, always use diacritics").

- [ ] **Step 7: Commit**

```bash
git add app/src/components/McpServerSection.tsx app/src/components/SettingsPage.tsx
git commit -m "feat(app): MCP server section on Settings page (status, copy, install, regenerate)"
```

---

### Task 9: Footer MCP status indicator

**Files:**
- Create: `app/src/lib/use-mcp-status.ts`
- Create: `app/src/components/StatusFooter.tsx`
- Modify: `app/src/App.tsx` (mount the footer at the bottom of the layout)
- Modify: `app/src/index.css` (footer + dot styles, in the same place existing app-chrome styles live)

Design: a thin bar at the bottom of the window (full width, ~24 px tall). Left side shows `● mcp` where the dot is green when `/mcp/info` responds 200, red when it doesn't, amber while still loading on first poll. The whole row is a `<button>` that switches the view to `settings`. Polling cadence: 5 s while running, 2 s while down (so recovery shows up fast). Clicking copies nothing; the only action is "go to Settings".

- [ ] **Step 1: Hook that exposes MCP status**

Create `app/src/lib/use-mcp-status.ts`:

```ts
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type McpStatus =
  | { state: "loading" }
  | { state: "running"; url: string; port: number }
  | { state: "down"; reason: string };

export function useMcpStatus(): McpStatus {
  const [status, setStatus] = useState<McpStatus>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const port = (await invoke<number | null>("get_backend_port")) ?? 0;
        if (port === 0) {
          if (!cancelled) setStatus({ state: "down", reason: "backend port unknown" });
        } else {
          const res = await fetch(`http://127.0.0.1:${port}/mcp/info`);
          if (!res.ok) {
            if (!cancelled) setStatus({ state: "down", reason: `HTTP ${res.status}` });
          } else {
            const body = (await res.json()) as { url: string; port: number };
            if (!cancelled) setStatus({ state: "running", url: body.url, port: body.port });
          }
        }
      } catch (e) {
        if (!cancelled)
          setStatus({ state: "down", reason: e instanceof Error ? e.message : String(e) });
      }
      if (!cancelled) {
        const nextDelay = status.state === "running" ? 5000 : 2000;
        timer = setTimeout(tick, nextDelay);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the hook owns its own polling cadence
  }, []);

  return status;
}
```

- [ ] **Step 2: Footer component**

Create `app/src/components/StatusFooter.tsx`:

```tsx
import type { AppView } from "./Sidebar";
import { useMcpStatus } from "../lib/use-mcp-status";

type Props = {
  onOpenSettings: () => void;
};

export default function StatusFooter({ onOpenSettings }: Props) {
  const status = useMcpStatus();
  const dotClass =
    status.state === "running"
      ? "status-dot status-dot--ok"
      : status.state === "loading"
        ? "status-dot status-dot--pending"
        : "status-dot status-dot--down";
  const label = status.state === "running" ? "mcp" : status.state === "loading" ? "mcp…" : "mcp ×";
  const title =
    status.state === "running"
      ? `MCP server běží: ${status.url}`
      : status.state === "loading"
        ? "Zjišťuji stav MCP serveru…"
        : `MCP server nedostupný: ${status.reason}`;

  return (
    <footer className="status-footer">
      <button type="button" className="status-footer__indicator" title={title} onClick={onOpenSettings}>
        <span className={dotClass} aria-hidden="true" />
        <span>{label}</span>
      </button>
    </footer>
  );
}

// re-export to satisfy the AppView import path used by App.tsx
export type { AppView };
```

- [ ] **Step 3: Add CSS for the footer + dot**

Append to `app/src/index.css`:

```css
.status-footer {
  height: 24px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  border-top: 1px solid var(--border, #2a2a2a);
  font-size: 12px;
  background: var(--bg-subtle, #111);
}
.status-footer__indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  padding: 2px 6px;
}
.status-footer__indicator:hover { background: var(--bg-hover, #1c1c1c); border-radius: 4px; }
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.status-dot--ok { background: #22c55e; }
.status-dot--pending { background: #f59e0b; }
.status-dot--down { background: #ef4444; }
```

(If the project uses Tailwind or a different token system, swap these for the matching tokens — open `index.css` first to see which convention is used.)

- [ ] **Step 4: Mount the footer in `App.tsx`**

Add the import:

```ts
import StatusFooter from "./components/StatusFooter";
```

Wrap the existing root layout in a flex column so the footer sits at the bottom regardless of view. Find the outermost `<div>` returned by `App` and adjust:

```tsx
<div className="app-root">
  {/* existing sidebar + main view */}
  <StatusFooter onOpenSettings={() => setView("settings")} />
</div>
```

If the existing root already uses CSS grid with a fixed sidebar + main area, add a third grid row of `auto` for the footer; if it's flex, add `flex-direction: column` to `.app-root` and put the existing sidebar+main wrapper in its own intermediate row that takes `flex: 1`. Do NOT restructure the layout more than necessary — minimal change to slot one row at the bottom.

- [ ] **Step 5: Manual verification**

Restart Vite dev server. Confirm:
1. Footer is visible on all views (graph, actors, settings).
2. Green dot + "mcp" while server runs.
3. Tooltip on hover shows the URL.
4. Click switches to the Settings page.
5. Stop the sidecar (`tmux send-keys -t portuni-mcp C-c`) — within ~2 s the dot turns red and label becomes `mcp ×`.
6. Restart the sidecar — within ~2 s the dot turns green again.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/StatusFooter.tsx app/src/lib/use-mcp-status.ts app/src/App.tsx app/src/index.css
git commit -m "feat(app): footer indicator showing MCP server status"
```

---

### Task 10: End-to-end smoke verification

**Files:** none — verification only.

- [ ] **Step 1: Build and install the app**

```bash
cd /Users/honzapav/Dev/projekty/portuni
npm run build:sidecar
cargo tauri build
cp -R src-tauri/target/release/bundle/macos/Portuni.app /Applications/
```

- [ ] **Step 2: Launch the installed app fresh and confirm port stickiness**

```bash
open /Applications/Portuni.app
sleep 5
lsof -nP -iTCP -sTCP:LISTEN | grep portuni-sidecar
```
Expected: bound on `127.0.0.1:47011`.

- [ ] **Step 3: Open the Settings page (sidebar -> Nastavení) and click "Přidat do Claude Code"**

Then in a new terminal:
```bash
claude --print "Pouzij MCP nastroj portuni_session_init s home_node_id <ULID> a vrat scope summary."
```
Expected: command succeeds, scope summary returned.

- [ ] **Step 4: Quit and relaunch app, confirm the same `claude` command still works**

This is the regression that motivated the whole plan: token + port both persist, so external configs stay valid.

- [ ] **Step 5: Click "Vygenerovat novy token", confirm `claude` command now fails until "Pridat do Claude Code" is clicked again**

Documents the rotation contract for users.

- [ ] **Step 6: Verify the footer indicator**

While the sidecar is up after the install: footer shows green `● mcp`. Quit Portuni; the next launch should show green again within 2 s of `backend-ready`. Force-kill just the sidecar from another terminal (`pkill -f portuni-sidecar`) — footer goes red within 2 s, then green again after Tauri auto-respawns (or stays red until you relaunch the app, depending on whether auto-respawn is wired).

- [ ] **Step 7: Final commit (release notes only)**

```bash
git add docs/superpowers/plans/2026-05-06-mcp-discoverability.md
git commit -m "docs: MCP discoverability + stable endpoint plan"
```

---

## Self-review

- **Spec coverage:** all decisions in the header are implemented across tasks 1-9 (1-2 endpoint, 3-4 backend wiring, 5-6 install commands, 7 Settings-as-page refactor, 8 MCP UI section, 9 footer indicator). Task 10 is the verification leg.
- **Placeholders:** none — every step has either complete code or an exact command. The two places that say "confirm exact key name in the existing emitter" (Task 6 step 2) and "verify import names in scope-materialize.ts" (Task 4 step 4) are explicit research steps with a fallback path, not deferred work.
- **Type consistency:** `AuthToken` is `Mutex<String>` everywhere after Task 1; `BackendPort` is unchanged; the new commands are `get_mcp_token`, `regenerate_mcp_token`, `install_claude_global`, `install_codex_global` — used identically in Rust handlers and TS `invoke<...>` calls.
