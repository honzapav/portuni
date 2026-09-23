---
title: Scope Enforcement
description: How a session's reach is bounded – what an agent can read and where it can write.
---

:::note[Scope enforcement is implemented]
All three halves are in code: graph read-scope (session scope set, session types, expansion audit), graph write-scope (domain-layer write gate), and filesystem write-scope config generation (per-harness configs, `/scope` endpoint, `portuni-guard` hook). See `docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md` for the full design and `portuni://scope-rules` for the agent-facing contract this page summarizes.
:::

A Portuni session always has boundaries: what files the agent can write to, what graph nodes it can read from, and which of those it can mutate. Without bounds, the agent in a "Goldea Presale" project session can edit files in a sibling process mirror, or list every project across every organization the user can see. Neither is the intended behavior.

The scope model adds enforceable, complementary mechanisms – one for filesystem writes, one for graph reads, one for graph writes – all anchored on the same idea: the **session home node**.

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

The primary mechanism is declarative: when a mirror is created or renamed, Portuni writes per-harness configuration into `local_path`, layering on top of user-owned files (never replacing them). Portuni does not try to intercept individual filesystem calls from arbitrary harnesses – cross-harness interception is fragile and easy to bypass.

There is one runtime layer on top: a **task** started from the desktop app ("Nový úkol") runs through Portuni's runner, which decides each write itself by the same write-scope rules the guard hook applies (`apps/server/domain/runner/permissions.ts`): editing inside the current mirror is allowed, editing another node's mirror is refused, and a scope-expanding or plan-approval request shows up as a question in the task's chat. Hand-opened shells rely on the declarative configs alone.

The generated files:

- **`.claude/settings.local.json`** – an overlay file Claude Code merges on top of `settings.json`. Portuni owns this file completely, so it can be regenerated safely on every call. Three things in one file:
  - `permissions.allow` for the current mirror and `permissions.deny` for every other mirror in the registry. No synthetic tier-3 negation – Claude Code's permission grammar is plain glob, so tier-3 enforcement is delegated to the `portuni-guard` PreToolUse hook (next bullet).
  - `hooks.PreToolUse` auto-wired to `scripts/portuni-guard.sh` (matcher: `Edit|Write|NotebookEdit|MultiEdit`). Resolved from `PORTUNI_GUARD_SCRIPT` env or relative to the Portuni install. The hook block is omitted when the script can't be located.
  - `portuni_managed` marker so the file is recognisable as auto-generated.
- **`.mcp.json`** – Claude Code project-scoped MCP server registration (`mcpServers.portuni`). The user is prompted once on first session whether to trust the server; afterwards every session inside this mirror connects to the local Portuni server automatically. The bearer header references the token via `${PORTUNI_MCP_TOKEN:-}` env expansion (workspace-suffixed `PORTUNI_MCP_TOKEN_<ID>` when the sidecar runs under the multi-workspace desktop) – **never a literal**. The file content is static across token rotations and safe to leave on disk; export the variable yourself in the shell that runs the agent (Settings → MCP Server → Copy token in the desktop app).
- **`.codex/config.toml`** – a `[sandbox_workspace_write]` block with `writable_roots = [<this mirror>]`, under a Portuni-managed marker. Codex's Seatbelt / Landlock enforces this at the kernel level. The MCP server registration itself lives in the user-scoped `~/.codex/config.toml`, referencing the token via the same env var.

  Portuni writes this file only when it is missing or already carries the Portuni marker comment; a hand-edited Codex config is preserved.
- **`PORTUNI_SCOPE.md`** – the same write-scope rules, plus an orientation section (node context, responsibilities, recent events, and a handoff pointer for a suspended session) when that data is available. There is no automatic first prompt (spec: "Spawn UX") — the agent reads this file on its own instead of being told its contents upfront.
- **`CLAUDE.md` / `AGENTS.md`** – refreshed only if they already exist, between BEGIN/END `portuni-scope` markers. User content outside the markers is preserved.

Portuni no longer writes a per-mirror `.vibe/config.toml` or `.cursor/rules`: both served harnesses the embedded terminal used to launch, and that terminal is gone. Any MCP-speaking client can still connect to a mirror — point it at the Portuni server the way [Mistral Vibe](/clients/mistral-vibe/) does, and read `PORTUNI_SCOPE.md` for the scope rules.

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
| `PORTUNI_URL` | MCP server base URL written into `.mcp.json`. The `/mcp` suffix is appended if missing. | `http://${HOST}:${PORT}/mcp`, defaulting to `http://127.0.0.1:4011/mcp` |
| `PORTUNI_MCP_TOKEN` (or `PORTUNI_MCP_TOKEN_<ID>` per workspace) | The bearer token the generated configs *reference* via env expansion – never written into them. Set it in the shell that runs the agent (Settings → MCP Server → Copy token in the desktop app). | unset (header degrades to empty) |

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

### Session types

The server derives a `session_type` for every MCP session from the **authentication path** – it is never self-declared by the client or the agent:

| Type | How recognized | Anchor / initial scope | Elicitation |
|------|-----------------|-------------------------|-------------|
| `interactive_task` | Connection carries `?home_node_id` (a runner-started task, or a hand-opened CLI in a mirror via `.mcp.json`) | Task node + its depth-1 neighbours | Dialog (or structured refusal fallback) |
| `interactive_chat` | OAuth-grant connection (claude.ai, Claude Desktop chat, Claude Code added as a connector) | No anchor, no scope set – read is permission-only: any node visible to the user is readable directly, no edge-reachability or expansion round trip | Dialog for hard floors and writes only |
| `headless` | Device token minted with the `headless` flag (admin-granted credential) | Task node, **required** – a connection without `home_node_id` is refused outright | None – always a hard structured refusal, no dialog, no deferred bypass |
| `env` | Solo/loopback auth (the standalone server's default) | Same as `interactive_task` | Historical unscoped behavior; writes are unconditionally allowed, reads still nominally scope-gated |

`session_init`, `session_log`, and every scope-related audit entry carry `session_type`.

### Initial scope set

At session start, if the MCP URL carries `?home_node_id=<id>` (which `portuni_mirror`-generated configs always do), the server auto-seeds the scope set with:

1. The session home node.
2. Every node directly connected to it by an edge (depth 1, both directions).

The seed runs as part of session initialization, before the agent's first tool call, and is logged as an audit entry with `triggered_by: "init"`.

Without a `home_node_id` query param – a legacy mirror config or an ad-hoc client, still classified `interactive_task` – the scope set starts empty. The agent must call `portuni_session_init` or `portuni_expand_scope` to populate it – edge-reachable expansion has nothing to be reachable from until then.

`interactive_chat` connector sessions are a different case: their read gate never consults a scope set, seeded or not (see the session types table above) – every visible node is readable directly. Neither `portuni_session_init` nor `portuni_expand_scope` is needed to read in that session type.

### Three ways to expand

| Path | Trigger | Classification | User confirmation |
|------|---------|-----------------|--------------------|
| Edge-reachable expansion | Agent reads a node directly connected by a graph edge to something already in scope | `added_via: "edge"` | None – auto-approved and audited. The server computes reachability itself, never taken from the agent |
| Disconnected jump | Agent reads a node found only via search or name, with no edge path from anything in scope | `added_via: "disconnected"` | Required for interactive types (dialog, or `portuni_expand_scope` with an honest `reason`); `headless` proceeds only with a declared reason and the jump is surfaced prominently in review |
| Node creation | The session creates a node (`portuni_create_node`) | `added_via: "created"` | None – a task's own outputs are part of its context by definition |

Repeated disconnected jumps to the same node across sessions are a signal of a missing edge in the graph, not a workflow to route around.

**Hard floors** override the table above: a node with `meta.scope_sensitive: true`, or a `visibility: private` node owned by another user, always elicits in interactive types and is **always refused** in `headless` – there is no `confirmed_hard_floor` override for a headless session.

Every expansion (and every refusal) is logged to the audit trail with the reason (the user's quoted phrase, the agent's stated rationale, or the server's own classification) and surfaced in `portuni_session_log`.

### Protocol elicitation

Clients that declare the `elicitation` capability at `initialize` (MCP SDK ≥ 1.29's `elicitInput`) get a real yes/no dialog instead of the structured-refusal round trip: the same "elicit" classifications above (disconnected jumps, hard floors for non-headless sessions, and write expansion below) try the dialog first. Accepting performs the expansion immediately server-side; declining, cancelling, or talking to a client that never declared the capability falls back to the same `scope_expansion_required` / `write_expansion_required` JSON shape, so an agent sees a consistent contract either way. `headless` sessions never see a dialog, by session-type design, regardless of what the connected client declared.

A dialog is bounded in time: after four minutes (`PORTUNI_ELICIT_TIMEOUT_MS`; the sync-agent relay hop below gives up a minute earlier, so an on-time answer is never discarded by the outer wait) the tool answers with the same structured refusal as a decline, carrying `dialog_timed_out: true` and a hint saying the confirmation went unanswered — nothing was changed, ask the user and retry. The deadline is deliberately below the tool-call timeouts clients enforce (claude.ai aborts a tool call after five minutes), so a confirmation dialog can never turn into a hang the client kills.

Sync-agent sessions (the desktop app's team-workspace sidecar, `apps/server/mcp/agent-transport.ts`) proxy this transparently: the sidecar advertises the real connected client's declared capabilities upstream to central, and relays a server-initiated elicitation request from central back down to that same client, so the dialog appears wherever that client renders it, exactly as it would for a direct central session.

### Reading related nodes – how read scope reaches the filesystem

An agent runs as a task now (no embedded terminal, no kernel sandbox around it — see the runner design), so disk read scope is simply: does this device have a local mirror of the node?

- **Any in-scope node with a local mirror on this device** — the home node, a depth-1 neighbour, or one added mid-session by `portuni_expand_scope` or an auto-allowed edge traversal — is fully readable at its **real** mirror path, no distinction between them. Read tools return it as `local_path` / `readable_path`; `portuni_expand_scope` returns it in its `readable` map for each newly accepted node. Read and edit the files natively.
- **No local mirror on this device.** Read its content with [`portuni_read_file`](/reference/files/) (`node_id` + path) — the server reads the live file (or falls back to the routed remote) and returns it, reporting a disk path instead of inline content past the 1 MB limit (or on request via `as_path`; a node with no mirror gets a plain temp file written under the runner's own data directory). This is the one channel that always works regardless of mirror presence.

Team-workspace sessions through the sync agent (the desktop app's team-workspace sidecar) apply the same rule on the SAME device — `portuni_expand_scope`, `portuni_get_node` and `portuni_get_context` are proxied to the central server, which has no filesystem of its own, so the sync agent's front door overlays `readable`/`readable_path`/`local_path` from its own local mirror registry before returning.

## Write scope – graph mutations

Separate from (and narrower than) read scope: being able to read a node does not make it writable. Enforced in the **domain layer** (`apps/server/domain/write-gate.ts`), not the MCP tool layer – a check embedded only in `tools/*.ts` would be bypassed by any other entry point reaching the same mutation, specifically the sync-agent sidecar's local tools (mirror/status/store/pull/adopt_files) that dispatch straight to REST from `agent-transport.ts`, never touching the MCP tool layer at all.

Every mutating tool (create/update/delete on nodes, edges, events, responsibilities, data sources, tools, files, mirrors, snapshot) checks write scope on its target node before mutating:

| Session type | Write set |
|--------------|-----------|
| `interactive_task` / `headless` | Home node, plus any node created by this session, plus any node explicitly granted via `portuni_expand_scope(..., writable: true)` |
| `interactive_chat` | No home node. Starts with the nodes this user's earlier connector sessions created (a durable grant, rehydrated on every new connector session and re-persisted under it) – every other write needs elicitation |
| `env` | Every write allowed unconditionally (subject to the usual permission tier) – historical behavior, not part of this model |

A mutating call outside the write set returns `{"error": "write_expansion_required", "node_id": "...", "hint": "..."}` for interactive types, or `{"error": "write_refused", "node_id": "...", "hint": "..."}` for `headless` – a hard, non-negotiable refusal, since a headless session cannot expand its write set mid-run (`portuni_expand_scope(..., writable: true)` itself is rejected outright for it). For interactive types, write-set expansion happens *only* through a real elicitation dialog – whether triggered on the spot by the mutating call, or proactively via `portuni_expand_scope(..., writable: true)` – and `reason` text is never a substitute for it. A client without the elicitation capability cannot grant write access through either path: there is no honor-system fallback for writes the way there is for reads. On such a client (claude.ai web and mobile today) the `write_expansion_required` payload carries `elicitation_supported: false` and its `hint` says the grant is impossible from this session instead of recommending `portuni_expand_scope` – continue from Claude Code or the desktop app, or create the node from the chat.

Why connector-created nodes are the exception: a connector client reopens its MCP session constantly (the server's 30-minute idle GC, a deploy, the client re-initialising between turns), and an `interactive_chat` session has no anchor and no resume path. An in-memory-only "created by this session" grant was therefore gone by the time the user asked to attach a file to the node they had just created – and with no elicitation capability, nothing could bring it back. The grant is now persisted (`session_scope`, `added_via: created`, `writable: 1`) and rehydrated on every new connector session of the same user; nothing else is rehydrated (not elicited grants, not other users' sessions, not nodes created from a task session or the desktop UI).

Actors (`portuni_create_actor`/`update`/`delete`) and sync-remote administration (`portuni_setup_remote`, `portuni_set_routing_policy`) are global registries, explicitly exempt from write scope (permissions still apply).

The same domain-layer gate also covers the REST API's graph-plane mutations (nodes, edges, events, responsibilities, data sources, tools, mirror creation) for any caller that isn't the desktop UI (`env`/`session_jwt` identity) — a `device_token` or `oauth_grant` identity hitting these routes directly gets the same `write_refused`/`write_expansion_required` shape. REST has no per-request session or elicitation channel, so an out-of-scope REST write is always refused outright, never deferred. The file-content/sync-plane REST endpoints (`PUT` file content, register/register-batch, move, delete, sync, remote-sweep) are unaffected for a plain (non-headless) `device_token` — that identity is the sync agent's own channel, gated once already at the MCP tool call that triggered the sync. A **headless** device token is the one exception: those same file-plane routes refuse it outright unless the request names (via `X-Portuni-Spawn-Id`) the running headless session it's bound to, scoped to that session's home node — a headless credential cannot use the sync channel's blanket exemption to write outside its own session.

**The `env` identity's REST blanket exemption can be hardened to be proxy-proven instead of self-declared (#213).** `env` auth mode resolves every request to the same unscoped solo identity, so a spawned agent process holds the exact same loopback bearer token as the desktop webview and could otherwise claim the same exemption by simply omitting `X-Portuni-Spawn-Id`. Setting `PORTUNI_WEBVIEW_PROXY_SECRET` closes this: once configured, an `env`-mode request gets the blanket exemption only when it carries a valid `X-Portuni-Webview-Proxy` header matching that secret (`apps/server/api/write-gate.ts`) — a request with neither that header nor a resolvable `X-Portuni-Spawn-Id` session is refused entirely, and a spawn id that fails to resolve (unknown, foreign, stale) fails closed instead of falling back to the blanket exemption. Leaving the variable unset keeps the historical behavior (every `env`-mode REST write allowed) — the packaged desktop app's Tauri host always sets its own per-launch value, so the hardened posture is always active there regardless of this default; the standalone/Vite dev flow opts in the same way `PORTUNI_AUTH_TOKEN` itself does, by setting matching values on both the server and `apps/web/vite.config.ts`'s dev proxy (which injects the header the same way the Tauri host's `api_request` proxy does, generated fresh per launch and never written to disk or exported into a spawned agent's own env). `X-Portuni-Spawn-Id` scoping itself is unconditional and available to every identity shape, not just `env`. `session_jwt` (team-workspace desktop webview, authenticated by a real per-user login JWT that never leaves the Keychain/webview boundary) is unaffected either way — it keeps the unconditional exemption, since team-workspace graph writes never reach this local, env-mode auth path.

## A session belongs to its owner

Scope bounds what a session may reach. Who may reach the **session** is a
separate, much simpler rule: a thread is its owner's. Every action on it —
reading its record and transcript, sending a message, stopping it, resuming
it — is the owner's alone. Seeing the node a session is anchored to grants
nothing about the sessions on it, and neither does `manage` or `admin`
scope: a request from anyone but the owner answers `SESSION_NOT_FOUND`
(404), so a teammate is never even told the thread exists
(`apps/server/auth/session-access.ts`).

The list routes follow the same rule: `GET /sessions`, a node's
`GET /nodes/:id/sessions` and the sessions part of `GET /overview` return
the caller's own threads only. So a node's Relace tab, the Práce sidebar,
the Přehled inbox and the running count show each person their own work,
even on a node the whole organisation can see. What people share on a node
is its **files** — including the handoff file a suspended thread writes —
not the conversations that produced them.

### The record is central, the content is the device's

Owner-only is the access half. The storage half is the same principle made
physical: a thread has a **record** — that it exists, on which node, whose
it is, its state, runner, model, its runs and its scope — and **content** —
the first message, every event of the transcript, the inline handoff
summary. The central server holds the record, because the MCP handshake,
scope enforcement and the write gate key on it. The content is written to
the **device that ran the thread**, in the sidecar's own database, and is
never sent to the central server.

So `GET /sessions/:id/events` is a device-local route: it answers from the
machine you are asking, which is the machine that has the log. Asked on a
device that did not run the thread it answers 200 with an empty list and
`transcript_host` — the label of the machine that does — which the app
shows as „Transkript je na zařízení X" instead of an empty chat. The way
across is the handoff file, not a copy of the conversation (see
[Předat / Navázat na handoff](/guides/working-in-the-app/#task-chat-práce)).

There is **no backup of transcripts**. Losing a device's database loses the
conversations it ran; the records on the central server and the handoff
files tracked in the nodes are what survive. Portuni owns no content — what
a team shares on a node is its files, including a suspended thread's
handoff summary, never the conversation that produced them.

## Why this is its own page (and not a permission system)

Scope is **orthogonal** to permissions. Permissions (visibility, including group-based access via Google Groups) are enforced server-side in `apps/server/auth/` — every tool call and HTTP route passes through identity resolution, global scope gates (TOOL_MIN_SCOPE), and node-level access checks before scope is consulted. Scope decides what an in-progress session is currently focused on — a second, intentionality-shaped filter applied on top of permissions.

A user with read access to every node in their org still gets a narrow scope set when they start a session in one project. The agent isn't omniscient by default; it's focused, and expansion is auditable.

## MCP tools

| Tool | Purpose |
|------|---------|
| `portuni_session_init(home_node_id)` | Manual fallback. Auto-seed normally runs on connect when the URL carries `?home_node_id=…`; this tool only exists for clients connecting without that param. Seeds the scope set with the home node + its depth-1 neighbors. |
| `portuni_expand_scope(node_ids, reason, triggered_by, confirmed_hard_floor?, writable?)` | Add nodes to read scope (and, with `writable: true`, to write scope too). Always audited; the server independently classifies each accepted node `added_via: "edge"` or `"disconnected"` regardless of the stated `reason`. Hard-floor nodes (private-other, `meta.scope_sensitive`) require both `confirmed_hard_floor=true` AND a real user confirmation; a refusal entry is logged otherwise, and the flag is ignored outright for `headless`. `writable: true` requires a real elicitation dialog per node (refused outright, `refused_write`, without the elicitation capability — never granted from `reason` alone). |
| `portuni_session_log()` | Returns the current scope set, session type, and ordered expansion history. |
| `portuni_get_node` | Out-of-scope target returns `{"error":"scope_expansion_required",...}`. Name lookups are filtered to in-scope candidates first, so name probing cannot leak metadata. |
| `portuni_get_context` | Start node must be in scope. Depth ≤ 1 is the natural read; depth ≥ 2 is treated as breadth expansion and always refused – call with depth ≤ 1, then expand explicitly. |
| `portuni_list_nodes` / `portuni_list_events` / `portuni_list_files` | Default to session scope; without `node_id` (`list_events`/`list_files`) or with `scope: "session"` (`list_nodes`, the default) results are restricted to the current scope set (empty scope means an empty result, not a gate). |
| `portuni_search_files`, `portuni_list_nodes(scope: "global")` | Discovery, not ingestion: permission-only in every session type, no scope gate — every node/hit the caller can see, filtered by visibility. Search hits carry a bounded snippet, not full content; reading a hit in full is the scope event. |
| `portuni_session_suspend(content, agent_session_id?)` | Writes the handoff to `wip/sessions/<session-id>-handoff.md` (a normal synced path), stores its hash and the CLI's own conversation id, and marks the session `suspended` so a later resume can continue it. Requires a home node — `interactive_chat` has no anchor to write into. See [Scope reference](/reference/scope/#portuni_session_suspend). |

### REST surface (out of scope)

The HTTP REST endpoints (`/graph`, `/context`, `/nodes/:id/sync-status`, `/users`, `/actors`, etc.) are intended for the local desktop UI, not for agent-driven access. They are NOT subject to the read-scope set – the UI runs as the same human user the scope model is meant to assist, and gating it would defeat its purpose. Agent-facing access goes through the MCP tools listed above; that's the surface scope enforcement covers.

## Implementation status

Everything on this page is implemented: session types, edge-reachable/disconnected-jump read-scope classification, hard floors, protocol elicitation with structured-refusal fallback, the domain-layer write gate, permission-only discovery search, per-harness filesystem write-scope config generation, and the `portuni-guard` backstop hook. Design doc: `docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md`. Agent-facing contract detail beyond what's summarized here: `portuni://scope-rules`.

Explicitly out of scope until requested: write-scope config generation for harnesses other than Claude Code, Codex, and Mistral Vibe (Gemini CLI, Cline, Continue, Aider, Windsurf, Roo).
