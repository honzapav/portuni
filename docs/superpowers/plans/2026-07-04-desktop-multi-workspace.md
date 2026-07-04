# Multi-workspace desktop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jedna desktopová appka obsluhuje N nezávislých workspaces (vlastní DB/server, sidecar, mirrory, tokeny); sidecary všech zapnutých workspaces běží souběžně a UI přepíná pohled.

**Architecture:** Config v2 (`workspaces` mapa + `active_workspace`) v jednom `config.json`; Rust shell drží mapy `workspace_id → {proces, port, token}` a routuje `api_request` podle aktivního workspace. Sidecar (Node) se nemění — dostává env per workspace plus nové `PORTUNI_WORKSPACE_ID`, které TS generátory per-mirror configů použijí pro suffixovanou token env proměnnou. Keychain accounty a globální MCP entries jsou namespacované workspace ID.

**Tech Stack:** Rust (Tauri 2, serde, keyring), TypeScript (Node 24, `node --import tsx --test`), React (apps/web).

**Spec:** `docs/superpowers/specs/2026-07-04-desktop-multi-workspace-design.md`

## Global Constraints

- Workspace ID = slug `^[a-z][a-z0-9-]{0,31}$`, neměnné po vytvoření.
- Token env var = `PORTUNI_MCP_TOKEN_` + uppercase ID s `-` → `_` (např. `honzapav` → `PORTUNI_MCP_TOKEN_HONZAPAV`).
- Keychain service zůstává `ooo.workflow.portuni`; accounty = `<base>.<id>` (např. `turso_auth_token.honzapav`).
- Porty: první volný od 47011 vzhledem k portům v configu; po přidělení navždy stabilní.
- Globální MCP entry name = `mcp_server_name` z configu, default `portuni-<id>`; migrovaný workspace dostane `portuni`.
- Per-mirror configy: jméno serveru VŽDY `portuni`; standalone server bez `PORTUNI_WORKSPACE_ID` musí generovat bajtově dnešní výstup (nulová regrese).
- Secrets nikdy v config.json ani ve webview JS (bezpečnostní pravidla z CLAUDE.md platí).
- Config v2 se při parse chybě NIKDY tiše nepřepíše defaultem.
- Rust testy: `cd apps/desktop && cargo test`. TS testy: `npm test` z rootu (pozn.: v non-login shellech použij `~/.nvm/versions/node/v24.0.2/bin/npm`). Jednotlivý soubor: `~/.nvm/versions/node/v24.0.2/bin/node --import tsx --test test/write-scope.test.ts`.
- Komentáře v kódu anglicky, žádné emoji. Commit messages anglicky (konvence repa: `feat(desktop): …`, `feat(server): …`).

---

### Task 1: TS — workspace-aware token env var v generátorech per-mirror configů

**Files:**
- Modify: `apps/server/domain/write-scope.ts` (u `buildClaudeMcpJson` ~řádek 253, `buildVibeMcpToml` ~295, nová fn vedle `resolvePortuniMcpUrl` ~234)
- Test: `test/write-scope.test.ts`

**Interfaces:**
- Produces: `export function resolveTokenEnvVar(): string` — čte `process.env.PORTUNI_WORKSPACE_ID`; bez něj vrací `"PORTUNI_MCP_TOKEN"`, s ním `"PORTUNI_MCP_TOKEN_" + id.toUpperCase().replace(/-/g, "_")`.
- `buildClaudeMcpJson` a `buildVibeMcpToml` volají `resolveTokenEnvVar()` interně (žádná změna signatur — konzumenti v `scope-materialize.ts` se nemění).

- [ ] **Step 1: Napiš failing testy**

Do `test/write-scope.test.ts` přidej (do existujících describe bloků `buildClaudeMcpJson` a `buildVibeMcpToml`, plus nový describe; `beforeEach`/`afterEach` vzor s env proměnnou už soubor používá pro `PORTUNI_GUARD_SCRIPT` — stejně ulož a obnov `process.env.PORTUNI_WORKSPACE_ID`):

```ts
describe("resolveTokenEnvVar", () => {
  const saved = process.env.PORTUNI_WORKSPACE_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.PORTUNI_WORKSPACE_ID;
    else process.env.PORTUNI_WORKSPACE_ID = saved;
  });

  it("returns the plain var when PORTUNI_WORKSPACE_ID is unset", () => {
    delete process.env.PORTUNI_WORKSPACE_ID;
    assert.equal(resolveTokenEnvVar(), "PORTUNI_MCP_TOKEN");
  });

  it("suffixes with uppercased id, dashes to underscores", () => {
    process.env.PORTUNI_WORKSPACE_ID = "honza-pav";
    assert.equal(resolveTokenEnvVar(), "PORTUNI_MCP_TOKEN_HONZA_PAV");
  });
});
```

A do describe `buildClaudeMcpJson` / `buildVibeMcpToml`:

```ts
it("references the workspace-suffixed env var when PORTUNI_WORKSPACE_ID is set", () => {
  process.env.PORTUNI_WORKSPACE_ID = "honzapav";
  try {
    const out = buildClaudeMcpJson({ url: "http://127.0.0.1:47012/mcp", homeNodeId: "n1" });
    const server = (out.mcpServers as Record<string, { headers: Record<string, string> }>).portuni;
    assert.equal(server.headers.Authorization, "Bearer ${PORTUNI_MCP_TOKEN_HONZAPAV:-}");
  } finally {
    delete process.env.PORTUNI_WORKSPACE_ID;
  }
});
```

```ts
it("uses the workspace-suffixed api_key_env when PORTUNI_WORKSPACE_ID is set", () => {
  process.env.PORTUNI_WORKSPACE_ID = "honzapav";
  try {
    const toml = buildVibeMcpToml({ url: "http://127.0.0.1:47012/mcp", homeNodeId: "n1" });
    assert.ok(toml.includes('api_key_env = "PORTUNI_MCP_TOKEN_HONZAPAV"'));
  } finally {
    delete process.env.PORTUNI_WORKSPACE_ID;
  }
});
```

Importuj `resolveTokenEnvVar` v hlavičce testu z `../apps/server/domain/write-scope.js` (stejný import blok jako ostatní).

- [ ] **Step 2: Ověř, že testy failují**

Run: `~/.nvm/versions/node/v24.0.2/bin/node --import tsx --test test/write-scope.test.ts`
Expected: FAIL — `resolveTokenEnvVar is not a function` / assertion na suffixované var.

- [ ] **Step 3: Implementace ve `write-scope.ts`**

Přidej za `resolvePortuniMcpUrl` (~ř. 243):

```ts
// Name of the env var per-mirror configs reference for the MCP bearer
// token. In the multi-workspace desktop each sidecar gets
// PORTUNI_WORKSPACE_ID and its mirrors reference a workspace-suffixed
// variable, so a terminal carrying tokens for several workspaces resolves
// the right one. Standalone servers (no PORTUNI_WORKSPACE_ID) keep the
// historical PORTUNI_MCP_TOKEN — byte-identical output, zero regression.
export function resolveTokenEnvVar(): string {
  const id = process.env.PORTUNI_WORKSPACE_ID?.trim();
  if (!id) return "PORTUNI_MCP_TOKEN";
  return "PORTUNI_MCP_TOKEN_" + id.toUpperCase().replace(/-/g, "_");
}
```

V `buildClaudeMcpJson` nahraď literál v headers a v `note`:

```ts
export function buildClaudeMcpJson(args: {
  url: string;
  homeNodeId: string | null;
}): Record<string, unknown> {
  const tokenVar = resolveTokenEnvVar();
  return {
    portuni_managed: {
      generated_at: new Date().toISOString(),
      note: `Portuni-managed file; regenerated on sidecar boot and mirror changes. Token comes from the ${tokenVar} env var, never stored here.`,
    },
    mcpServers: {
      portuni: {
        type: "http",
        url: appendHomeNodeIdToUrl(args.url, args.homeNodeId),
        headers: { Authorization: `Bearer \${${tokenVar}:-}` },
      },
    },
  };
}
```

V `buildVibeMcpToml` nahraď řádek `'api_key_env = "PORTUNI_MCP_TOKEN"',` za:

```ts
    `api_key_env = ${JSON.stringify(resolveTokenEnvVar())}`,
```

(`VIBE_PROJECT_MARKER` nech beze změny — marker je detekční konstanta, jeho text o `$PORTUNI_MCP_TOKEN` je jen popisný.)

- [ ] **Step 4: Testy zelené + celá suite**

Run: `~/.nvm/versions/node/v24.0.2/bin/node --import tsx --test test/write-scope.test.ts`
Expected: PASS všech testů — včetně stávajícího `it("references the token via env expansion, never a literal value")`, který hlídá nulovou regresi bez `PORTUNI_WORKSPACE_ID`.
Pak: `~/.nvm/versions/node/v24.0.2/bin/npm test`
Expected: PASS (žádný jiný test nesahá na PORTUNI_WORKSPACE_ID).

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/write-scope.ts test/write-scope.test.ts
git commit -m "feat(server): workspace-suffixed token env var in per-mirror config generators"
```

---

### Task 2: TS — guard hook s inline URL a token env var

**Files:**
- Modify: `apps/server/domain/write-scope.ts` (`buildClaudeHooksBlock` ~ř. 318, `buildClaudeSettings` ~ř. 360)
- Modify: `apps/server/domain/scope-materialize.ts` (volání `buildClaudeSettings` ~ř. 171)
- Test: `test/write-scope.test.ts` (describe `buildClaudeSettings`)

**Interfaces:**
- Consumes: `resolveTokenEnvVar()` z Task 1, `resolvePortuniMcpUrl()` (existující).
- Produces: `buildClaudeSettings` přijímá nový volitelný arg `mcpUrl?: string | null`. Hook command má tvar:
  `PORTUNI_URL="<base-url-bez-/mcp>" PORTUNI_AUTH_TOKEN="${<TOKEN_VAR>:-}" "<guardScriptPath>"`

- [ ] **Step 1: Failing testy** (describe `buildClaudeSettings`)

```ts
it("bakes the server URL and token env var into the hook command", () => {
  const out = buildClaudeSettings({
    currentMirror: "/ws/a",
    otherMirrors: [],
    portuniRoot: "/ws",
    guardScriptPath: "/repo/scripts/portuni-guard.sh",
    mcpUrl: "http://127.0.0.1:47012/mcp",
  });
  const hooks = out.hooks as {
    PreToolUse: { hooks: { command: string }[] }[];
  };
  const command = hooks.PreToolUse[0].hooks[0].command;
  assert.equal(
    command,
    'PORTUNI_URL="http://127.0.0.1:47012" PORTUNI_AUTH_TOKEN="${PORTUNI_MCP_TOKEN:-}" "/repo/scripts/portuni-guard.sh"',
  );
});

it("hook command falls back to bare script path without mcpUrl", () => {
  const out = buildClaudeSettings({
    currentMirror: "/ws/a",
    otherMirrors: [],
    portuniRoot: "/ws",
    guardScriptPath: "/repo/scripts/portuni-guard.sh",
  });
  const hooks = out.hooks as {
    PreToolUse: { hooks: { command: string }[] }[];
  };
  assert.equal(hooks.PreToolUse[0].hooks[0].command, "/repo/scripts/portuni-guard.sh");
});
```

- [ ] **Step 2: Ověř fail**

Run: `~/.nvm/versions/node/v24.0.2/bin/node --import tsx --test test/write-scope.test.ts`
Expected: FAIL — command neobsahuje `PORTUNI_URL=`.

- [ ] **Step 3: Implementace**

`buildClaudeHooksBlock` rozšiř a přepiš:

```ts
// Build the hooks block for .claude/settings.local.json. Returns null when
// no guard script is available so callers know to omit the block.
//
// When mcpUrl is known, the command line carries the server base URL and
// the workspace token env var inline, so the guard talks to the right
// workspace's server regardless of what the surrounding shell exports.
// The hook runs via `sh -c`, so leading VAR=... assignments apply to the
// script invocation only.
function buildClaudeHooksBlock(args: {
  guardScriptPath: string | null;
  mcpUrl?: string | null;
}): { hooks: Record<string, unknown> } | null {
  if (!args.guardScriptPath) return null;
  let command = args.guardScriptPath;
  if (args.mcpUrl) {
    const base = args.mcpUrl.replace(/\/+$/, "").replace(/\/mcp$/, "");
    const tokenVar = resolveTokenEnvVar();
    command = `PORTUNI_URL=${JSON.stringify(base)} PORTUNI_AUTH_TOKEN="\${${tokenVar}:-}" ${JSON.stringify(args.guardScriptPath)}`;
  }
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|NotebookEdit|MultiEdit",
          hooks: [{ type: "command", command }],
        },
      ],
    },
  };
}
```

`buildClaudeSettings` — přidej do args `mcpUrl?: string | null;` a předej ho:

```ts
  const hookBlock = buildClaudeHooksBlock({
    guardScriptPath: args.guardScriptPath ?? null,
    mcpUrl: args.mcpUrl ?? null,
  });
```

Ve `scope-materialize.ts` (materializeScopeConfig, ~ř. 171) předej URL:

```ts
    const settings = buildClaudeSettings({
      currentMirror: cur,
      otherMirrors: args.otherMirrors,
      portuniRoot: args.portuniRoot,
      guardScriptPath: args.guardScriptPath ?? null,
      mcpUrl: args.mcpUrl ?? resolvePortuniMcpUrl(),
    });
```

- [ ] **Step 4: Testy zelené**

Run: `~/.nvm/versions/node/v24.0.2/bin/npm test`
Expected: PASS. Zkontroluj, že stávající test `it("wires PreToolUse hook when guardScriptPath is provided")` prošel — pokud asserted přesný command string, uprav ho podle nového chování (materialize předává mcpUrl vždy, takže testy volající `materializeScopeConfig` s `mcpUrl` uvidí inline formu).

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/write-scope.ts apps/server/domain/scope-materialize.ts test/write-scope.test.ts
git commit -m "feat(server): guard hook command carries workspace server URL and token var inline"
```

---

### Task 3: Rust — modul `workspace.rs` (model configu v2, validace, odvozování, porty, migrační transformace)

**Files:**
- Create: `apps/desktop/src/workspace.rs`
- Modify: `apps/desktop/src/lib.rs` (jen `mod workspace;` vedle `mod auth;` ~ř. 13)

**Interfaces:**
- Produces (vše `pub(crate)` v `crate::workspace`):
  - `struct WorkspaceConfig { label: Option<String>, enabled: bool, turso_url: Option<String>, workspace_root: Option<String>, mcp_port: Option<u16>, server_url: Option<String>, google_client_id: Option<String>, google_client_secret: Option<String>, data_mode: Option<String>, mcp_server_name: Option<String> }` (Serialize/Deserialize/Clone/Default; `workspace_root` má `#[serde(alias = "portuni_workspace_root")]`)
  - `struct WorkspacesFile { config_version: u32, active_workspace: String, workspaces: BTreeMap<String, WorkspaceConfig> }`
  - `enum LoadedConfig { Missing, V1(serde_json::Value), V2(WorkspacesFile) }` + `fn load(data_dir: &Path) -> Result<LoadedConfig, String>` (parse error = `Err`, nikdy default!)
  - `fn save(data_dir: &Path, file: &WorkspacesFile) -> Result<(), String>` (write temp + rename)
  - `fn is_valid_workspace_id(id: &str) -> bool`
  - `fn token_env_var(id: &str) -> String`
  - `fn keychain_account(base: &str, id: &str) -> String`
  - `fn mcp_server_name(id: &str, cfg: &WorkspaceConfig) -> String`
  - `fn allocate_port(existing: &BTreeMap<String, WorkspaceConfig>) -> u16`
  - `fn workspace_data_dir(app_data: &Path, id: &str) -> PathBuf`
  - `fn migrate_v1_value(v1: &serde_json::Value, id: &str) -> WorkspacesFile` (pure)
  - `fn is_central(cfg: &WorkspaceConfig) -> bool`
  - `impl WorkspaceConfig { fn effective_workspace_root(&self) -> String }` (default `~/Workspaces/portuni`)

- [ ] **Step 1: Vytvoř `workspace.rs` s testy (TDD v jednom souboru — nejdřív testy, `cargo test` fail, pak implementace; Rust unit testy žijí v module)**

Kompletní obsah souboru:

```rust
// Workspace model for the multi-workspace desktop (config.json v2).
//
// A workspace is an independent world: its own graph (Turso DB or central
// server), its own sidecar, mirrors, tokens and configuration. This module
// is pure (no Tauri, no I/O beyond load/save) so everything is unit-testable
// without a Tauri runtime. Runtime wiring lives in lib.rs.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Lowest loopback port ever auto-assigned to a workspace sidecar.
pub(crate) const DEFAULT_MCP_PORT_BASE: u16 = 47011;

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct WorkspaceConfig {
    /// Display name shown in the switcher; falls back to the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Disabled workspaces keep their data on disk but get no sidecar and
    /// no global MCP entry.
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turso_url: Option<String>,
    /// Disk root for this workspace's mirrors. Alias keeps v1 field name
    /// parseable so migrate_v1_value can deserialize the flat config.
    #[serde(
        default,
        alias = "portuni_workspace_root",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_root: Option<String>,
    /// Assigned at creation, stable forever (external .mcp.json validity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_mode: Option<String>,
    /// Name of the user-scoped MCP entry (~/.claude.json key, Codex/Vibe
    /// block). Default portuni-<id>; the v1-migrated workspace keeps the
    /// historical "portuni" so mcp__portuni__* tool prefixes survive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_server_name: Option<String>,
}

impl WorkspaceConfig {
    pub(crate) fn effective_workspace_root(&self) -> String {
        self.workspace_root
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "~/Workspaces/portuni".to_string())
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct WorkspacesFile {
    pub config_version: u32,
    pub active_workspace: String,
    pub workspaces: BTreeMap<String, WorkspaceConfig>,
}

pub(crate) enum LoadedConfig {
    Missing,
    /// Flat v1 config as raw JSON — migration input.
    V1(serde_json::Value),
    V2(WorkspacesFile),
}

/// Load config.json distinguishing v1/v2. A v2 file that fails to parse is
/// an error surfaced to the user, NEVER silently replaced by a default —
/// that would orphan every workspace's data.
pub(crate) fn load(data_dir: &Path) -> Result<LoadedConfig, String> {
    let path = data_dir.join("config.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LoadedConfig::Missing)
        }
        Err(e) => return Err(format!("config.json read failed: {e}")),
    };
    if raw.trim().is_empty() {
        return Ok(LoadedConfig::Missing);
    }
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("config.json is not valid JSON: {e}"))?;
    if value.get("workspaces").is_some() {
        let file: WorkspacesFile = serde_json::from_value(value)
            .map_err(|e| format!("config.json v2 parse failed: {e}"))?;
        validate(&file)?;
        return Ok(LoadedConfig::V2(file));
    }
    Ok(LoadedConfig::V1(value))
}

fn validate(file: &WorkspacesFile) -> Result<(), String> {
    if file.workspaces.is_empty() {
        return Err("config.json v2 has no workspaces".to_string());
    }
    if !file.workspaces.contains_key(&file.active_workspace) {
        return Err(format!(
            "active_workspace '{}' is not in workspaces",
            file.active_workspace
        ));
    }
    let mut seen_ports: BTreeMap<u16, &str> = BTreeMap::new();
    for (id, ws) in &file.workspaces {
        if !is_valid_workspace_id(id) {
            return Err(format!("invalid workspace id '{id}'"));
        }
        if let Some(p) = ws.mcp_port {
            if let Some(other) = seen_ports.insert(p, id) {
                return Err(format!(
                    "workspaces '{other}' and '{id}' share mcp_port {p}"
                ));
            }
        }
    }
    Ok(())
}

/// Atomic save: write to a temp file in the same dir, then rename over.
pub(crate) fn save(data_dir: &Path, file: &WorkspacesFile) -> Result<(), String> {
    validate(file)?;
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    let tmp = data_dir.join("config.json.tmp");
    let path = data_dir.join("config.json");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub(crate) fn is_valid_workspace_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Env var per-mirror configs reference for this workspace's MCP token.
/// Must match resolveTokenEnvVar() in apps/server/domain/write-scope.ts.
pub(crate) fn token_env_var(id: &str) -> String {
    format!(
        "PORTUNI_MCP_TOKEN_{}",
        id.to_ascii_uppercase().replace('-', "_")
    )
}

pub(crate) fn keychain_account(base: &str, id: &str) -> String {
    format!("{base}.{id}")
}

pub(crate) fn mcp_server_name(id: &str, cfg: &WorkspaceConfig) -> String {
    cfg.mcp_server_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("portuni-{id}"))
}

/// First free port from DEFAULT_MCP_PORT_BASE given ports already assigned
/// in the config. Assigned once at creation, then stable forever.
pub(crate) fn allocate_port(existing: &BTreeMap<String, WorkspaceConfig>) -> u16 {
    let used: Vec<u16> = existing.values().filter_map(|w| w.mcp_port).collect();
    let mut candidate = DEFAULT_MCP_PORT_BASE;
    while used.contains(&candidate) {
        candidate += 1;
    }
    candidate
}

pub(crate) fn workspace_data_dir(app_data: &Path, id: &str) -> PathBuf {
    app_data.join("workspaces").join(id)
}

pub(crate) fn is_central(cfg: &WorkspaceConfig) -> bool {
    cfg.data_mode.as_deref() == Some("central")
}

/// Pure v1 -> v2 transform: wrap the flat config fields into a single
/// workspace under `id`. The migrated workspace keeps the historical
/// "portuni" MCP entry name and its existing port (or the base default).
pub(crate) fn migrate_v1_value(v1: &serde_json::Value, id: &str) -> WorkspacesFile {
    let mut ws: WorkspaceConfig =
        serde_json::from_value(v1.clone()).unwrap_or_default();
    ws.enabled = true;
    ws.mcp_server_name = Some("portuni".to_string());
    if ws.mcp_port.is_none() {
        ws.mcp_port = Some(DEFAULT_MCP_PORT_BASE);
    }
    let mut workspaces = BTreeMap::new();
    workspaces.insert(id.to_string(), ws);
    WorkspacesFile {
        config_version: 2,
        active_workspace: id.to_string(),
        workspaces,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(port: Option<u16>) -> WorkspaceConfig {
        WorkspaceConfig {
            mcp_port: port,
            ..Default::default()
        }
    }

    #[test]
    fn valid_ids() {
        assert!(is_valid_workspace_id("tempo"));
        assert!(is_valid_workspace_id("honza-pav2"));
        assert!(!is_valid_workspace_id(""));
        assert!(!is_valid_workspace_id("Tempo"));
        assert!(!is_valid_workspace_id("2fast"));
        assert!(!is_valid_workspace_id("a_b"));
        assert!(!is_valid_workspace_id(&"a".repeat(33)));
    }

    #[test]
    fn token_env_var_uppercases_and_replaces_dashes() {
        assert_eq!(token_env_var("honzapav"), "PORTUNI_MCP_TOKEN_HONZAPAV");
        assert_eq!(token_env_var("honza-pav"), "PORTUNI_MCP_TOKEN_HONZA_PAV");
    }

    #[test]
    fn keychain_account_suffixes() {
        assert_eq!(
            keychain_account("turso_auth_token", "tempo"),
            "turso_auth_token.tempo"
        );
    }

    #[test]
    fn mcp_server_name_defaults_and_overrides() {
        assert_eq!(mcp_server_name("acme", &ws(None)), "portuni-acme");
        let mut w = ws(None);
        w.mcp_server_name = Some("portuni".to_string());
        assert_eq!(mcp_server_name("tempo", &w), "portuni");
    }

    #[test]
    fn allocate_port_takes_first_free() {
        let mut m = BTreeMap::new();
        assert_eq!(allocate_port(&m), 47011);
        m.insert("a".to_string(), ws(Some(47011)));
        m.insert("b".to_string(), ws(Some(47013)));
        assert_eq!(allocate_port(&m), 47012);
    }

    #[test]
    fn migrate_v1_wraps_flat_fields() {
        let v1 = serde_json::json!({
            "turso_url": "libsql://x.turso.io",
            "portuni_workspace_root": "~/Workspaces/portuni-tempo",
            "data_mode": "central",
            "server_url": "https://api.example.com"
        });
        let out = migrate_v1_value(&v1, "tempo");
        assert_eq!(out.config_version, 2);
        assert_eq!(out.active_workspace, "tempo");
        let w = out.workspaces.get("tempo").unwrap();
        assert_eq!(w.turso_url.as_deref(), Some("libsql://x.turso.io"));
        assert_eq!(
            w.workspace_root.as_deref(),
            Some("~/Workspaces/portuni-tempo")
        );
        assert_eq!(w.mcp_server_name.as_deref(), Some("portuni"));
        assert_eq!(w.mcp_port, Some(47011));
        assert!(w.enabled);
        assert!(is_central(w));
    }

    #[test]
    fn migrate_v1_is_idempotent_shape() {
        // Running the transform twice over the same v1 value yields the
        // same file — the apply step's guard is `workspaces` presence, but
        // the transform itself must be deterministic too.
        let v1 = serde_json::json!({ "turso_url": "libsql://x" });
        let a = serde_json::to_string(&migrate_v1_value(&v1, "d")).unwrap();
        let b = serde_json::to_string(&migrate_v1_value(&v1, "d")).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn load_detects_v1_v2_and_missing() {
        let dir = std::env::temp_dir().join(format!(
            "portuni-ws-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // Missing
        let _ = std::fs::remove_file(dir.join("config.json"));
        assert!(matches!(load(&dir).unwrap(), LoadedConfig::Missing));
        // V1
        std::fs::write(dir.join("config.json"), r#"{"turso_url":"libsql://x"}"#).unwrap();
        assert!(matches!(load(&dir).unwrap(), LoadedConfig::V1(_)));
        // V2 roundtrip through save()
        let file = migrate_v1_value(&serde_json::json!({}), "default");
        save(&dir, &file).unwrap();
        match load(&dir).unwrap() {
            LoadedConfig::V2(f) => assert_eq!(f.active_workspace, "default"),
            _ => panic!("expected V2"),
        }
        // Corrupt v2 must be an error, not a silent default.
        std::fs::write(dir.join("config.json"), r#"{"workspaces": 42}"#).unwrap();
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_rejects_duplicate_ports_and_bad_active() {
        let mut m = BTreeMap::new();
        m.insert("a".to_string(), ws(Some(47011)));
        m.insert("b".to_string(), ws(Some(47011)));
        let file = WorkspacesFile {
            config_version: 2,
            active_workspace: "a".to_string(),
            workspaces: m,
        };
        assert!(super::validate(&file).is_err());

        let mut m2 = BTreeMap::new();
        m2.insert("a".to_string(), ws(Some(47011)));
        let file2 = WorkspacesFile {
            config_version: 2,
            active_workspace: "zzz".to_string(),
            workspaces: m2,
        };
        assert!(super::validate(&file2).is_err());
    }
}
```

Do `lib.rs` přidej `mod workspace;` pod `mod pty;` (ř. 15).

- [ ] **Step 2: Testy**

Run: `cd apps/desktop && cargo test workspace::`
Expected: PASS všech testů modulu. (`cargo test` celé crate musí projít taky — nic jiného se zatím nemění; počítej s warningem `dead_code`, dokud modul nikdo nevolá.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/workspace.rs apps/desktop/src/lib.rs
git commit -m "feat(desktop): workspace config v2 model, validation, derivation helpers"
```

---

### Task 4: Rust — parametrizované MCP instalátory + odinstalace

**Files:**
- Modify: `apps/desktop/src/mcp_install.rs` (celý — signatury + nové remove fns + testy)

**Interfaces:**
- Produces (změněné/nové signatury; volající v lib.rs se opraví v Task 7):
  - `pub fn upsert_claude_config(existing: Option<&str>, name: &str, url: &str, token: &str) -> Result<String, String>`
  - `pub fn remove_claude_server(existing: Option<&str>, name: &str) -> Result<String, String>`
  - `pub fn write_claude_config(path: &Path, name: &str, url: &str, token: &str) -> Result<(), String>`
  - `pub fn upsert_codex_config(existing: Option<&str>, name: &str, url: &str, token_env: &str) -> Result<String, String>` — marker per name: `# portuni-managed: mcp_servers.<name>`, blok `[mcp_servers.<name>]`, `bearer_token_env_var = "<token_env>"`
  - `pub fn remove_codex_block(existing: &str, name: &str) -> String`
  - `pub fn write_codex_config(path: &Path, name: &str, url: &str, token_env: &str) -> Result<(), String>`
  - `pub fn upsert_vibe_config(existing: Option<&str>, name: &str, url: &str, token_env: &str) -> Result<String, String>` — entry `name = "<name>"`, `api_key_env = "<token_env>"`, de-dup podle name
  - `pub fn remove_vibe_server(existing: &str, name: &str) -> Result<String, String>`
  - `pub fn write_vibe_config(path: &Path, name: &str, url: &str, token_env: &str) -> Result<(), String>`

- [ ] **Step 1: Rozšiř testy (failing)**

Přidej do stávajících test modulů:

```rust
// claude_tests
#[test]
fn upserts_named_entry_and_removal() {
    let out = upsert_claude_config(None, "portuni-honzapav", "http://127.0.0.1:47012/mcp", "abc").unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["mcpServers"]["portuni-honzapav"]["url"], "http://127.0.0.1:47012/mcp");
    // Two entries coexist.
    let out2 = upsert_claude_config(Some(&out), "portuni", "http://127.0.0.1:47011/mcp", "xyz").unwrap();
    let v2: Value = serde_json::from_str(&out2).unwrap();
    assert!(v2["mcpServers"]["portuni"].is_object());
    assert!(v2["mcpServers"]["portuni-honzapav"].is_object());
    // Removal deletes only the named entry.
    let out3 = remove_claude_server(Some(&out2), "portuni-honzapav").unwrap();
    let v3: Value = serde_json::from_str(&out3).unwrap();
    assert!(v3["mcpServers"]["portuni-honzapav"].is_null());
    assert!(v3["mcpServers"]["portuni"].is_object());
}

// codex_tests
#[test]
fn two_named_blocks_coexist_and_remove_targets_one() {
    let a = upsert_codex_config(None, "portuni", "http://x/mcp", "PORTUNI_MCP_TOKEN").unwrap();
    let b = upsert_codex_config(Some(&a), "portuni-honzapav", "http://y/mcp", "PORTUNI_MCP_TOKEN_HONZAPAV").unwrap();
    assert!(b.contains("[mcp_servers.portuni]"));
    assert!(b.contains("[mcp_servers.portuni-honzapav]"));
    assert!(b.contains("bearer_token_env_var = \"PORTUNI_MCP_TOKEN_HONZAPAV\""));
    let c = remove_codex_block(&b, "portuni-honzapav");
    assert!(!c.contains("portuni-honzapav"));
    assert!(c.contains("[mcp_servers.portuni]"));
}

// vibe_tests
#[test]
fn two_named_entries_coexist_and_remove_targets_one() {
    let a = upsert_vibe_config(None, "portuni", "http://x/mcp", "PORTUNI_MCP_TOKEN").unwrap();
    let b = upsert_vibe_config(Some(&a), "portuni-honzapav", "http://y/mcp", "PORTUNI_MCP_TOKEN_HONZAPAV").unwrap();
    let doc: DocumentMut = b.parse().unwrap();
    let arr = doc["mcp_servers"].as_array().unwrap();
    assert_eq!(arr.len(), 2);
    let c = remove_vibe_server(&b, "portuni-honzapav").unwrap();
    let doc2: DocumentMut = c.parse().unwrap();
    assert_eq!(doc2["mcp_servers"].as_array().unwrap().len(), 1);
}
```

Stávající testy uprav na nové signatury (všude přidej `"portuni"` jako name arg; codex/vibe místo tokenu předávají `"PORTUNI_MCP_TOKEN"`). Asserty stávajících testů (marker přesně jednou, idempotence, zachování cizích klíčů) zůstávají.

- [ ] **Step 2: Fail**

Run: `cd apps/desktop && cargo test mcp_install`
Expected: compile FAIL (změněné signatury) — to je očekávaný „failing test" stav.

- [ ] **Step 3: Implementace**

Claude:

```rust
pub fn upsert_claude_config(
    existing: Option<&str>,
    name: &str,
    url: &str,
    token: &str,
) -> Result<String, String> {
    let mut root: Value = match existing {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(raw).map_err(|e| format!("invalid JSON in ~/.claude.json: {e}"))?
        }
        _ => json!({}),
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "~/.claude.json root is not a JSON object".to_string())?;
    let servers = obj
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}));
    let servers_obj = servers
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())?;
    servers_obj.insert(
        name.to_string(),
        json!({
            "type": "http",
            "url": url,
            "headers": { "Authorization": format!("Bearer {token}") },
        }),
    );
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

pub fn remove_claude_server(existing: Option<&str>, name: &str) -> Result<String, String> {
    let mut root: Value = match existing {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(raw).map_err(|e| format!("invalid JSON in ~/.claude.json: {e}"))?
        }
        _ => return Ok("{}".to_string()),
    };
    if let Some(servers) = root
        .as_object_mut()
        .and_then(|o| o.get_mut("mcpServers"))
        .and_then(|s| s.as_object_mut())
    {
        servers.remove(name);
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

pub fn write_claude_config(claude_json: &Path, name: &str, url: &str, token: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(claude_json).ok();
    let next = upsert_claude_config(existing.as_deref(), name, url, token)?;
    if let Some(parent) = claude_json.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(claude_json, next).map_err(|e| e.to_string())
}
```

Codex — marker per name (starý globální `CODEX_MARKER` konstantu nahraď funkcí; `CODEX_TOKEN_ENV` konstantu smaž, env jméno teď chodí parametrem):

```rust
fn codex_marker(name: &str) -> String {
    format!("# portuni-managed: mcp_servers.{name}")
}

pub fn upsert_codex_config(
    existing: Option<&str>,
    name: &str,
    url: &str,
    token_env: &str,
) -> Result<String, String> {
    let marker = codex_marker(name);
    let block = format!(
        "{marker}\n[mcp_servers.{name}]\nurl = \"{url}\"\nbearer_token_env_var = \"{token_env}\"\n"
    );

    let body = match existing {
        Some(raw) if !raw.trim().is_empty() => raw,
        _ => return Ok(block),
    };

    if let Some(start) = body.find(&marker) {
        let after = &body[start..];
        let end_offset = after.find("\n\n").map(|n| start + n + 2).unwrap_or(body.len());
        let mut out = String::with_capacity(body.len() + block.len());
        out.push_str(&body[..start]);
        out.push_str(&block);
        if end_offset < body.len() {
            if !out.ends_with("\n\n") {
                if out.ends_with('\n') {
                    out.push('\n');
                } else {
                    out.push_str("\n\n");
                }
            }
            out.push_str(&body[end_offset..]);
        }
        return Ok(out);
    }

    let mut out = body.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push('\n');
    out.push_str(&block);
    Ok(out)
}

/// Remove the managed block for `name`. Text outside the block is preserved.
pub fn remove_codex_block(existing: &str, name: &str) -> String {
    let marker = codex_marker(name);
    let Some(start) = existing.find(&marker) else {
        return existing.to_string();
    };
    let after = &existing[start..];
    let end_offset = after
        .find("\n\n")
        .map(|n| start + n + 2)
        .unwrap_or(existing.len());
    let mut out = String::new();
    out.push_str(existing[..start].trim_end_matches('\n'));
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(existing[end_offset..].trim_start_matches('\n'));
    out
}
```

POZOR na zpětnou kompatibilitu markeru: dnešní soubory nesou `# portuni-managed: mcp_servers.portuni`, což je přesně `codex_marker("portuni")` — starý blok se tedy najde a nahradí správně bez migrace.

Vibe — parametrizuj name + token_env (v `upsert_vibe_config` nahraď literály `"portuni"` za `name` a `VIBE_TOKEN_ENV` za `token_env`; de-dup smyčka porovnává `== Some(name)`); přidej:

```rust
pub fn remove_vibe_server(existing: &str, name: &str) -> Result<String, String> {
    use toml_edit::{DocumentMut, Value};
    let mut doc: DocumentMut = existing
        .parse()
        .map_err(|e| format!("invalid TOML in ~/.vibe/config.toml: {e}"))?;
    if let Some(arr) = doc
        .get_mut("mcp_servers")
        .and_then(|i| i.as_value_mut())
        .and_then(|v| v.as_array_mut())
    {
        let mut i = 0;
        while i < arr.len() {
            let matches = arr
                .get(i)
                .and_then(Value::as_inline_table)
                .and_then(|t| t.get("name"))
                .and_then(Value::as_str)
                == Some(name);
            if matches {
                arr.remove(i);
            } else {
                i += 1;
            }
        }
    }
    Ok(doc.to_string())
}
```

`write_codex_config` / `write_vibe_config` — jen protáhni nové parametry.

Pozn.: lib.rs teď nekompiluje (volá staré signatury) — v tomto tasku oprav volání v `install_claude_global` / `install_codex_global` / `install_vibe_global` minimálně (dosaď `"portuni"` a `"PORTUNI_MCP_TOKEN"` jako name/token_env), plnou multi-workspace verzi commandů dělá Task 7.

- [ ] **Step 4: Testy zelené**

Run: `cd apps/desktop && cargo test`
Expected: PASS (mcp_install testy + zbytek crate).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/mcp_install.rs apps/desktop/src/lib.rs
git commit -m "feat(desktop): name-parametrized MCP installers with per-entry removal"
```

---

### Task 5: Rust — Keychain namespacing per workspace + migrace v1→v2 (apply)

**Files:**
- Modify: `apps/desktop/src/lib.rs` (keychain helpery ~ř. 37–39, 103–127, 284–308; nové commandy)
- Modify: `apps/desktop/src/auth.rs` (accounty ~ř. 31–56, `load_auth_config` ~ř. 67)
- Modify: `apps/desktop/src/pty.rs` (`ensure_device_token` ~ř. 39)
- Modify: `apps/desktop/src/workspace.rs` (apply migrace — file moves)

**Interfaces:**
- Consumes: `workspace::{load, save, migrate_v1_value, keychain_account, workspace_data_dir, is_valid_workspace_id, LoadedConfig}`.
- Produces:
  - lib.rs: `fn active_workspace(app: &AppHandle) -> Result<(String, workspace::WorkspaceConfig), String>` — načte v2 config, vrátí aktivní ID + config. `Err` pokud config je v1/Missing/corrupt (volající commandy vrací chybu do UI).
  - lib.rs: `fn keychain_get_ws(base: &str, ws_id: &str) -> Option<String>`, `fn keychain_set_ws(base: &str, ws_id: &str, value: &str) -> Result<(), String>`, `fn keychain_delete_ws(base: &str, ws_id: &str)` — obalují `keyring::Entry::new(KEYCHAIN_SERVICE, &workspace::keychain_account(base, ws_id))`.
  - auth.rs: `pub fn keychain_get_ws(base: &str, ws_id: &str) -> Option<String>` (re-export z lib nebo vlastní — jedna implementace, druhá deleguje), `pub const KEYCHAIN_SESSION_JWT: &str = "portuni_session_jwt"` (base beze změny), `load_auth_config(app) -> Option<(String, AuthConfig)>` — vrací i ws_id.
  - pty.rs: `pub(crate) fn ensure_device_token(app: &AppHandle, ws_id: &str, server_url: &str) -> Result<String, String>`.
  - Tauri commandy: `workspace_migration_status(app) -> Result<bool, String>` (true = v1 config čeká na migraci), `migrate_to_workspaces(app, id: String) -> Result<(), String>`.
  - workspace.rs: `pub(crate) fn apply_migration_files(data_dir: &Path, id: &str) -> Result<(), String>` — přesun `portuni.db`, `portuni.db-wal`, `portuni.db-shm`, `portuni.db-journal` (existující z nich) do `workspaces/<id>/`; idempotentní (chybějící zdroj = skip; existující cíl + existující zdroj = error „both exist").

- [ ] **Step 1: Testy na apply_migration_files (workspace.rs, failing)**

```rust
#[test]
fn apply_migration_moves_db_files_idempotently() {
    let dir = std::env::temp_dir().join(format!("portuni-mig-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("portuni.db"), b"db").unwrap();
    std::fs::write(dir.join("portuni.db-wal"), b"wal").unwrap();

    apply_migration_files(&dir, "tempo").unwrap();
    assert!(!dir.join("portuni.db").exists());
    assert!(dir.join("workspaces/tempo/portuni.db").exists());
    assert!(dir.join("workspaces/tempo/portuni.db-wal").exists());

    // Second run: sources gone, no error.
    apply_migration_files(&dir, "tempo").unwrap();

    // Fresh install (no db at all): fine too.
    let dir2 = dir.join("fresh");
    std::fs::create_dir_all(&dir2).unwrap();
    apply_migration_files(&dir2, "x").unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Fail** — `cd apps/desktop && cargo test apply_migration` → compile fail (fn neexistuje).

- [ ] **Step 3: Implementace `apply_migration_files` (workspace.rs)**

```rust
/// Move the v1 flat-layout DB files into workspaces/<id>/. Idempotent:
/// a missing source is skipped (already moved or fresh install); a source
/// AND destination both present is an error — never overwrite a database.
pub(crate) fn apply_migration_files(data_dir: &Path, id: &str) -> Result<(), String> {
    let target = workspace_data_dir(data_dir, id);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    for name in ["portuni.db", "portuni.db-wal", "portuni.db-shm", "portuni.db-journal"] {
        let src = data_dir.join(name);
        if !src.exists() {
            continue;
        }
        let dst = target.join(name);
        if dst.exists() {
            return Err(format!(
                "migration conflict: both {src:?} and {dst:?} exist — resolve manually"
            ));
        }
        std::fs::rename(&src, &dst).map_err(|e| format!("move {name} failed: {e}"))?;
    }
    Ok(())
}
```

- [ ] **Step 4: Keychain helpery + přepis všech přístupů**

V lib.rs nahraď `keychain_get_turso_token` / `set_turso_token` / `clear_turso_token` / `keychain_get_mcp_token` / `keychain_set_mcp_token` / `ensure_mcp_token` workspace-parametrickými:

```rust
pub(crate) fn keychain_get_ws(base: &str, ws_id: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &workspace::keychain_account(base, ws_id))
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|s| !s.is_empty())
}

pub(crate) fn keychain_set_ws(base: &str, ws_id: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &workspace::keychain_account(base, ws_id))
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}

pub(crate) fn keychain_delete_ws(base: &str, ws_id: &str) {
    if let Ok(entry) =
        keyring::Entry::new(KEYCHAIN_SERVICE, &workspace::keychain_account(base, ws_id))
    {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("keychain delete {base}.{ws_id} failed: {e}"),
        }
    }
}

// Persisted MCP auth token per workspace, generated on first use.
fn ensure_mcp_token_ws(ws_id: &str) -> Result<String, String> {
    if let Some(existing) = keychain_get_ws(KEYCHAIN_MCP_ACCOUNT, ws_id) {
        return Ok(existing);
    }
    let fresh = random_token();
    keychain_set_ws(KEYCHAIN_MCP_ACCOUNT, ws_id, &fresh)?;
    Ok(fresh)
}
```

Tauri commandy `set_turso_token` / `clear_turso_token` čtou aktivní workspace:

```rust
#[tauri::command]
fn set_turso_token(app: AppHandle, token: String) -> Result<(), String> {
    let (ws_id, _) = active_workspace(&app)?;
    keychain_set_ws(KEYCHAIN_TURSO_ACCOUNT, &ws_id, &token)
}

#[tauri::command]
fn clear_turso_token(app: AppHandle) -> Result<(), String> {
    let (ws_id, _) = active_workspace(&app)?;
    keychain_delete_ws(KEYCHAIN_TURSO_ACCOUNT, &ws_id);
    Ok(())
}
```

`active_workspace`:

```rust
pub(crate) fn active_workspace(
    app: &AppHandle,
) -> Result<(String, workspace::WorkspaceConfig), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(file) => {
            let cfg = file
                .workspaces
                .get(&file.active_workspace)
                .cloned()
                .ok_or_else(|| "active workspace missing from config".to_string())?;
            Ok((file.active_workspace, cfg))
        }
        workspace::LoadedConfig::V1(_) => Err("config awaiting workspace migration".to_string()),
        workspace::LoadedConfig::Missing => Err("no config.json (fresh install)".to_string()),
    }
}
```

auth.rs: nahraď volné helpery — `keychain_get(account)` → `keychain_get_ws(base, ws)` delegující na `crate::keychain_get_ws`; `keychain_set`/`keychain_delete` analogicky. `load_auth_config` vrací ws_id:

```rust
pub fn load_auth_config(app: &AppHandle) -> Option<(String, AuthConfig)> {
    let (ws_id, cfg) = crate::active_workspace(app).ok()?;
    let server_url = cfg.server_url?.trim().to_string();
    let google_client_id = cfg.google_client_id?.trim().to_string();
    let google_client_secret = cfg.google_client_secret.unwrap_or_default().trim().to_string();
    if server_url.is_empty() || google_client_id.is_empty() {
        return None;
    }
    Some((ws_id, AuthConfig { server_url, google_client_id, google_client_secret }))
}
```

Všechna místa v auth.rs, která volají `keychain_get(KEYCHAIN_SESSION_JWT)` / `keychain_set(...)` / `keychain_delete(...)` (auth_status ř. 381–383, google_login ř. 470+475, auth_refresh ř. 499+512, auth_logout ř. 521–523, central_request ř. 548+563), dostanou ws_id z `load_auth_config` resp. `crate::active_workspace`. `auth_logout` maže `google_refresh_token.<id>`, `portuni_session_jwt.<id>`, `portuni_device_token.<id>` aktivního workspace.

pty.rs `ensure_device_token` — nová signatura, server_url a ws chodí zvenčí (volající je zná):

```rust
pub(crate) fn ensure_device_token(
    app: &AppHandle,
    ws_id: &str,
    server_url: &str,
) -> Result<String, String> {
    if let Some(t) = crate::keychain_get_ws(KEYCHAIN_DEVICE_TOKEN_ACCOUNT, ws_id) {
        return Ok(t);
    }
    let jwt = crate::keychain_get_ws(crate::auth::KEYCHAIN_SESSION_JWT, ws_id)
        .ok_or_else(|| "not logged in: no session JWT in Keychain".to_string())?;
    let server_url = server_url.trim().trim_end_matches('/').to_string();
    let ws_for_store = ws_id.to_string();
    let token = tauri::async_runtime::block_on(async move {
        let body = serde_json::json!({ "label": "Desktop terminály" });
        let resp = crate::auth::do_central_request_raw(&server_url, "POST", "/device-tokens", Some(&body), &jwt).await?;
        if resp.status != 201 {
            return Err(format!("POST /device-tokens returned {}: {}", resp.status, resp.body));
        }
        let parsed: serde_json::Value = serde_json::from_str(&resp.body)
            .map_err(|e| format!("device-tokens response parse failed: {e}"))?;
        parsed["token"].as_str().map(str::to_string)
            .ok_or_else(|| "device-tokens response missing 'token' field".to_string())
    })?;
    crate::keychain_set_ws(KEYCHAIN_DEVICE_TOKEN_ACCOUNT, &ws_for_store, &token)?;
    log::info!("pty: device token minted and stored for workspace {ws_for_store}");
    Ok(token)
}
```

(Konstanta `KEYCHAIN_DEVICE_TOKEN_ACCOUNT` změň na `pub(crate)`. Volající — `get_mcp_token`, `spawn_sidecar`, `pty_spawn` — se dořeší v Tasks 6 a 8; v tomto tasku je uprav jen natolik, aby crate kompilovala: předej jim ws_id + server_url z `active_workspace(&app)?`.)

- [ ] **Step 5: Migrace — Tauri commandy (lib.rs)**

```rust
#[tauri::command]
fn workspace_migration_status(app: AppHandle) -> Result<bool, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(matches!(workspace::load(&data_dir)?, workspace::LoadedConfig::V1(_)))
}

// One-shot v1 -> v2 migration. Order matters for idempotence: DB files and
// Keychain first, config.json LAST — its `workspaces` key is the completion
// marker, so an interrupted run re-enters here safely.
#[tauri::command]
fn migrate_to_workspaces(app: AppHandle, id: String) -> Result<(), String> {
    if !workspace::is_valid_workspace_id(&id) {
        return Err("invalid workspace id (use lowercase letters, digits, dashes)".to_string());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let v1 = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V1(v) => v,
        workspace::LoadedConfig::V2(_) => return Ok(()), // already migrated
        workspace::LoadedConfig::Missing => serde_json::json!({}),
    };

    // 1. DB files into workspaces/<id>/.
    workspace::apply_migration_files(&data_dir, &id)?;

    // 2. Keychain: copy unsuffixed accounts to <base>.<id>, delete originals.
    //    Copy-if-missing keeps re-runs safe after a partial failure.
    const BASES: [&str; 5] = [
        "turso_auth_token",
        "mcp_auth_token",
        "google_refresh_token",
        "portuni_session_jwt",
        "portuni_device_token",
    ];
    for base in BASES {
        let old = keyring::Entry::new(KEYCHAIN_SERVICE, base)
            .ok()
            .and_then(|e| e.get_password().ok())
            .filter(|s| !s.is_empty());
        if let Some(value) = old {
            if keychain_get_ws(base, &id).is_none() {
                keychain_set_ws(base, &id, &value)?;
            }
            if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, base) {
                let _ = entry.delete_credential();
            }
        }
    }

    // 3. config.json v2 — completion marker.
    let file = workspace::migrate_v1_value(&v1, &id);
    workspace::save(&data_dir, &file)?;
    info!("migrated config.json to v2 with workspace '{id}'");
    Ok(())
}
```

Registruj oba commandy v `invoke_handler`. `migrate_turso_token_to_keychain` (ř. 316) zůstává — běží před migrací na v1 configu, po migraci je no-op (config už nemá `turso_auth_token`; pole si podrž v pořadí: v `spawn_sidecar` volej jen pro v1/local — viz Task 6).

- [ ] **Step 6: Kompilace + testy**

Run: `cd apps/desktop && cargo test`
Expected: PASS (workspace testy včetně `apply_migration_moves_db_files_idempotently`; crate kompiluje).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): per-workspace Keychain accounts + v1->v2 config migration"
```

---

### Task 6: Rust — souběžné sidecary (mapy stavu, spawn per workspace, routing, lifecycle commandy)

**Files:**
- Modify: `apps/desktop/src/lib.rs` (states ř. 26–31, `spawn_sidecar` ř. 987–1203, `api_request` ř. 780–913, `kill_managed_sidecar` ř. 918, `get_backend_port` ř. 377, `restart_sidecar` ř. 764, `get_mcp_token` ř. 138, `regenerate_mcp_token` ř. 158, `snapshot_mcp_endpoint` ř. 172, `get_data_mode` ř. 511, `get_turso_status` ř. 549, `save_config` ř. 571, `open_path_external` ř. 699, protocol handler ř. 1258, `run()` ř. 1206)
- Modify: `apps/desktop/src/auth.rs` (`google_login` post-login spawn ř. 483)

**Interfaces:**
- Produces:
  - `struct SidecarState(Mutex<HashMap<String, CommandChild>>)`
  - `struct BackendPorts(Mutex<HashMap<String, u16>>)` — hodnota `0` = central sentinel (agent deferred)
  - `struct AuthTokens(Mutex<HashMap<String, String>>)`
  - `pub(crate) fn spawn_sidecar_ws(app: &AppHandle, ws_id: &str) -> Result<(), Box<dyn std::error::Error>>`
  - `pub(crate) fn spawn_all_sidecars(app: &AppHandle)` — iteruje enabled workspaces; V1/Missing config = no-op (čeká na migraci/onboarding)
  - `fn kill_sidecar_ws(app: &AppHandle, ws_id: &str)` a `fn kill_all_sidecars(app: &AppHandle)`
  - Tauri commandy: `list_workspaces`, `create_workspace`, `set_active_workspace`, `set_workspace_enabled`, `delete_workspace`
  - `#[derive(Serialize)] struct WorkspaceInfo { id: String, label: String, data_mode: String, enabled: bool, mcp_port: Option<u16>, active: bool, running: bool, mcp_server_name: String, workspace_root: String }`

- [ ] **Step 1: Stavové mapy a spawn**

Nahraď staré struct definice:

```rust
struct SidecarState(Mutex<HashMap<String, CommandChild>>);
struct BackendPorts(Mutex<HashMap<String, u16>>);
struct AuthTokens(Mutex<HashMap<String, String>>);
```

`spawn_sidecar` přepiš na `spawn_sidecar_ws(app, ws_id)`. Jádro dnešní funkce zůstává; rozdíly:

```rust
pub(crate) fn spawn_sidecar_ws(
    app: &AppHandle,
    ws_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_data = app.path().app_data_dir()?;
    let (_, all) = match workspace::load(&app_data)? {
        workspace::LoadedConfig::V2(f) => (f.active_workspace.clone(), f.workspaces),
        _ => return Err("config not migrated to workspaces".into()),
    };
    let cfg = all
        .get(ws_id)
        .cloned()
        .ok_or_else(|| format!("unknown workspace {ws_id}"))?;
    if !cfg.enabled {
        return Ok(());
    }
    // Re-invocations (post-login, retry) must not double-spawn.
    if app
        .state::<SidecarState>()
        .0
        .lock()
        .unwrap()
        .contains_key(ws_id)
    {
        info!("workspace {ws_id}: sidecar already running");
        return Ok(());
    }

    let ws_data_dir = workspace::workspace_data_dir(&app_data, ws_id);
    std::fs::create_dir_all(&ws_data_dir).ok();
    let data_dir_str = ws_data_dir.to_string_lossy().to_string();
    let is_central = workspace::is_central(&cfg);

    let mut agent_env: Option<Vec<(String, String)>> = None;
    if is_central {
        let server_url = cfg
            .server_url
            .clone()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().trim_end_matches('/').to_string());
        let device_token = server_url
            .as_ref()
            .and_then(|u| crate::pty::ensure_device_token(app, ws_id, u).ok());
        match (server_url, device_token) {
            (Some(url), Some(token)) => {
                info!("workspace {ws_id}: starting sync agent against {url}");
                agent_env = Some(vec![
                    ("PORTUNI_AGENT_MODE".to_string(), "1".to_string()),
                    ("PORTUNI_CENTRAL_URL".to_string(), url.clone()),
                    ("PORTUNI_CENTRAL_TOKEN".to_string(), token),
                    ("PORTUNI_URL".to_string(), url),
                ]);
            }
            _ => {
                info!("workspace {ws_id}: sync agent deferred (no server_url or not logged in)");
                app.state::<BackendPorts>()
                    .0
                    .lock()
                    .unwrap()
                    .insert(ws_id.to_string(), 0);
                let _ = app.emit("backend-ready", 0u16);
                return Ok(());
            }
        }
    }

    let turso_url = if is_central {
        String::new()
    } else {
        cfg.turso_url.clone().unwrap_or_default()
    };
    let turso_token = if is_central {
        String::new()
    } else {
        keychain_get_ws(KEYCHAIN_TURSO_ACCOUNT, ws_id).unwrap_or_default()
    };
    let workspace_root = cfg.effective_workspace_root();

    // Per-workspace persisted MCP token, cached in the AuthTokens map so
    // api_request / pty_spawn read it without touching Keychain each time.
    let auth_token = ensure_mcp_token_ws(ws_id).unwrap_or_else(|e| {
        warn!("Keychain unavailable for {ws_id} MCP token, using per-launch random: {e}");
        random_token()
    });
    app.state::<AuthTokens>()
        .0
        .lock()
        .unwrap()
        .insert(ws_id.to_string(), auth_token.clone());

    let allowed_origins = [
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ]
    .join(",");

    let resource_dir = app.path().resource_dir()?;
    let sidecar_cwd = resource_dir.join("sidecar-deps");
    if !sidecar_cwd.exists() {
        warn!("sidecar-deps dir missing at {:?}", sidecar_cwd);
    }

    let port = cfg.mcp_port.unwrap_or(workspace::DEFAULT_MCP_PORT_BASE);
    reap_orphan_sidecar(port);

    let mut envs: Vec<(String, String)> = vec![
        ("PORTUNI_DATA_DIR".to_string(), data_dir_str),
        ("PORTUNI_PORT".to_string(), port.to_string()),
        ("PORTUNI_AUTH_TOKEN".to_string(), auth_token),
        ("PORTUNI_WORKSPACE_ROOT".to_string(), workspace_root),
        ("PORTUNI_WORKSPACE_ID".to_string(), ws_id.to_string()),
        ("PORTUNI_ALLOWED_ORIGINS".to_string(), allowed_origins),
        ("PORTUNI_LOG_REQUESTS".to_string(), "1".to_string()),
        ("HOME".to_string(), std::env::var("HOME").unwrap_or_default()),
        ("PATH".to_string(), std::env::var("PATH").unwrap_or_default()),
    ];
    match agent_env {
        Some(extra) => envs.extend(extra),
        None => {
            envs.push(("TURSO_URL".to_string(), turso_url));
            envs.push(("TURSO_AUTH_TOKEN".to_string(), turso_token));
        }
    }
    let mut cmd = app
        .shell()
        .sidecar("portuni-sidecar")?
        .current_dir(sidecar_cwd)
        .env_clear();
    for (k, v) in envs {
        cmd = cmd.env(k, v);
    }
    let (mut rx, child) = cmd.spawn()?;
    app.state::<SidecarState>()
        .0
        .lock()
        .unwrap()
        .insert(ws_id.to_string(), child);

    let handle = app.clone();
    let ws = ws_id.to_string();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).into_owned();
                    let line = line.trim_end_matches(|c| c == '\n' || c == '\r');
                    if let Some(rest) = line.strip_prefix("PORTUNI_LISTENING_PORT=") {
                        if let Ok(port) = rest.trim().parse::<u16>() {
                            handle
                                .state::<BackendPorts>()
                                .0
                                .lock()
                                .unwrap()
                                .insert(ws.clone(), port);
                            let _ = handle.emit("backend-ready", port);
                            info!("sidecar[{ws}] ready on port {port}");
                        }
                    } else if let Some(rest) = line.strip_prefix("PORTUNI_BACKEND_ERROR=") {
                        let msg = rest.trim().to_string();
                        error!("sidecar[{ws}] backend error: {msg}");
                        let _ = handle.emit("backend-error", msg);
                    } else {
                        info!("sidecar[{ws}]: {line}");
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).into_owned();
                    let line = line.trim_end_matches(|c| c == '\n' || c == '\r');
                    warn!("sidecar[{ws}]:err: {line}");
                }
                CommandEvent::Terminated(payload) => {
                    error!("sidecar[{ws}] terminated: code={:?}", payload.code);
                    handle
                        .state::<BackendPorts>()
                        .0
                        .lock()
                        .unwrap()
                        .remove(&ws);
                    let _ = handle.emit(
                        "backend-error",
                        format!("sidecar {ws} terminated (exit code {:?})", payload.code),
                    );
                }
                _ => {}
            }
        }
    });

    Ok(())
}

pub(crate) fn spawn_all_sidecars(app: &AppHandle) {
    let Ok(app_data) = app.path().app_data_dir() else { return };
    let file = match workspace::load(&app_data) {
        Ok(workspace::LoadedConfig::V2(f)) => f,
        Ok(_) => {
            info!("config awaiting migration/onboarding; no sidecars spawned");
            return;
        }
        Err(e) => {
            error!("config.json unreadable: {e}");
            let _ = app.emit("backend-error", format!("config.json: {e}"));
            return;
        }
    };
    for (id, cfg) in &file.workspaces {
        if !cfg.enabled {
            continue;
        }
        if let Err(e) = spawn_sidecar_ws(app, id) {
            error!("failed to spawn sidecar for {id}: {e}");
        }
    }
}
```

Pozn.: v1 helper `migrate_turso_token_to_keychain` se už z boot cesty nevolá (v2 config `turso_auth_token` pole nemá; pro v1 configy ho vstřebá `migrate_to_workspaces` — pokud pole existuje, `migrate_v1_value` ho ignoruje a Keychain krok migruje unsuffixovaný `turso_auth_token`, který tam starý helper už dřív uložil; configy s plaintext tokenem, které nikdy neprošly starým helperem, pokryj tak, že `migrate_to_workspaces` PŘED krokem 2 zavolá `migrate_turso_token_to_keychain(&data_dir)`).

`kill_managed_sidecar` → dvě fn:

```rust
fn kill_sidecar_ws(app: &AppHandle, ws_id: &str) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.remove(ws_id) {
                info!("killing sidecar[{ws_id}] (pid={})", child.pid());
                let _ = child.kill();
            }
        }
    }
    if let Some(state) = app.try_state::<BackendPorts>() {
        if let Ok(mut guard) = state.0.lock() {
            guard.remove(ws_id);
        }
    }
}

fn kill_all_sidecars(app: &AppHandle) {
    let ids: Vec<String> = app
        .try_state::<SidecarState>()
        .and_then(|s| s.0.lock().ok().map(|g| g.keys().cloned().collect()))
        .unwrap_or_default();
    for id in ids {
        kill_sidecar_ws(app, &id);
    }
}
```

Exit cesty (`on_window_event` Destroyed, `RunEvent::ExitRequested|Exit`) volají `kill_all_sidecars`. `.setup()` volá `spawn_all_sidecars`. `run()` už nepředpočítává jeden token — `.manage(AuthTokens(Mutex::new(HashMap::new())))`, `.manage(BackendPorts(Mutex::new(HashMap::new())))`, `.manage(SidecarState(Mutex::new(HashMap::new())))`.

- [ ] **Step 2: Routing per aktivní workspace**

`api_request`: nahraď čtení configu za `active_workspace(&app)`. `is_central` = `workspace::is_central(&cfg)`; central větev bere `server_url` z `cfg` a JWT přes `auth::keychain_get_ws(auth::KEYCHAIN_SESSION_JWT, &ws_id)`. Lokální proxy část:

```rust
    let (ws_id, cfg) = active_workspace(&app)?;
    // ... central branch as today, s cfg.server_url a ws-scoped JWT ...

    let port = {
        let state = app.state::<BackendPorts>();
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .get(&ws_id)
            .copied()
            .ok_or_else(|| "backend not ready".to_string())?
    };
    if port == 0 { /* 501 local_only sentinel — beze změny */ }
    let token = app
        .state::<AuthTokens>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&ws_id)
        .cloned()
        .ok_or_else(|| "backend not ready (no token)".to_string())?;
```

`get_backend_port` vrací port aktivního workspace (`BackendPorts` mapu + `active_workspace`; při V1/Missing configu vrať `None`, gate to řeší). `get_mcp_token`: central → `pty::ensure_device_token(&app, &ws_id, &server_url)`; local → `AuthTokens[ws_id]`. `regenerate_mcp_token`: `keychain_set_ws(KEYCHAIN_MCP_ACCOUNT, &ws_id, &fresh)` + update mapy. `snapshot_mcp_endpoint(app, ws_id)` — port z `BackendPorts[ws_id]`, token z `AuthTokens[ws_id]`. `restart_sidecar`: `kill_sidecar_ws(active)` + `spawn_sidecar_ws(active)`. `get_data_mode` / `get_turso_status` / `save_config` čtou/zapisují aktivní workspace ve v2 souboru (u `get_turso_status.config_exists` vrať `true` jen pro V2 — V1 zachytí migrace-gate dřív; `save_config` při Missing configu vytvoří v2 soubor s jediným workspace `default` — fresh-install onboarding tím rovnou vzniká jako v2). `open_path_external` + `portuni-html` protokol: root = `active_workspace` → `cfg.effective_workspace_root()`. `auth.rs google_login` post-login spawn: `crate::spawn_sidecar_ws(&app_for_agent, &ws_id)` (ws_id z `load_auth_config`).

- [ ] **Step 3: Lifecycle commandy**

```rust
#[derive(Serialize)]
struct WorkspaceInfo {
    id: String,
    label: String,
    data_mode: String,
    enabled: bool,
    mcp_port: Option<u16>,
    active: bool,
    running: bool,
    mcp_server_name: String,
    workspace_root: String,
}

#[tauri::command]
fn list_workspaces(app: AppHandle) -> Result<Vec<WorkspaceInfo>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Ok(vec![]),
    };
    let ports = app.state::<BackendPorts>().0.lock().map_err(|e| e.to_string())?;
    Ok(file
        .workspaces
        .iter()
        .map(|(id, cfg)| WorkspaceInfo {
            id: id.clone(),
            label: cfg.label.clone().unwrap_or_else(|| id.clone()),
            data_mode: if workspace::is_central(cfg) { "central" } else { "local" }.to_string(),
            enabled: cfg.enabled,
            mcp_port: cfg.mcp_port,
            active: *id == file.active_workspace,
            running: ports.get(id).is_some_and(|p| *p > 0),
            mcp_server_name: workspace::mcp_server_name(id, cfg),
            workspace_root: cfg.effective_workspace_root(),
        })
        .collect())
}

#[derive(Deserialize)]
struct CreateWorkspaceArgs {
    id: String,
    label: Option<String>,
    data_mode: String, // "local" | "central"
    turso_url: Option<String>,
    server_url: Option<String>,
    google_client_id: Option<String>,
    google_client_secret: Option<String>,
    workspace_root: String,
}

#[tauri::command]
fn create_workspace(app: AppHandle, args: CreateWorkspaceArgs) -> Result<(), String> {
    if !workspace::is_valid_workspace_id(&args.id) {
        return Err("invalid workspace id (use lowercase letters, digits, dashes)".to_string());
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Err("config not migrated to workspaces yet".to_string()),
    };
    if file.workspaces.contains_key(&args.id) {
        return Err(format!("workspace '{}' already exists", args.id));
    }
    let port = workspace::allocate_port(&file.workspaces);
    let cfg = workspace::WorkspaceConfig {
        label: args.label,
        enabled: true,
        turso_url: args.turso_url.filter(|s| !s.trim().is_empty()),
        workspace_root: Some(args.workspace_root),
        mcp_port: Some(port),
        server_url: args.server_url.filter(|s| !s.trim().is_empty()),
        google_client_id: args.google_client_id.filter(|s| !s.trim().is_empty()),
        google_client_secret: args.google_client_secret.filter(|s| !s.trim().is_empty()),
        data_mode: if args.data_mode == "central" { Some("central".to_string()) } else { None },
        mcp_server_name: None,
    };
    file.workspaces.insert(args.id.clone(), cfg);
    workspace::save(&data_dir, &file)?;
    if let Err(e) = spawn_sidecar_ws(&app, &args.id) {
        warn!("new workspace {} sidecar spawn failed: {e}", args.id);
    }
    Ok(())
}

#[tauri::command]
fn set_active_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Err("config not migrated to workspaces yet".to_string()),
    };
    if !file.workspaces.contains_key(&id) {
        return Err(format!("unknown workspace '{id}'"));
    }
    file.active_workspace = id;
    workspace::save(&data_dir, &file)
}

#[tauri::command]
fn set_workspace_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Err("config not migrated to workspaces yet".to_string()),
    };
    {
        let cfg = file
            .workspaces
            .get_mut(&id)
            .ok_or_else(|| format!("unknown workspace '{id}'"))?;
        cfg.enabled = enabled;
    }
    if !enabled && file.active_workspace == id {
        return Err("cannot disable the active workspace — switch first".to_string());
    }
    workspace::save(&data_dir, &file)?;
    if enabled {
        if let Err(e) = spawn_sidecar_ws(&app, &id) {
            warn!("enable {id}: sidecar spawn failed: {e}");
        }
    } else {
        kill_sidecar_ws(&app, &id);
        remove_global_mcp_entries(&app, &id).unwrap_or_else(|e| warn!("uninstall {id}: {e}"));
    }
    Ok(())
}

#[tauri::command]
fn delete_workspace(app: AppHandle, id: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut file = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f,
        _ => return Err("config not migrated to workspaces yet".to_string()),
    };
    if file.active_workspace == id {
        return Err("cannot delete the active workspace — switch first".to_string());
    }
    if file.workspaces.len() == 1 {
        return Err("cannot delete the last workspace".to_string());
    }
    if !file.workspaces.contains_key(&id) {
        return Err(format!("unknown workspace '{id}'"));
    }
    kill_sidecar_ws(&app, &id);
    remove_global_mcp_entries(&app, &id).unwrap_or_else(|e| warn!("uninstall {id}: {e}"));
    for base in [
        "turso_auth_token",
        "mcp_auth_token",
        "google_refresh_token",
        "portuni_session_jwt",
        "portuni_device_token",
    ] {
        keychain_delete_ws(base, &id);
    }
    file.workspaces.remove(&id);
    workspace::save(&data_dir, &file)?;
    // Data dir + mirrors stay on disk by design (spec §5): destructive
    // cleanup is manual only. The UI dialog states what remains.
    Ok(())
}
```

(`remove_global_mcp_entries` dodá Task 7 — v tomto tasku vlož dočasný stub `fn remove_global_mcp_entries(_: &AppHandle, _: &str) -> Result<(), String> { Ok(()) }` s TODO-free komentářem „replaced in the global-installers task", ať crate kompiluje; Task 7 ho nahrazuje.)

Registruj nové commandy v `invoke_handler`.

- [ ] **Step 4: Kompilace + stávající Rust testy**

Run: `cd apps/desktop && cargo test`
Expected: PASS. Run: `cargo clippy --all-targets` — bez nových errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): concurrent per-workspace sidecars, routing by active workspace, lifecycle commands"
```

---

### Task 7: Rust — globální MCP instalace per workspace

**Files:**
- Modify: `apps/desktop/src/lib.rs` (`install_claude_global` ř. 195, `install_codex_global` ř. 225, `install_vibe_global` ř. 257 + nová `remove_global_mcp_entries` nahrazující stub z Task 6)

**Interfaces:**
- Consumes: `mcp_install::{write_claude_config, write_codex_config, write_vibe_config, remove_claude_server, remove_codex_block, remove_vibe_server}` (Task 4), `workspace::{mcp_server_name, token_env_var, is_central}`, `AuthTokens`.
- Produces: `install_*_global` instalují entry pro VŠECHNY enabled workspaces; `remove_global_mcp_entries(app, ws_id)` odstraní entry daného workspace ze všech tří souborů.

- [ ] **Step 1: Přepiš instalátory**

Společný helper:

```rust
// Resolve (name, url, claude_token, token_env) for one workspace's global
// MCP entry. Local mode: loopback URL from the stable config port and the
// literal persisted token (Claude embeds it; Codex/Vibe use env
// indirection). Central mode: {server_url}/mcp and env-reference for all.
fn global_entry_parts(
    app: &AppHandle,
    ws_id: &str,
    cfg: &workspace::WorkspaceConfig,
) -> Result<(String, String, String, String), String> {
    let name = workspace::mcp_server_name(ws_id, cfg);
    let token_env = workspace::token_env_var(ws_id);
    if workspace::is_central(cfg) {
        let server_url = cfg
            .server_url
            .clone()
            .ok_or_else(|| format!("workspace {ws_id}: central mode requires server_url"))?;
        let url = format!("{}/mcp", server_url.trim_end_matches('/'));
        let claude_token = format!("${{{token_env}:-}}");
        Ok((name, url, claude_token, token_env))
    } else {
        let port = cfg
            .mcp_port
            .ok_or_else(|| format!("workspace {ws_id}: no mcp_port assigned"))?;
        let url = format!("http://127.0.0.1:{port}/mcp");
        let token = app
            .state::<AuthTokens>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .get(ws_id)
            .cloned()
            .or_else(|| keychain_get_ws(KEYCHAIN_MCP_ACCOUNT, ws_id))
            .ok_or_else(|| format!("workspace {ws_id}: MCP token unavailable"))?;
        Ok((name, url, token, token_env))
    }
}

fn enabled_workspaces(app: &AppHandle) -> Result<Vec<(String, workspace::WorkspaceConfig)>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => Ok(f
            .workspaces
            .into_iter()
            .filter(|(_, c)| c.enabled)
            .collect()),
        _ => Err("config not migrated to workspaces yet".to_string()),
    }
}
```

Instalátory:

```rust
#[tauri::command]
fn install_claude_global(app: AppHandle) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".claude.json");
    for (ws_id, cfg) in enabled_workspaces(&app)? {
        let (name, url, token, _env) = global_entry_parts(&app, &ws_id, &cfg)?;
        mcp_install::write_claude_config(&path, &name, &url, &token)?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn install_codex_global(app: AppHandle) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".codex").join("config.toml");
    for (ws_id, cfg) in enabled_workspaces(&app)? {
        let (name, url, _token, token_env) = global_entry_parts(&app, &ws_id, &cfg)?;
        mcp_install::write_codex_config(&path, &name, &url, &token_env)?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn install_vibe_global(app: AppHandle) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let path = PathBuf::from(home).join(".vibe").join("config.toml");
    for (ws_id, cfg) in enabled_workspaces(&app)? {
        let (name, url, _token, token_env) = global_entry_parts(&app, &ws_id, &cfg)?;
        mcp_install::write_vibe_config(&path, &name, &url, &token_env)?;
    }
    Ok(path.to_string_lossy().into_owned())
}
```

`remove_global_mcp_entries` (nahrazuje stub z Task 6):

```rust
// Remove one workspace's entries from all three user-scoped agent configs.
// Best-effort per file: a missing file is fine; a parse error propagates.
fn remove_global_mcp_entries(app: &AppHandle, ws_id: &str) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let name = match workspace::load(&data_dir)? {
        workspace::LoadedConfig::V2(f) => f
            .workspaces
            .get(ws_id)
            .map(|c| workspace::mcp_server_name(ws_id, c))
            .unwrap_or_else(|| format!("portuni-{ws_id}")),
        _ => format!("portuni-{ws_id}"),
    };
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let claude = PathBuf::from(&home).join(".claude.json");
    if let Ok(raw) = std::fs::read_to_string(&claude) {
        let next = mcp_install::remove_claude_server(Some(&raw), &name)?;
        std::fs::write(&claude, next).map_err(|e| e.to_string())?;
    }
    let codex = PathBuf::from(&home).join(".codex").join("config.toml");
    if let Ok(raw) = std::fs::read_to_string(&codex) {
        std::fs::write(&codex, mcp_install::remove_codex_block(&raw, &name))
            .map_err(|e| e.to_string())?;
    }
    let vibe = PathBuf::from(&home).join(".vibe").join("config.toml");
    if let Ok(raw) = std::fs::read_to_string(&vibe) {
        let next = mcp_install::remove_vibe_server(&raw, &name)?;
        std::fs::write(&vibe, next).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

`snapshot_mcp_endpoint` už není potřeba — smaž ji (nahrazena `global_entry_parts`).

- [ ] **Step 2: Kompilace + testy**

Run: `cd apps/desktop && cargo test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib.rs
git commit -m "feat(desktop): global MCP installers iterate enabled workspaces, per-entry uninstall"
```

---

### Task 8: Rust — pty injektuje tokeny všech workspaces

**Files:**
- Modify: `apps/desktop/src/pty.rs` (`pty_spawn` env injection blok ř. 285–319)

**Interfaces:**
- Consumes: `crate::{active_workspace, keychain_get_ws, AuthTokens}`, `crate::workspace::{token_env_var, is_central}`, `ensure_device_token(app, ws_id, server_url)` (Task 5), `enabled_workspaces(app)` (Task 7 — změň viditelnost na `pub(crate)`).
- Produces: terminál dostane `PORTUNI_MCP_TOKEN_<ID>` pro každý enabled workspace + `PORTUNI_MCP_TOKEN` = token aktivního.

- [ ] **Step 1: Přepiš injection blok**

Nahraď dnešní blok (`{ let is_central = ...; ... }`) za:

```rust
    // Inject one token env var per enabled workspace, so per-mirror configs
    // (which reference ${PORTUNI_MCP_TOKEN_<ID>:-}) resolve the right
    // credential regardless of which workspace the terminal's cwd belongs
    // to. PORTUNI_MCP_TOKEN keeps carrying the ACTIVE workspace's token for
    // backward compatibility with pre-workspace mirror configs.
    {
        let active_id = crate::active_workspace(&app).map(|(id, _)| id).ok();
        if let Ok(workspaces) = crate::enabled_workspaces(&app) {
            for (ws_id, cfg) in workspaces {
                let token = if crate::workspace::is_central(&cfg) {
                    match cfg.server_url.as_deref() {
                        Some(url) => match ensure_device_token(&app, &ws_id, url) {
                            Ok(t) => Some(t),
                            Err(e) => {
                                warn!("pty_spawn: no device token for workspace {ws_id}: {e}");
                                None
                            }
                        },
                        None => None,
                    }
                } else {
                    app.state::<crate::AuthTokens>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|m| m.get(&ws_id).cloned())
                        .or_else(|| crate::keychain_get_ws("mcp_auth_token", &ws_id))
                };
                if let Some(token) = token {
                    cmd.env(crate::workspace::token_env_var(&ws_id), &token);
                    if active_id.as_deref() == Some(ws_id.as_str()) {
                        cmd.env("PORTUNI_MCP_TOKEN", &token);
                    }
                }
            }
        }
    }
```

- [ ] **Step 2: Kompilace + testy**

Run: `cd apps/desktop && cargo test`
Expected: PASS (spawn_program testy nedotčené).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/pty.rs apps/desktop/src/lib.rs
git commit -m "feat(desktop): terminals carry per-workspace MCP token env vars"
```

---

### Task 9: Rust — per-workspace sidecar log

**Files:**
- Modify: `apps/desktop/src/lib.rs` (stdout/stderr task ve `spawn_sidecar_ws`)

**Interfaces:**
- Produces: `~/Library/Logs/ooo.workflow.portuni/sidecar-<id>.log` — append raw řádků sidecaru daného workspace. Hlavní `sidecar.log` (tauri_plugin_log) zůstává a nese prefixované `sidecar[<id>]:` řádky (z Task 6).

- [ ] **Step 1: Implementace**

Ve `spawn_sidecar_ws` před `tauri::async_runtime::spawn` otevři per-ws log:

```rust
    let ws_log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|d| d.join(format!("sidecar-{ws_id}.log")));
```

V stdout/stderr větvích tasku připiš řádek do souboru (append, best-effort):

```rust
    // uvnitř spawn(async move { ... }) — ws_log_path je moved-in
    fn append_ws_log(path: &Option<std::path::PathBuf>, line: &str) {
        if let Some(p) = path {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                use std::io::Write;
                let _ = writeln!(f, "{line}");
            }
        }
    }
```

(Definuj `append_ws_log` jako volnou fn v lib.rs, ne closure.) Volej `append_ws_log(&ws_log_path, line)` v `Stdout` i `Stderr` větvi.

- [ ] **Step 2: Kompilace**

Run: `cd apps/desktop && cargo test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib.rs
git commit -m "feat(desktop): per-workspace sidecar log files"
```

---

### Task 10: Web — migrace gate, workspace switcher, Settings → Workspaces

**Files:**
- Create: `apps/web/src/lib/workspaces.ts`
- Create: `apps/web/src/components/WorkspaceMigrationGate.tsx`
- Create: `apps/web/src/components/WorkspacesSection.tsx`
- Modify: `apps/web/src/main.tsx` (mount gate), `apps/web/src/components/Sidebar.tsx` (switcher v brand řádku ř. 137–156), `apps/web/src/components/SettingsPage.tsx` (nový sub-tab `workspaces`)

**Interfaces:**
- Consumes (Tauri commandy z Tasks 5–6): `workspace_migration_status() -> boolean`, `migrate_to_workspaces({ id })`, `list_workspaces() -> WorkspaceInfo[]`, `create_workspace({ args })`, `set_active_workspace({ id })`, `set_workspace_enabled({ id, enabled })`, `delete_workspace({ id })`.
- Produces: `apps/web/src/lib/workspaces.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./backend-url";

export interface WorkspaceInfo {
  id: string;
  label: string;
  data_mode: "local" | "central";
  enabled: boolean;
  mcp_port: number | null;
  active: boolean;
  running: boolean;
  mcp_server_name: string;
  workspace_root: string;
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  if (!isTauri()) return [];
  return invoke<WorkspaceInfo[]>("list_workspaces");
}

export async function switchWorkspace(id: string): Promise<void> {
  await invoke("set_active_workspace", { id });
  // Full reload: every cached module-level state (data mode, backend port,
  // graph queries) belongs to the previous workspace.
  window.location.reload();
}

export interface CreateWorkspaceArgs {
  id: string;
  label?: string;
  data_mode: "local" | "central";
  turso_url?: string;
  server_url?: string;
  google_client_id?: string;
  google_client_secret?: string;
  workspace_root: string;
}

export async function createWorkspace(args: CreateWorkspaceArgs): Promise<void> {
  await invoke("create_workspace", { args });
}

export async function setWorkspaceEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke("set_workspace_enabled", { id, enabled });
}

export async function deleteWorkspace(id: string): Promise<void> {
  await invoke("delete_workspace", { id });
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32);
}
```

- [ ] **Step 1: `WorkspaceMigrationGate`**

Vzor = `TursoSetupGate` (stavy, `isTauri()` short-circuit). Mount v `main.tsx` NAD `TursoSetupGate`:

```tsx
// apps/web/src/components/WorkspaceMigrationGate.tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/backend-url";
import { slugify } from "../lib/workspaces";

// One-shot v1 -> v2 config migration dialog. The workspace ID is immutable
// afterwards, so the user must pick it here (prefill "default").
export default function WorkspaceMigrationGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<"checking" | "needed" | "ready">(
    isTauri() ? "checking" : "ready",
  );
  const [name, setName] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    invoke<boolean>("workspace_migration_status")
      .then((needed) => setState(needed ? "needed" : "ready"))
      .catch((e) => {
        setError(String(e));
        setState("needed");
      });
  }, []);

  if (state === "checking") return null;
  if (state === "ready") return <>{children}</>;

  const id = slugify(name);
  const migrate = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("migrate_to_workspaces", { id });
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="setup-gate">
      <div className="setup-card">
        <h2>Pojmenuj svůj workspace</h2>
        <p>
          Portuni nově podporuje více workspaces. Stávající data se přesunou
          pod zvolené jméno — jméno je pak neměnné.
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          autoFocus
        />
        {id !== name && <p className="hint">ID: {id || "(neplatné)"}</p>}
        {error && <p className="error">{error}</p>}
        <button onClick={migrate} disabled={busy || !id}>
          {busy ? "Migruji…" : "Pokračovat"}
        </button>
      </div>
    </div>
  );
}
```

(Třídy `setup-gate`/`setup-card` — použij stejné styly/třídy jako `TursoSetupGate`; pokud se jmenují jinak, převezmi jeho markup.) V `main.tsx`:

```tsx
<WorkspaceMigrationGate>
  <TursoSetupGate>
    <CentralLoginGate>
      <App ... />
    </CentralLoginGate>
  </TursoSetupGate>
</WorkspaceMigrationGate>
```

- [ ] **Step 2: Switcher v Sidebaru**

Do brand řádku `Sidebar.tsx` (ř. 137–156) přidej dropdown: načti `listWorkspaces()` v `useEffect`, zobraz `label` aktivního; `<select>`/menu se zbývajícími; `onChange` → `switchWorkspace(id)`. Když je workspaces ≤ 1 nebo `!isTauri()`, nevykresluj nic (dnešní vzhled beze změny). U neběžícího workspace přidej k labelu ` (nedostupný)` podle `running === false && enabled`.

- [ ] **Step 3: Settings → Workspaces**

`SettingsPage.tsx`: rozšiř `SubTab` o `"workspaces"`, přidej tab tlačítko „Workspaces" a panel `<WorkspacesSection/>`. `WorkspacesSection.tsx`:

- seznam z `listWorkspaces()`: label, ID, režim (local/central), port, stav (`running` → „běží" / „neběží"), badge „aktivní";
- akce per řádek: „Aktivovat" (`switchWorkspace`), u zapnutého neběžícího workspace „Restartovat" (`invoke("restart_sidecar")` po přepnutí na něj, jinak disabled s hintem „přepni se do workspace a zkus restart" — restart_sidecar působí na aktivní), „Vypnout/Zapnout" (`setWorkspaceEnabled` + refresh), „Smazat" (confirm dialog s textem: *„Workspace se odebere z appky, sidecar se zastaví a tokeny se smažou z Keychain. Data na disku (mirror složky a databáze) zůstávají — smaž je ručně, pokud je nechceš."* → `deleteWorkspace` + refresh);
- „Přidat workspace" formulář: jméno (→ `slugify` live náhled ID), režim radio local/central, podle režimu pole `turso_url` NEBO `server_url` + `google_client_id` + `google_client_secret`, `workspace_root` (default `~/Workspaces/<id>`), submit → `createWorkspace` + refresh. Po vytvoření local workspace zobraz hint „Turso token vlož po přepnutí do workspace v Settings" (token flow jede přes existující `TursoSetupGate`/`set_turso_token` na aktivním workspace).

- [ ] **Step 4: Ověření (manuální — web nemá unit testy)**

Run: `varlock run -- npm --prefix apps/web run build`
Expected: build PASS (tsc + vite).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src apps/web/src/components apps/web/src/lib
git commit -m "feat(web): workspace migration gate, sidebar switcher, Settings workspaces section"
```

---

### Task 11: Docs + ruční E2E checklist

**Files:**
- Modify: `CLAUDE.md` (sekce Gotchas — nový odstavec o workspaces)
- Modify: `docs/architecture/data-modes.md` (zmínka multi-workspace: per-workspace data_mode)
- Modify: `docs/env-vars.md` (přidej `PORTUNI_WORKSPACE_ID` + `PORTUNI_MCP_TOKEN_<ID>`)

**Interfaces:** žádné — dokumentace.

- [ ] **Step 1: CLAUDE.md gotcha**

Přidej do Gotchas:

```markdown
- **Multi-workspace desktop**: `config.json` v2 má `workspaces` mapu +
  `active_workspace`; sidecary všech zapnutých workspaces běží souběžně
  (každý vlastní port od 47011, data dir `workspaces/<id>/`, Keychain
  accounty `<base>.<id>`). UI přepíná jen pohled. Per-mirror configy
  referencují token přes `PORTUNI_MCP_TOKEN_<ID>` (server zná své ID z
  `PORTUNI_WORKSPACE_ID`; bez něj — standalone — zůstává
  `PORTUNI_MCP_TOKEN`). Globální MCP entries: `portuni-<id>`, migrovaný
  workspace drží historické `portuni`. Model:
  `docs/superpowers/specs/2026-07-04-desktop-multi-workspace-design.md`.
```

- [ ] **Step 2: env-vars.md + data-modes.md**

`docs/env-vars.md`: řádky pro `PORTUNI_WORKSPACE_ID` (desktop sidecar; řídí jméno token env var v generátorech; default unset = standalone chování) a `PORTUNI_MCP_TOKEN_<ID>` (injektováno do terminálů per workspace). `docs/architecture/data-modes.md`: doplň větu, že `data_mode` je per workspace (jeden desktop může mít central Tempo + local osobní workspace současně).

- [ ] **Step 3: Ruční E2E checklist (proveď a odškrtni)**

1. Build: `npm run build:sidecar && cd apps/desktop && cargo tauri build`; nová appka nad stávajícím config.json → migrační dialog, pojmenuj workspace, appka naběhne s daty beze změny; Keychain Access ukazuje accounty s `.<id>` suffixem; `~/.claude.json` entry `portuni` funguje.
2. Settings → Workspaces → přidat druhý workspace (local, nová Turso DB, root `~/Workspaces/honzapav`); `lsof -nP -iTCP:47012 -sTCP:LISTEN` ukazuje druhý sidecar; oba běží současně.
3. Přepínač v sidebaru: přepnutí zobrazí druhý graf; přepnutí zpět OK; žádný restart procesů (PIDy sidecarů stejné před/po).
4. Mirror ve druhém workspace: `.mcp.json` míří na port 47012 a referencuje `${PORTUNI_MCP_TOKEN_<ID>:-}`; terminál otevřený z appky v tom mirroru má `echo $PORTUNI_MCP_TOKEN_<ID>` neprázdné a `claude` se připojí; totéž při AKTIVNÍM druhém workspace i při aktivním prvním.
5. Session mimo mirror: `~/.claude.json` má entries `portuni` a `portuni-<id2>`, obě se připojí.
6. Vypnutí workspace: sidecar zmizí, entry z `~/.claude.json` zmizí, ostatní entries nedotčené. Smazání: data dir `workspaces/<id>/` a mirror složky zůstaly na disku.
7. Regrese standalone: `npm test` zelené; tmux server (bez `PORTUNI_WORKSPACE_ID`) generuje per-mirror configy s `PORTUNI_MCP_TOKEN` beze změny.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/env-vars.md docs/architecture/data-modes.md
git commit -m "docs: multi-workspace desktop model, env vars, e2e checklist"
```

---

## Poznámky pro implementátora

- **Pořadí tasků je závazné**: 1–2 (TS, nezávislé) → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Tasky 1–2 lze dělat paralelně s 3–4.
- **Crate musí kompilovat na konci každého tasku** — Tasks 4–8 mění signatury napříč soubory; každý task explicitně říká, jak dotčené volající minimálně opravit.
- **Nulová regrese standalone serveru** je testovaná v Task 1 (výstup bez `PORTUNI_WORKSPACE_ID` bajtově shodný) a hlídaná celou stávající TS suitou (`npm test`).
- Migrace je jediná cesta z v1 na v2 — žádný kód nesmí v2 soubor vytvořit „mimochodem" z v1 (výjimka: fresh install bez configu, kde `save_config` zakládá rovnou v2 s workspace `default`).
