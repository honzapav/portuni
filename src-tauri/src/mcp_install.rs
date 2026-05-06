// Pure functions for writing Portuni's MCP server entry into the
// user-scoped configs that Claude Code (~/.claude.json) and Codex
// (~/.codex/config.toml) read at startup. Pure on purpose: the actual
// Tauri commands in lib.rs handle path resolution + I/O so unit tests
// here can run without a Tauri runtime.

use serde_json::{json, Value};
use std::path::Path;

/// Inserts or replaces `mcpServers.portuni` in the JSON document at the
/// provided text. Returns the serialized JSON to write back. Preserves
/// every other key in the file untouched.
pub fn upsert_claude_config(
    existing: Option<&str>,
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
        "portuni".to_string(),
        json!({
            "type": "http",
            "url": url,
            "headers": { "Authorization": format!("Bearer {token}") },
        }),
    );
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Read-modify-write wrapper around `upsert_claude_config`. Creates the
/// parent directory if needed.
pub fn write_claude_config(claude_json: &Path, url: &str, token: &str) -> Result<(), String> {
    let existing = std::fs::read_to_string(claude_json).ok();
    let next = upsert_claude_config(existing.as_deref(), url, token)?;
    if let Some(parent) = claude_json.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(claude_json, next).map_err(|e| e.to_string())
}

/// Marker comment that identifies a Portuni-managed [mcp_servers.portuni]
/// block inside ~/.codex/config.toml so future edits can detect a
/// hand-edited user file and refuse to clobber it.
const CODEX_MARKER: &str = "# portuni-managed: mcp_servers.portuni";

/// Inserts or replaces the [mcp_servers.portuni] block in a Codex
/// config.toml document. Operates on the raw text so we don't need a
/// TOML parser dependency: the block is always emitted between the
/// marker comment and the next blank line, making it cheap to find and
/// replace without tripping over the rest of the file.
pub fn upsert_codex_config(existing: Option<&str>, url: &str, token: &str) -> Result<String, String> {
    let block = format!(
        "{CODEX_MARKER}\n[mcp_servers.portuni]\nurl = \"{url}\"\nbearer_token = \"{token}\"\n"
    );

    let body = match existing {
        Some(raw) if !raw.trim().is_empty() => raw,
        _ => return Ok(block),
    };

    if let Some(start) = body.find(CODEX_MARKER) {
        // Find the end of the block: next blank line, or EOF.
        let after = &body[start..];
        let end_offset = after
            .find("\n\n")
            .map(|n| start + n + 2)
            .unwrap_or(body.len());
        let mut out = String::with_capacity(body.len() + block.len());
        out.push_str(&body[..start]);
        out.push_str(&block);
        if end_offset < body.len() {
            // Preserve remaining content; ensure exactly one blank line
            // between our block and what follows.
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

    // No prior Portuni block — append after the existing content with one
    // blank-line separator.
    let mut out = body.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push('\n');
    out.push_str(&block);
    Ok(out)
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
mod claude_tests {
    use super::*;

    #[test]
    fn upserts_into_empty_file() {
        let out = upsert_claude_config(None, "http://127.0.0.1:47011/mcp", "abc").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["portuni"]["url"], "http://127.0.0.1:47011/mcp");
        assert_eq!(
            v["mcpServers"]["portuni"]["headers"]["Authorization"],
            "Bearer abc"
        );
    }

    #[test]
    fn preserves_other_servers_and_top_level_keys() {
        let existing = r#"{"theme":"dark","mcpServers":{"other":{"type":"stdio","command":"x"}}}"#;
        let out = upsert_claude_config(Some(existing), "http://x/mcp", "tok").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert!(v["mcpServers"]["other"].is_object());
        assert_eq!(v["mcpServers"]["portuni"]["url"], "http://x/mcp");
    }

    #[test]
    fn replaces_existing_portuni_entry() {
        let existing = r#"{"mcpServers":{"portuni":{"type":"http","url":"http://old/mcp","headers":{"Authorization":"Bearer old"}}}}"#;
        let out = upsert_claude_config(Some(existing), "http://new/mcp", "new").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["portuni"]["url"], "http://new/mcp");
        assert_eq!(
            v["mcpServers"]["portuni"]["headers"]["Authorization"],
            "Bearer new"
        );
    }

    #[test]
    fn rejects_non_object_root() {
        let err = upsert_claude_config(Some("[1,2,3]"), "x", "y").unwrap_err();
        assert!(err.contains("root is not a JSON object"), "{err}");
    }
}

#[cfg(test)]
mod codex_tests {
    use super::*;

    #[test]
    fn writes_block_to_empty_file() {
        let out = upsert_codex_config(None, "http://127.0.0.1:47011/mcp", "tok").unwrap();
        assert!(out.contains(CODEX_MARKER));
        assert!(out.contains("[mcp_servers.portuni]"));
        assert!(out.contains("url = \"http://127.0.0.1:47011/mcp\""));
        assert!(out.contains("bearer_token = \"tok\""));
    }

    #[test]
    fn appends_block_preserving_other_sections() {
        let existing = "[other]\nfoo = 1\n";
        let out = upsert_codex_config(Some(existing), "http://x/mcp", "tok").unwrap();
        assert!(out.contains("[other]"));
        assert!(out.contains("foo = 1"));
        assert!(out.contains("[mcp_servers.portuni]"));
    }

    #[test]
    fn replaces_existing_managed_block_idempotently() {
        let first = upsert_codex_config(None, "http://old/mcp", "old").unwrap();
        let second = upsert_codex_config(Some(&first), "http://new/mcp", "new").unwrap();
        assert!(second.contains("http://new/mcp"));
        assert!(!second.contains("http://old/mcp"));
        assert!(!second.contains("\"old\""));
        // Marker must remain exactly once.
        assert_eq!(second.matches(CODEX_MARKER).count(), 1);
    }
}
