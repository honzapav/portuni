---
title: Scope Enforcement
description: How a session's reach is bounded – what an agent can read and where it can write.
---

:::note[Phase A & B implemented]
Read-scope enforcement (Phase A: session scope set, scope modes, expansion audit) and filesystem write-scope config generation (Phase B: per-harness configs, `/scope` endpoint, `portuni-guard` hook) are now in code. Phase C polish – session-close summary, harness-mode detection – is incremental. See `docs/superpowers/specs/2026-04-24-scope-model.md` for the full design.
:::

A Portuni session always has two boundaries: what files the agent can write to, and what nodes it can read from. Without bounds, the agent in a "Goldea Presale" project session can edit files in a sibling process mirror, or list every project across every organization the user can see. Neither is the intended behavior.

The scope model adds two enforceable, complementary mechanisms – one for filesystem writes, one for graph reads – both anchored on the same idea: the **session home node**.

## Session home node

Every session has a **home node** – the node whose registered local mirror contains the agent's `cwd`. This anchor is what scope enforcement, deny lists, and soft hints all reference.

The home node id is bound to the session at connect time. Each mirror's `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex) carries the URL `http://<host>:<port>/mcp?home_node_id=<id>` – `portuni_mirror` writes the id when the mirror is created or regenerated. When the harness opens an MCP session against that URL, the Portuni server reads the query param and **auto-seeds** the read scope with the home node + its depth-1 neighbors. No hook, no `portuni_session_init` call, no harness-specific glue – any MCP client gets a usable scope on the first tool call.

Connections without the query param (legacy mirrors, ad-hoc clients) see an empty scope until they call `portuni_session_init` explicitly. That tool stays as the manual fallback.

Everything else in this page is built on top of this single anchor.

## Filesystem write scope – three tiers

Writes divide into three concentric zones, each with different default behavior:

```
+---------------------------------------------------------------+
| Tier 3 – Outside PORTUNI_ROOT                                 |
| e.g. ~/Desktop, ~/.ssh, /tmp, unrelated repos                 |
| -> HARD FLOOR: always ask, no exceptions                      |
+---------------------------------------------------------------+
       ^
       |
+------+--------------------------------------------------------+
| PORTUNI_ROOT (e.g. ~/Dev/projekty/)                           |
|  +----------------------------------------------------------+ |
|  | Tier 2 – Inside PORTUNI_ROOT, outside current mirror      | |
|  | e.g. session home is workflow/projects/goldea-presale/,  | |
|  |      target is workflow/processes/partner-account-mgmt/  | |
|  | -> DENY by default; bypass with explicit confirmation    | |
|  +----------------------------------------------------------+ |
|  +----------------------------------------------------------+ |
|  | Tier 1 – Current mirror                                   | |
|  | e.g. workflow/projects/goldea-presale/**                  | |
|  | -> FREE WRITE                                             | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+
```

`PORTUNI_ROOT` is a single environment variable that names the directory containing every Portuni mirror on the machine. It defaults to the nearest common ancestor of all registered mirrors.

### How it's enforced

Portuni does **not** intercept filesystem operations at runtime – cross-harness interception is fragile and easy to bypass. Instead, when a mirror is created or renamed, Portuni writes per-harness configuration into `local_path`, layering on top of user-owned files (never replacing them):

- **`.claude/settings.local.json`** – an overlay file Claude Code merges on top of `settings.json`. Portuni owns this file completely, so it can be regenerated safely on every call. Three things in one file:
  - `permissions.allow` for the current mirror and `permissions.deny` for every other mirror in the registry. No synthetic tier-3 negation – Claude Code's permission grammar is plain glob, so tier-3 enforcement is delegated to the `portuni-guard` PreToolUse hook (next bullet).
  - `hooks.PreToolUse` auto-wired to `scripts/portuni-guard.sh` (matcher: `Edit|Write|NotebookEdit|MultiEdit`). Resolved from `PORTUNI_GUARD_SCRIPT` env or relative to the Portuni install. The hook block is omitted when the script can't be located.
  - `portuni_managed` marker so the file is recognisable as auto-generated.
- **`.mcp.json`** – Claude Code project-scoped MCP server registration (`mcpServers.portuni`). The user is prompted once on first session whether to trust the server; afterwards every session inside this mirror connects to the local Portuni server automatically. Bearer auth header is embedded only when `PORTUNI_AUTH_TOKEN` is set on the Portuni server's environment at the time `portuni_mirror` ran. **Gitignore this file if you embed an auth token.**
- **`.codex/config.toml`** – two blocks under one Portuni-managed marker:
  - `[sandbox_workspace_write]` with `writable_roots = [<this mirror>]`. Codex's Seatbelt / Landlock enforces this at the kernel level.
  - `[mcp_servers.portuni]` with `type = "http"`, `url = <PORTUNI_URL>/mcp`, optional bearer headers. Codex CLI auto-connects.

  Portuni writes this file only when it is missing or already carries the Portuni marker comment; a hand-edited Codex config is preserved.
- **`PORTUNI_SCOPE.md`, `.cursor/rules`** – plain-text rules so the agent has the same picture even if the harness config is missing.
- **`CLAUDE.md` / `AGENTS.md`** – refreshed only if they already exist, between BEGIN/END `portuni-scope` markers. User content outside the markers is preserved.

When the registry changes (mirror added, removed, or renamed), every affected mirror's config is regenerated. Result of every regen:

- write-scope deny lists pick up the new sibling mirrors,
- guard hook + MCP server config stay aligned with the running Portuni instance,
- soft hints reflect the up-to-date mirror layout.

### Configuration that drives the generated files

`portuni_mirror` reads these at the moment it materialises a mirror's config; nothing is hard-coded. Set them on the Portuni server's environment.

| Variable | What it controls | Default |
|----------|------------------|---------|
| `PORTUNI_ROOT` | Tier 1/2 boundary. The directory containing every Portuni mirror on this machine. | Nearest common ancestor of every registered mirror |
| `PORTUNI_GUARD_SCRIPT` | Absolute path of `portuni-guard.sh` written into `.claude/settings.local.json` as the PreToolUse hook command. | Resolved relative to the Portuni install (`scripts/portuni-guard.sh`) |
| `PORTUNI_URL` | MCP server base URL written into `.mcp.json` and `.codex/config.toml`. The `/mcp` suffix is appended if missing. | `http://${HOST}:${PORT}/mcp`, defaulting to `http://127.0.0.1:4011/mcp` |
| `PORTUNI_AUTH_TOKEN` | Bearer token embedded in MCP `Authorization` headers. When set, `.mcp.json` should be gitignored. | unset (no headers emitted) |
| `PORTUNI_SCOPE_MODE` | Read-scope elicitation strictness (`strict` / `balanced` / `permissive`). | `strict` |

### Backstop hook

A `PreToolUse` hook (`portuni-guard.sh`) is shipped optionally. When installed, it queries Portuni's `/scope` endpoint before every `Edit`, `Write`, `NotebookEdit`, or `MultiEdit` and returns one of:

- Tier 1 -> exit 0 (allow silently)
- Tier 2 -> exit 2 with "target is in sibling mirror `<name>`; run from that mirror or confirm the cross-mirror write"
- Tier 3 -> exit 2 with "target is outside `PORTUNI_ROOT`; confirm the write is intended"

Behaviour at the edges is deliberate:

- A write tool with no recoverable target path **fails closed** (exit 2). The hook would rather block than allow a write it cannot classify.
- A non-write tool always allows.
- A malformed JSON payload allows (we cannot tell what the harness wanted).
- An unreachable Portuni server allows. The guard is a soft fallback, not the primary defense; the harness's own permission system is.

This catches drift in the declarative config, harness bugs, and cases where the config was never written.

### What this doesn't cover

- Writes inside the current mirror that aren't part of the node's artifacts (the user's own scratch files that happen to live there). Scope is directory-based, not artifact-based.
- Writes via `Bash` commands that bypass the harness's file tools. Some shell tricks slip past Seatbelt and Landlock; neither sandbox is complete.
- Hard isolation. For high-stakes work (contractor access, sensitive client data), the recommended path is Dagger Container Use – one container per node, no path escape by construction. Portuni doesn't ship that; it points at it.

## Read scope – session scope set

Graph reads are bounded by a **session scope set** – the set of node IDs the agent is allowed to fetch in this session. Initially narrow, expanded only by explicit, audited actions.

### Initial scope set

At session start, if the MCP URL carries `?home_node_id=<id>` (which `portuni_mirror`-generated configs always do), the server auto-seeds the scope set with:

1. The session home node.
2. Every node directly connected to it by an edge (depth 1, both directions).

The seed runs as part of session initialization, before the agent's first tool call, and is logged as an audit entry with `triggered_by: "init"`.

Without a `home_node_id` query param (legacy mirror config or ad-hoc client), the scope set starts empty. The agent must call `portuni_session_init` or `portuni_expand_scope` to populate it.

### Three ways to expand

| Path | Trigger | User confirmation |
|------|---------|-------------------|
| User-initiated pull | User names a node in the prompt ("look at project Evoluce") | Not needed – the user already asked |
| Agent-initiated expansion | Agent calls a read tool with an out-of-scope node | Required – server elicits confirmation via MCP |
| Connection-following | Agent walks an edge from an in-scope node | Allowed if the neighbor is within depth 1 of any in-scope node |

Every expansion is logged to the audit trail with the reason (the user's quoted phrase, or the agent's stated rationale).

## Why this is its own page (and not a permission system)

Scope is **orthogonal** to permissions. Permissions (visibility, Google Groups membership) decide what a user is allowed to see at all. Scope decides what an in-progress session is currently focused on – a second, intentionality-shaped filter applied on top of permissions.

A user with read access to every node in their org still gets a narrow scope set when they start a session in one project. The agent isn't omniscient by default; it's focused, and expansion is auditable.

## Scope modes

`PORTUNI_SCOPE_MODE` controls how aggressively scope expansion is gated:

| Mode | Behavior |
|------|----------|
| `strict` (default) | Every agent-initiated reach for an out-of-scope node elicits user confirmation. Safe default. |
| `balanced` | First reach for a given node per session elicits; subsequent reads of the same node pass silently. Reduces prompt fatigue while still surfacing each new node once. |
| `permissive` | No elicitation. Expansions auto-approved, audited, surfaced in `portuni_session_log`. Pairs well with harness auto mode. |

Hard floors override mode. A node with `meta.scope_sensitive: true`, or a `visibility: private` node owned by another user, always elicits – even in `permissive`.

## MCP tools

| Tool | Purpose |
|------|---------|
| `portuni_session_init(home_node_id)` | Manual fallback. Auto-seed normally runs on connect when the URL carries `?home_node_id=…`; this tool only exists for clients connecting without that param. Seeds the scope set with the home node + its depth-1 neighbors. |
| `portuni_expand_scope(node_ids, reason, triggered_by, confirmed_hard_floor?)` | Add nodes to scope. Always audited. Hard-floor nodes (private-other, `meta.scope_sensitive`) require both `confirmed_hard_floor=true` AND a real user confirmation; a refusal entry is logged otherwise. |
| `portuni_session_log()` | Returns the current scope set, mode, expansion history. |
| `portuni_get_node` | Out-of-scope target returns `{"error":"scope_expansion_required",...}`. Name lookups are filtered to in-scope candidates first, so name probing cannot leak metadata. |
| `portuni_get_context` | Start node must be in scope. Depth ≤ 1 is the natural read; depth ≥ 2 is treated as breadth expansion and refused in strict/balanced. |
| `portuni_list_nodes` / `portuni_list_events` / `portuni_list_files` | Default to session scope. Global form (`scope: "global"` on `list_nodes`, no `node_id` on the others) is mode-gated: strict refuses, balanced refuses on first call, permissive auto-allows + audits. |

### REST surface (out of scope)

The HTTP REST endpoints (`/graph`, `/context`, `/nodes/:id/sync-status`, `/users`, `/actors`, etc.) are intended for the local desktop UI, not for agent-driven access. They are NOT subject to the read-scope set – the UI runs as the same human user the scope model is meant to assist, and gating it would defeat its purpose. Agent-facing access goes through the MCP tools listed above; that's the surface scope enforcement covers.

## Implementation status

| Piece | Status |
|-------|--------|
| Spec | Written – `docs/superpowers/specs/2026-04-24-scope-model.md` |
| URL-based auto-seed on MCP connect (`?home_node_id=…`) | Implemented |
| Session home node detection (`portuni_session_init`) | Implemented (manual fallback) |
| Read-scope set + per-MCP-connection state | Implemented |
| `portuni_expand_scope`, `portuni_session_log` | Implemented |
| Hard-floor enforcement in `expand_scope` (refuses without `confirmed_hard_floor`) | Implemented |
| Read tools gated by scope: `get_node`, `get_context`, `list_nodes`, `list_events`, `list_files` | Implemented |
| `get_node(name)` ambiguity filtered to in-scope candidates | Implemented |
| `get_context(depth ≥ 2)` treated as breadth expansion | Implemented |
| Mode-gated global queries (strict refuses, balanced first-time refuses, permissive auto-allow + audit) | Implemented |
| `PORTUNI_SCOPE_MODE` (strict / balanced / permissive) | Implemented |
| Per-harness write-scope config on `portuni_mirror` | Implemented |
| Settings overlay strategy (`.claude/settings.local.json`, codex marker-aware) | Implemented |
| Auto-wire `portuni-guard` as `PreToolUse` hook in generated Claude settings | Implemented |
| `.mcp.json` for Claude Code project-scoped MCP registration | Implemented |
| `[mcp_servers.portuni]` block in generated Codex `config.toml` | Implemented |
| Sibling regen on mirror add | Implemented |
| `/scope` endpoint + `portuni-guard` PreToolUse hook (fail-closed on missing target) | Implemented |
| Audit entries: `expand_scope`, `scope_global_query`, `scope_hard_floor_refusal`, `session_init` | Implemented |
| Session-close summary | Pending |
| Other harnesses (Gemini CLI, Cline, Continue, Aider, Windsurf, Roo) | Out of scope until requested |
| Harness-mode -> scope-mode auto-alignment | Pending (intentionally fragile, may not ship) |
