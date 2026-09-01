---
title: Scope
description: Tools for managing the per-session read-scope set (session init, expansion, audit log).
---

Every MCP session carries a read-scope set — the explicit list of node IDs the agent is allowed to read in this session. Reads of nodes outside the set return `{error: scope_expansion_required, ...}` until the user authorises expansion (or, for a client that declares the MCP `elicitation` capability, confirms a real dialog). See [Scope Enforcement](/concepts/scope-enforcement/) for the conceptual model, including session types and how the separate write-scope set is gated.

The scope set is normally seeded automatically when an MCP client opens the session with `?home_node_id=<id>` in the URL. `portuni_mirror` materializes that URL into every mirror's `.mcp.json` (Claude Code) and `.vibe/config.toml` (Mistral Vibe); it also writes `.claude/settings.local.json`, `.codex/config.toml` (sandbox config only — the Codex MCP connection lives in the user-scoped `~/.codex/config.toml`), `.cursor/rules`, `PORTUNI_SCOPE.md`, and marker blocks in `CLAUDE.md` / `AGENTS.md` when those files already exist. The tools below cover the cases where auto-seed is absent, where reads need to reach beyond the seed, and where you want to audit what the agent has looked at.

## portuni_session_init

Manually initialise the read-scope set for this MCP session. Use only when auto-seed is absent — legacy client, ad-hoc connection, or a programmatic re-seed mid-session. Seeds the scope with the home node and its depth-1 neighbours. Idempotent — replaces any prior home node and re-seeds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `home_node_id` | string | no | Node ID (ULID) whose local mirror contains the cwd. Provide this OR `home_node_name`; omit both when no home node applies |
| `home_node_name` | string | no | Case-insensitive node name as an alternative to `home_node_id` |

Returns: `{ home_node_id, home_node_name?, home_node_type?, session_type, scope_size, seeded }` — or `{ home_node_id: null, session_type, scope_size, note }` when called with no home node (every subsequent read will require explicit expansion). `session_type` is derived server-side from the connection's auth path (`interactive_task`, `interactive_chat`, `headless`, or `env`) — it is never something this tool sets or accepts.

## portuni_expand_scope

Add one or more nodes to the current session's read-scope set — and, with `writable: true`, to its write-scope set too. Required when a read or mutating tool returned `{error: scope_expansion_required, ...}` / `{error: write_expansion_required, ...}`. For clients that declare the MCP `elicitation` capability, a real dialog is tried first; this tool is the fallback (and the only path for clients without that capability).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_ids` | string[] | yes | Node IDs (ULIDs) to add. At least one |
| `reason` | string | yes | Why scope is being expanded. Be honest about the trigger: `user-requested: <quoted prompt fragment>` for prompt-derived expansions, `user-confirmed-in-chat` for chat confirmations |
| `triggered_by` | enum | no | `user` (default) for prompt-named or chat-confirmed expansions; `agent` for the agent's own initiative (rare — most agent-initiated reaches go through elicitation) |
| `confirmed_hard_floor` | boolean | no | Default `false`. Set to `true` only when the user has explicitly confirmed reaching a hard-floor node (`visibility=private` owned by another user, or `meta.scope_sensitive=true`). Without this flag, hard-floor nodes are refused even when `reason` claims user confirmation. Ignored outright for `headless` sessions — they can never override a hard floor |
| `writable` | boolean | no | Default `false`. When `true`, also grants write access to the accepted nodes. Rejected outright (`write_expansion_impossible`) for `headless` sessions, whose write set cannot expand mid-run |

Returns: `{ added, added_via, writable, unknown, refused_hard_floor, scope_size, projected, hint? }` — `added_via` maps each accepted node ID to `"edge"` (reachable via a graph edge from the current scope set) or `"disconnected"` (found only via search/name, no edge path), classified server-side regardless of what `reason` claims; `unknown` lists requested IDs that don't exist in the graph (or aren't visible to the caller); `refused_hard_floor` lists `{ node_id, reason, permanent }` for nodes that need `confirmed_hard_floor=true` (`permanent: true` for a `headless` session — no retry will succeed); `projected` maps each accepted node ID with a local mirror on this device to its session-local hardlink projection directory (readable natively); an accepted node with no local mirror on this device has no entry in `projected` — read it with [`portuni_read_file`](/reference/files/) instead; `hint` appears when there's a clear next step.

Every expansion is audited and surfaced in `portuni_session_log`. See [Scope Enforcement](/concepts/scope-enforcement/).

## portuni_session_log

Return the current read-scope set, session type, and ordered expansion history for this MCP session. Use to inspect what the agent has looked at — useful both for the human-in-the-loop and for retrospective review of an autonomous run.

No parameters.

Returns: `{ session_id, home_node_id, session_type, created_at, scope_size, scope, expansions }` — `scope` is the ordered list of in-scope node IDs; `expansions` is the chronological log of every scope mutation with `at`, `node_ids`, `reason`, and `triggered_by`.

## See also

- [Scope Enforcement](/concepts/scope-enforcement/) — the conceptual model: session types, edge-reachable vs. disconnected-jump expansion, hard-floor rules, protocol elicitation, the write-scope gate, audit trail
- [Lifecycle States](/concepts/lifecycle-states/) — orthogonal to scope, but referenced in node payloads the scope set surfaces
