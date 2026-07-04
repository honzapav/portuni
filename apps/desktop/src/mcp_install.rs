// Pure functions for writing Portuni's MCP server entry into the
// user-scoped configs that Claude Code (~/.claude.json) and Codex
// (~/.codex/config.toml) read at startup. Pure on purpose: the actual
// Tauri commands in lib.rs handle path resolution + I/O so unit tests
// here can run without a Tauri runtime.

use serde_json::{json, Value};
use std::path::Path;

/// Inserts or replaces `mcpServers.<name>` in the JSON document at the
/// provided text. Returns the serialized JSON to write back. Preserves
/// every other key in the file untouched.
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

/// Removes `mcpServers.<name>` from the JSON document, leaving everything
/// else untouched. A missing/empty document round-trips to `{}`.
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

/// Read-modify-write wrapper around `upsert_claude_config`. Creates the
/// parent directory if needed.
pub fn write_claude_config(
    claude_json: &Path,
    name: &str,
    url: &str,
    token: &str,
) -> Result<(), String> {
    let existing = std::fs::read_to_string(claude_json).ok();
    let next = upsert_claude_config(existing.as_deref(), name, url, token)?;
    if let Some(parent) = claude_json.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(claude_json, next).map_err(|e| e.to_string())
}

/// Marker comment that identifies a Portuni-managed [mcp_servers.<name>]
/// block inside ~/.codex/config.toml so future edits can detect a
/// hand-edited user file and refuse to clobber it.
fn codex_marker(name: &str) -> String {
    format!("# portuni-managed: mcp_servers.{name}")
}

/// Inserts or replaces the [mcp_servers.<name>] block in a Codex
/// config.toml document. Operates on the raw text so we don't need a
/// TOML parser dependency: the block is always emitted between the
/// marker comment and the next blank line, making it cheap to find and
/// replace without tripping over the rest of the file.
///
/// `token_env` is the name of the environment variable Codex reads at
/// runtime to obtain the Portuni MCP bearer token — Codex's
/// streamable_http transport refuses a literal `bearer_token` field (it
/// fails the entire config load with "not supported for
/// streamable_http"); only `bearer_token_env_var` is accepted. The user
/// must export that var in their shell rc, or run codex from a session
/// Portuni itself spawned (which inherits the var from the Portuni host
/// process).
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

    // Match the marker as a complete line (marker + newline): the marker
    // for "portuni" is a string prefix of the marker for
    // "portuni-honzapav", so a plain substring search would find (and
    // clobber) the wrong block. Every emitted block writes the marker
    // followed by a newline, so anchoring on the trailing \n is safe.
    let marker_line = format!("{marker}\n");
    if let Some(start) = body.find(&marker_line) {
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

/// Remove the managed block for `name`. Text outside the block is preserved.
pub fn remove_codex_block(existing: &str, name: &str) -> String {
    let marker = codex_marker(name);
    // Full-line match — see upsert_codex_config for why a plain substring
    // search would hit a longer prefixed name's block.
    let marker_line = format!("{marker}\n");
    let Some(start) = existing.find(&marker_line) else {
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

pub fn write_codex_config(
    toml_path: &Path,
    name: &str,
    url: &str,
    token_env: &str,
) -> Result<(), String> {
    let existing = std::fs::read_to_string(toml_path).ok();
    let next = upsert_codex_config(existing.as_deref(), name, url, token_env)?;
    if let Some(parent) = toml_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(toml_path, next).map_err(|e| e.to_string())
}

/// Inserts or replaces the Portuni MCP entry in a Mistral Vibe
/// config.toml. Vibe stores MCP servers as a value array
/// (`mcp_servers = [ { name = "...", ... } ]`), NOT [[mcp_servers]]
/// blocks — its default config writes the empty `mcp_servers = []`. Naive
/// text appending of an [[mcp_servers]] block would therefore produce a
/// duplicate-key TOML error and Vibe would refuse to load its whole
/// config. We use toml_edit to push our inline table into the existing
/// array, de-duplicating by `name == name` so re-running the installer is
/// idempotent and never clobbers the user's other servers or the rest of
/// the (large, default) config.
///
/// `token_env` is the name of the environment variable Vibe resolves the
/// token from at runtime via `api_key_env` — the literal token value is
/// never written to the file.
pub fn upsert_vibe_config(
    existing: Option<&str>,
    name: &str,
    url: &str,
    token_env: &str,
) -> Result<String, String> {
    use toml_edit::{Array, DocumentMut, InlineTable, Item, Value};

    let mut doc: DocumentMut = match existing {
        Some(raw) if !raw.trim().is_empty() => raw
            .parse()
            .map_err(|e| format!("invalid TOML in ~/.vibe/config.toml: {e}"))?,
        _ => DocumentMut::new(),
    };

    let mut entry = InlineTable::new();
    entry.insert("name", Value::from(name));
    entry.insert("transport", Value::from("streamable-http"));
    entry.insert("url", Value::from(url));
    entry.insert("api_key_env", Value::from(token_env));
    entry.insert("api_key_header", Value::from("Authorization"));
    entry.insert("api_key_format", Value::from("Bearer {token}"));

    let item = doc
        .as_table_mut()
        .entry("mcp_servers")
        .or_insert(Item::Value(Value::Array(Array::new())));
    let arr = match item {
        Item::Value(Value::Array(a)) => a,
        // Empty/None slot we just inserted resolves to the arm above; any
        // other shape means the user has mcp_servers as [[table]] blocks
        // or a scalar — refuse rather than silently corrupt their config.
        _ => {
            return Err(
                "~/.vibe/config.toml has mcp_servers in an unexpected form (expected an array); \
                 refusing to edit automatically — add the Portuni server manually"
                    .to_string(),
            )
        }
    };

    // Drop any prior entry with the same name so re-installs don't
    // accumulate.
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
    arr.push(entry);

    Ok(doc.to_string())
}

/// Removes the named entry from the Vibe `mcp_servers` array. Other
/// entries and top-level keys are preserved untouched.
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

pub fn write_vibe_config(
    toml_path: &Path,
    name: &str,
    url: &str,
    token_env: &str,
) -> Result<(), String> {
    let existing = std::fs::read_to_string(toml_path).ok();
    let next = upsert_vibe_config(existing.as_deref(), name, url, token_env)?;
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
        let out = upsert_claude_config(None, "portuni", "http://127.0.0.1:47011/mcp", "abc").unwrap();
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
        let out = upsert_claude_config(Some(existing), "portuni", "http://x/mcp", "tok").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark");
        assert!(v["mcpServers"]["other"].is_object());
        assert_eq!(v["mcpServers"]["portuni"]["url"], "http://x/mcp");
    }

    #[test]
    fn replaces_existing_portuni_entry() {
        let existing = r#"{"mcpServers":{"portuni":{"type":"http","url":"http://old/mcp","headers":{"Authorization":"Bearer old"}}}}"#;
        let out = upsert_claude_config(Some(existing), "portuni", "http://new/mcp", "new").unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["mcpServers"]["portuni"]["url"], "http://new/mcp");
        assert_eq!(
            v["mcpServers"]["portuni"]["headers"]["Authorization"],
            "Bearer new"
        );
    }

    #[test]
    fn rejects_non_object_root() {
        let err = upsert_claude_config(Some("[1,2,3]"), "portuni", "x", "y").unwrap_err();
        assert!(err.contains("root is not a JSON object"), "{err}");
    }

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
}

#[cfg(test)]
mod codex_tests {
    use super::*;

    #[test]
    fn writes_block_to_empty_file() {
        let out = upsert_codex_config(None, "portuni", "http://127.0.0.1:47011/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        assert!(out.contains(&codex_marker("portuni")));
        assert!(out.contains("[mcp_servers.portuni]"));
        assert!(out.contains("url = \"http://127.0.0.1:47011/mcp\""));
        // Codex rejects literal bearer_token for streamable_http (fails
        // the whole config load). Must be env-var indirection.
        assert!(out.contains("bearer_token_env_var = \"PORTUNI_MCP_TOKEN\""));
        assert!(!out.contains("bearer_token = "));
    }

    #[test]
    fn appends_block_preserving_other_sections() {
        let existing = "[other]\nfoo = 1\n";
        let out = upsert_codex_config(Some(existing), "portuni", "http://x/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        assert!(out.contains("[other]"));
        assert!(out.contains("foo = 1"));
        assert!(out.contains("[mcp_servers.portuni]"));
    }

    #[test]
    fn replaces_existing_managed_block_idempotently() {
        let first = upsert_codex_config(None, "portuni", "http://old/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        let second = upsert_codex_config(Some(&first), "portuni", "http://new/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        assert!(second.contains("http://new/mcp"));
        assert!(!second.contains("http://old/mcp"));
        // Marker must remain exactly once.
        assert_eq!(second.matches(&codex_marker("portuni")).count(), 1);
    }

    #[test]
    fn short_name_ops_do_not_touch_longer_prefixed_block() {
        let long = upsert_codex_config(None, "portuni-honzapav", "http://y/mcp", "PORTUNI_MCP_TOKEN_HONZAPAV").unwrap();
        // Upserting the SHORT name must append a new block, not corrupt the
        // long one ("portuni" marker is a string prefix of the
        // "portuni-honzapav" marker).
        let both = upsert_codex_config(Some(&long), "portuni", "http://x/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        assert!(both.contains("[mcp_servers.portuni-honzapav]"));
        assert!(both.contains("url = \"http://y/mcp\""));
        assert!(both.contains("[mcp_servers.portuni]\n"));
        // Removing the SHORT name must leave the long block intact.
        let removed = remove_codex_block(&both, "portuni");
        assert!(removed.contains("[mcp_servers.portuni-honzapav]"));
        assert!(!removed.contains("[mcp_servers.portuni]\n"));
    }

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
}

#[cfg(test)]
mod vibe_tests {
    use super::*;
    use toml_edit::{DocumentMut, Value};

    // Helper: parse output and return the mcp_servers array entries with
    // the given name.
    fn named_entries(out: &str, name: &str) -> Vec<toml_edit::InlineTable> {
        let doc: DocumentMut = out.parse().expect("output must be valid TOML");
        let arr = doc["mcp_servers"].as_array().expect("mcp_servers is array");
        arr.iter()
            .filter_map(Value::as_inline_table)
            .filter(|t| t.get("name").and_then(Value::as_str) == Some(name))
            .cloned()
            .collect()
    }

    #[test]
    fn writes_valid_toml_into_empty_file() {
        let out = upsert_vibe_config(None, "portuni", "http://127.0.0.1:47011/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        let entries = named_entries(&out, "portuni");
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.get("transport").and_then(Value::as_str), Some("streamable-http"));
        assert_eq!(e.get("url").and_then(Value::as_str), Some("http://127.0.0.1:47011/mcp"));
        assert_eq!(e.get("api_key_env").and_then(Value::as_str), Some("PORTUNI_MCP_TOKEN"));
        assert_eq!(e.get("api_key_format").and_then(Value::as_str), Some("Bearer {token}"));
    }

    #[test]
    fn merges_into_existing_empty_array_preserving_other_keys() {
        // Mirrors Vibe's real default: lots of keys plus `mcp_servers = []`.
        let existing = "active_model = \"mistral-medium-3.5\"\nmcp_servers = []\n\n[project_context]\ndefault_commit_count = 5\n";
        let out = upsert_vibe_config(Some(existing), "portuni", "http://x/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        assert_eq!(named_entries(&out, "portuni").len(), 1);
        let doc: DocumentMut = out.parse().unwrap();
        assert_eq!(doc["active_model"].as_str(), Some("mistral-medium-3.5"));
        assert!(doc.get("project_context").is_some());
    }

    #[test]
    fn reinstall_is_idempotent() {
        let first = upsert_vibe_config(Some("mcp_servers = []\n"), "portuni", "http://old/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        let second = upsert_vibe_config(Some(&first), "portuni", "http://new/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        let entries = named_entries(&second, "portuni");
        assert_eq!(entries.len(), 1, "no duplicate portuni entries");
        assert_eq!(entries[0].get("url").and_then(Value::as_str), Some("http://new/mcp"));
        assert!(!second.contains("http://old/mcp"));
    }

    #[test]
    fn preserves_user_other_servers() {
        let existing = "mcp_servers = [{ name = \"mine\", transport = \"stdio\", command = \"x\" }]\n";
        let out = upsert_vibe_config(Some(existing), "portuni", "http://new/mcp", "PORTUNI_MCP_TOKEN").unwrap();
        let doc: DocumentMut = out.parse().unwrap();
        let arr = doc["mcp_servers"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "user server kept, portuni added");
        assert_eq!(named_entries(&out, "portuni").len(), 1);
        // The user's own server survives untouched.
        let names: Vec<_> = arr
            .iter()
            .filter_map(Value::as_inline_table)
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .collect();
        assert!(names.contains(&"mine"));
    }

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
}
