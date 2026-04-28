# Portuni read scope

Portuni reads are bounded by a session-level scope set: the set of
node IDs an agent may fetch in this MCP session. Without scope
gating, a curious-but-misguided agent could enumerate the whole graph
on a single user prompt -- including private nodes the user never
asked about. The scope set is a soft fence: explicit, audited, and
expanded only through user confirmation.

## How the scope set is built

- **Seed** at session start. The SessionStart hook resolves the
  user's `cwd` to its home node (the node whose mirror contains
  `cwd`) and calls `portuni_session_init(home_node_id)`. The scope
  set seeds with the home node + its depth-1 graph neighbors.
- **Expand** explicitly. `portuni_expand_scope(node_ids, reason,
  triggered_by, confirmed_hard_floor?)` adds nodes. Every expansion
  is audited and surfaced in `portuni_session_log`.
- **No implicit growth**. Reads do not add to scope. Reading a node
  does not put its neighbors in scope; the agent must expand
  intentionally.

If `cwd` is outside any mirror, the home node is null and the scope
set starts empty. Every read then requires explicit expansion.

## Scope modes

Configured via `PORTUNI_SCOPE_MODE`. Default is `balanced`.

- **strict**: every out-of-scope read returns
  `scope_expansion_required`. Global queries are always refused
  (must scope explicitly).
- **balanced** (default): out-of-scope reads return
  `scope_expansion_required`. Global queries elicit on the first
  call, then run once acknowledged.
- **permissive**: out-of-scope reads are allowed; the access is
  audited but not gated. Use only for one-off broad analysis.

## Refusal contract

When a read tool returns:

```json
{ "error": "scope_expansion_required", "tool": "...", "hint": "..." }
```

The agent MUST:

1. Surface the request to the user (which node, why it matters).
2. Get explicit user confirmation.
3. Call `portuni_expand_scope` with an honest `reason`:
   - `"user-requested: <quoted prompt fragment>"` when the user
     named the node in their prompt.
   - `"user-confirmed-in-chat"` after the user confirmed in chat.
4. Retry the original read tool.

Do NOT fabricate confirmation. Do NOT auto-expand on the agent's own
initiative without going through the elicitation cycle.

## Expansion semantics

`portuni_expand_scope(node_ids, reason, triggered_by, confirmed_hard_floor?)`:

- `node_ids`: ULIDs to add. The tool verifies each exists; unknown
  IDs are returned in `unknown` and ignored.
- `reason`: required, non-empty. Be honest about the trigger:
  prompt-named (`"user-requested: ..."`), chat-confirmed
  (`"user-confirmed-in-chat"`), or agent-initiated. The reason is
  audit-visible.
- `triggered_by`: `"user"` (default) for prompt-named or
  chat-confirmed expansions; `"agent"` for agent-initiative reaches
  (rare; most agent reaches go through elicitation first).
- `confirmed_hard_floor`: see below.

## Hard-floor nodes

Some nodes are hard-floored: even with explicit expansion, they
require a stronger confirmation flag. Hard floor applies when:

- `visibility = private` AND owner is another user, OR
- `meta.scope_sensitive = true`

Hard-floor nodes are refused unless `confirmed_hard_floor: true` is
also set on the expand call. That flag MUST be backed by an explicit
user confirmation in chat; do not pass it on agent initiative.
Refusals are audited under `scope_hard_floor_refusal`.

## Tool defaults

- `portuni_get_node(node_id|name)`: name lookups are filtered to
  in-scope candidates first, so unscoped name probing does not
  surface neighbouring metadata.
- `portuni_get_context(node_id, depth)`: depth ≤ 1 with an in-scope
  start is allowed; depth ≥ 2 is treated as breadth expansion and
  refused in strict/balanced. Use depth=1 then expand explicitly,
  or run under `PORTUNI_SCOPE_MODE=permissive`.
- `portuni_list_nodes` / `portuni_list_events` / `portuni_list_files`:
  default to session-scope filtering. Pass `scope: "global"` (or
  omit `node_id` on list_events/list_files) only when the user
  asked for a broad listing; that path is mode-gated and audited.

## Inspection

`portuni_session_log()` returns the current scope set, scope mode,
and ordered expansion history -- useful for the user
("what did the agent look at?") and for retrospective review of an
autonomous run.
