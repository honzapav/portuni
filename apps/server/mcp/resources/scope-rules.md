# Portuni read scope

Portuni reads are bounded by a session-level scope set: the set of
node IDs an agent may fetch in this MCP session. Without scope
gating, a curious-but-misguided agent could enumerate the whole graph
on a single user prompt -- including private nodes the user never
asked about. The scope set is a soft fence: explicit, audited, and
expanded only through user confirmation.

## How the scope set is built

- **Seed** at session start. The MCP server reads `?home_node_id=…`
  from the connection URL (every mirror's `.mcp.json` /
  `.codex/config.toml` / `.vibe/config.toml` carries it, written by
  `portuni_mirror`) and seeds the scope set with the home node + its
  depth-1 graph neighbors. No explicit tool call required. For clients
  connecting
  without that query param, `portuni_session_init(home_node_id)` is
  the manual fallback.
- **Edge-reachable expansion is automatic.** Reading a node that is
  directly connected by a graph edge to something already in scope
  auto-expands scope to include it — no `portuni_expand_scope` round
  trip needed. This is a natural traversal, not a jump: the server
  computes reachability itself (never taken from the agent), adds the
  node, and audits it as `added_via: "edge"`.
- **Disconnected jumps require confirmation.** Reading a node found
  only via search or name — with no edge path from anything already
  in scope — is refused; the agent must confirm with the user and call
  `portuni_expand_scope(node_ids, reason, triggered_by,
  confirmed_hard_floor?)`. The server independently classifies the
  expansion `added_via: "disconnected"` regardless of what `reason`
  claims. Every expansion is audited and surfaced in
  `portuni_session_log`.
- **Nodes created by the session** enter its scope automatically
  (`portuni_create_node`) — a task's own outputs are part of its
  context by definition.

If `cwd` is outside any mirror, the home node is null and the scope
set starts empty. Every read then requires explicit expansion (edge-
reachable expansion has nothing to be reachable from).

## Session type

The server derives a `session_type` for every MCP session from the
authentication path -- it is never self-declared by the client or
agent:

- **`interactive_task`**: the connection carries `?home_node_id`
  (desktop-spawned terminal, mirror `.mcp.json`). Anchor = the task
  node.
- **`interactive_chat`**: a connector session (claude.ai, Claude
  Desktop chat, Claude Code added as a connector). No anchor, no
  in-memory scope set, no edge-reachability or expand_scope dance:
  read is permission-only — any node visible to the user (past the
  same hard-floor gate below) is readable directly. Listing tools
  without a `node_id` filter (`portuni_list_events`,
  `portuni_list_files`) likewise see every row on a visible node
  instead of an empty result.
- **`headless`**: a device token minted with the `headless` flag (an
  admin-granted credential for unattended/RALPH-style sessions). A
  task anchor is required -- a headless connection without
  `?home_node_id` is refused at seed time.
- **`env`**: solo/loopback auth. Keeps its historical behavior; not
  part of this model.

An edge-reachable read auto-expands (see above); a disconnected jump
or a hard floor elicits — there is no self-service bypass for either.
`session_init` and `session_log` report the session's type; every
scope-related audit entry carries it too.

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
initiative without going through the elicitation cycle. (This does not
apply to edge-reachable nodes — those auto-expand by design, see
above.)

A read tool can also return:

```json
{ "error": "scope_refused", "tool": "...", "hint": "..." }
```

This is a **hard, non-negotiable refusal** — a headless session hitting
a hard floor. There is no `portuni_expand_scope` round trip that will
succeed; do not retry.

## Protocol elicitation

Clients that declare the `elicitation` capability at `initialize` (MCP
SDK >= 1.29's `elicitInput`) get a real yes/no dialog instead of the
`portuni_expand_scope` round trip above: the same "elicit" read
classifications (disconnected jumps, hard floors for non-headless
sessions) and write classifications (see "Write scope" below) try the
dialog first. Accepting performs the expansion immediately server-side
(audited `added_via: "elicited"` for reads); declining or cancelling
falls back to the same structured-refusal response documented above,
so an agent talking to any client -- old or new -- sees a consistent
contract either way. `headless` sessions never see a dialog, by
session-type design, regardless of what the connected client declared.

Agent-mode sessions (the desktop app's central-mode sidecar,
`apps/server/mcp/agent-transport.ts`) proxy this transparently: the
sidecar advertises the real terminal client's declared capabilities
upstream to central, and relays a server-initiated elicitation request
from central back down to that same real client, so the dialog appears
in the terminal exactly as it would for a direct central session.

## Expansion semantics

`portuni_expand_scope(node_ids, reason, triggered_by, confirmed_hard_floor?)`:

- `node_ids`: ULIDs to add. The tool verifies each exists; unknown
  IDs are returned in `unknown` and ignored.
- `reason`: required, non-empty. Be honest about the trigger:
  prompt-named (`"user-requested: ..."`), chat-confirmed
  (`"user-confirmed-in-chat"`), or agent-initiated. The reason is
  audit-visible — but does NOT determine the audit classification:
  the server independently computes `added_via` (`"edge"` or
  `"disconnected"`) per node from graph reachability, returned in the
  response's `added_via` map.
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
Refusals are audited under `scope_hard_floor_refusal`, with a
`permanent` flag per refusal.

**Headless sessions cannot override a hard floor at all.**
`confirmed_hard_floor` is ignored for `session_type: "headless"` — a
headless session has no elicitation channel and no deferred-review
path for hard-floor material, so these refusals are always
`permanent: true`. A `portuni_get_node` / `portuni_read_file` /
`portuni_get_context` call that hits a hard floor from a headless
session returns `{ "error": "scope_refused", ... }` directly, not
`scope_expansion_required` — there is nothing to retry.

## Write scope

Write scope is narrower than read scope and enforced independently
(domain-layer `guardWrite`, `apps/server/domain/write-gate.ts`) --
being able to read a node does not make it writable. Every mutating
tool (create/update/delete on nodes, edges, events, responsibilities,
data sources, tools, files, mirrors, snapshot) checks write scope on
its target node before mutating. Actors (`portuni_create_actor` /
`update` / `delete`) and sync-remote administration
(`portuni_setup_remote`, `portuni_set_routing_policy`) are global
registries, explicitly exempt (permissions still apply).

- `env`: historical unscoped behavior, not part of this model --
  every write is allowed (subject to the usual permission tier).
- `interactive_task` / `headless`: the write set is the home node,
  plus any node created by this session (`portuni_create_node` grants
  both read and write on the node it creates) or explicitly granted
  via `portuni_expand_scope(..., writable: true)`.
- `interactive_chat`: the write set starts and stays empty (no home
  node) -- every write needs confirmation.

A mutating tool call outside the write set returns one of:

```json
{ "error": "write_expansion_required", "node_id": "...", "hint": "..." }
```

For interactive types (`interactive_task`, `interactive_chat`, which
includes "chat writes"): a client that declared the `elicitation`
capability gets a real dialog first (see "Protocol elicitation" above)
-- accepting grants write access immediately, whether the dialog was
triggered on the spot by the mutating call or proactively via
`portuni_expand_scope(node_ids, reason, writable: true)`. Either way
write-set expansion happens *only* through that dialog: the `reason`
text is never sufficient by itself. A client that has not declared the
`elicitation` capability cannot grant write access at all -- there is
no honor-system fallback for writes the way there is for reads;
`portuni_expand_scope(..., writable: true)` refuses outright
(`refused_write` in its response) instead of silently trusting the
call.

```json
{ "error": "write_refused", "node_id": "...", "hint": "..." }
```

`headless` sessions only: a hard, non-negotiable refusal. Headless
sessions have no elicitation channel and cannot expand their write set
mid-run -- `portuni_expand_scope(..., writable: true)` is itself
rejected outright for them (`write_expansion_impossible`) rather than
silently ignored. There is no retry.

Node creation (`portuni_create_node`) is not write-gated itself --
there is no existing node to protect, and the new node becomes
writable the moment it exists.

## Search and global listing are discovery, not ingestion

`portuni_search_files` and `portuni_list_nodes(scope: "global")` are
**permission-only in every session type**: no scope gate at all,
results filtered only by node visibility (same as any other read).
They exist to let an agent find things it does not yet have in
scope — a hit is a reference plus a short, length-capped snippet
(`portuni_search_files`), not the node's full content. Reading a
hit in full (`portuni_read_file`, `portuni_get_node`, ...) is the
scope event and follows the normal expansion rules above; a search
or global-list result is never itself added to scope.

## Tool defaults

- `portuni_get_node(node_id|name)`: name lookups are filtered to
  in-scope candidates first, so unscoped name probing does not
  surface neighbouring metadata.
- `portuni_get_context(node_id, depth)`: depth ≤ 1 with an in-scope
  start is allowed; depth ≥ 2 is treated as breadth expansion and
  always refused without explicit confirmation. Use depth=1 then
  expand explicitly.
- `portuni_list_nodes` (default `scope: "session"`), `portuni_list_events`,
  `portuni_list_files`: default to session-scope filtering — with
  `node_id` (list_events/list_files) the node must be in scope;
  without it, results are restricted to the current scope set (empty
  scope means an empty result, not a gate). `scope: "global"` on
  list_nodes is the discovery exception above.
- `portuni_search_files`: always the discovery exception above,
  whether or not `node_id` is passed.

## Inspection

`portuni_session_log()` returns the current scope set, session type,
and ordered expansion history -- useful for the user
("what did the agent look at?") and for retrospective review of an
autonomous run.
