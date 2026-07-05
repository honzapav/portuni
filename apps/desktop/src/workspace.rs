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

/// The MCP token a spawned terminal must inject for a workspace's
/// `PORTUNI_MCP_TOKEN_<ID>` env var.
///
/// After the agent-mode MCP front-door change the materialized `.mcp.json`
/// for a central-mode (agent) workspace points at the LOCAL sidecar, whose
/// gate authenticates with the per-launch `PORTUNI_AUTH_TOKEN` (the same
/// value cached in `AuthTokens` and used by the webview proxy). So agent-mode
/// terminals must carry that local token, NOT the central device token —
/// otherwise the local gate returns 401. Local-mode terminals already used
/// the local token; both modes now resolve to it. `is_central` is kept as an
/// explicit parameter so the invariant (mode does not change the answer) is
/// testable and regression-proof.
pub(crate) fn terminal_mcp_token(
    _is_central: bool,
    local_token: Option<String>,
) -> Option<String> {
    local_token
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
    fn terminal_mcp_token_is_local_for_both_modes() {
        // Regression: agent-mode (central) terminals must carry the LOCAL
        // sidecar launch token, never the central device token — the local
        // .mcp.json gate authenticates with PORTUNI_AUTH_TOKEN, so a device
        // (ptk_) token would 401.
        let local = "local-launch-token".to_string();
        assert_eq!(
            terminal_mcp_token(true, Some(local.clone())),
            Some(local.clone()),
            "central-mode must inject the sidecar launch token"
        );
        assert_eq!(
            terminal_mcp_token(false, Some(local.clone())),
            Some(local),
            "local-mode keeps injecting the sidecar launch token"
        );
        // No local token available -> nothing injected (no fallback to a
        // device token).
        assert_eq!(terminal_mcp_token(true, None), None);
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
