---
title: Scope
description: Tools for managing the per-session read-scope set (session init, expansion, audit log).
---

Every MCP session carries a read-scope set — the explicit list of node IDs the agent is allowed to read in this session. Reads of nodes outside the set return `{error: scope_expansion_required, ...}` until the user authorises expansion. See [Scope Enforcement](/concepts/scope-enforcement/) for the conceptual model and mode matrix.

The scope set is normally seeded automatically when an MCP client opens the session with `?home_node_id=<id>` in the URL (which `portuni_mirror` writes into every mirror's `.mcp.json` / `.codex/config.toml`). The tools below cover the cases where auto-seed is absent, where reads need to reach beyond the seed, and where you want to audit what the agent has looked at.

## portuni_session_init

Manually initialise the read-scope set for this MCP session. Use only when auto-seed is absent — legacy client, ad-hoc connection, or a programmatic re-seed mid-session. Seeds the scope with the home node and its depth-1 neighbours. Idempotent — replaces any prior home node and re-seeds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `home_node_id` | string | no | Node ID (ULID) whose local mirror contains the cwd. Provide this OR `home_node_name`; omit both when no home node applies |
| `home_node_name` | string | no | Case-insensitive node name as an alternative to `home_node_id` |

Returns: `{ home_node_id, home_node_name?, home_node_type?, mode, scope_size, seeded }` — or `{ home_node_id: null, mode, scope_size, note }` when called with no home node (every subsequent read will require explicit expansion).

## portuni_expand_scope

Add one or more nodes to the current session's read-scope set. Required when a read tool returned `{error: scope_expansion_required, ...}`. Surface the request to the user, get confirmation, then call this.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_ids` | string[] | yes | Node IDs (ULIDs) to add. At least one |
| `reason` | string | yes | Why scope is being expanded. Be honest about the trigger: `user-requested: <quoted prompt fragment>` for prompt-derived expansions, `user-confirmed-in-chat` for chat confirmations |
| `triggered_by` | enum | no | `user` (default) for prompt-named or chat-confirmed expansions; `agent` for the agent's own initiative (rare — most agent-initiated reaches go through elicitation) |
| `confirmed_hard_floor` | boolean | no | Default `false`. Set to `true` only when the user has explicitly confirmed reaching a hard-floor node (`visibility=private` owned by another user, or `meta.scope_sensitive=true`). Without this flag, hard-floor nodes are refused even when `reason` claims user confirmation |

Returns: `{ added, unknown, refused_hard_floor, scope_size, hint? }` — `unknown` lists requested IDs that don't exist in the graph; `refused_hard_floor` lists nodes that need `confirmed_hard_floor=true`; `hint` appears when there's a clear next step.

Every expansion is audited and surfaced in `portuni_session_log`. See [Scope Enforcement](/concepts/scope-enforcement/).

## portuni_session_log

Return the current read-scope set, scope mode, and ordered expansion history for this MCP session. Use to inspect what the agent has looked at — useful both for the human-in-the-loop and for retrospective review of an autonomous run.

No parameters.

Returns: `{ home_node_id, mode, created_at, scope_size, scope, expansions }` — `scope` is the ordered list of in-scope node IDs; `expansions` is the chronological log of every scope mutation with `at`, `node_ids`, `reason`, and `triggered_by`.

## See also

- [Scope Enforcement](/concepts/scope-enforcement/) — the conceptual model: modes (strict, balanced, permissive), hard-floor rules, audit trail
- [Lifecycle States](/concepts/lifecycle-states/) — orthogonal to scope, but referenced in node payloads the scope set surfaces
