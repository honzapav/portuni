# Portuni

Portuni is a shared map of how your organization works – its processes, projects, areas, and principles – held as one graph that every tool and every AI agent can read. People and agents draw from the same picture instead of rebuilding context from scratch in every app.

It doesn't compete with Google Drive, Asana, or any other tool. It's the connective layer that mirrors your organizational structure (POPP) consistently across all of them, so every tool and every agent sees the same map. MCP is how agents plug in.

For me now. For my team tomorrow. For other companies soon.

## Design principles

**Human decides, agent assists.** Portuni is built on symbiotic cooperation, not autonomous agents. The human decides what to log, what to share, what to archive, what to pull. The agent guides (presents options, flags conflicts, suggests connections) but never acts on its own. This applies to every interaction: event logging, file publishing, archiving, node creation.

**Intentional, not automatic.** No background sync, no auto-capture, no magic. Every piece of knowledge enters the graph because someone decided it was worth keeping. `portuni_store` is like a git commit — deliberate. `portuni_pull` is like a git pull — on demand. This keeps the graph high-signal.

**Thin and pluggable.** Portuni owns the knowledge graph and POPP structure. Everything else (tasks, files, code, CRM) stays in its own tool, accessed via its own MCP. Portuni mirrors structure, not data.

**Graph, not tree.** POPP entities relate to each other via many-to-many edges. A project can relate to multiple processes, multiple areas, multiple principles. There is no top-level hierarchy — the organizational structure is a graph, and the graph is the authority. Any tree-shaped view (folders, lists) is a projection of the graph, not the source of truth.

**Edges emerge from work.** Edge creation is not a one-time metadata task. Edges are proposed at project initiation (based on description), refined during execution (based on events and decisions), and crystallized at closure (based on learnings). In Phase 1, edges are managed manually. In later phases, background AI processes suggest and auto-create edges as a byproduct of using the system. The system is designed from the start to support emergent, AI-driven edge discovery.

**Predictable structure, minimal hierarchy.** The folder structure in external tools (Drive, local filesystem) must be predictable — anyone can find anything without guessing. Less hierarchy is better. Flat is the default. Hierarchy is added only when access control demands it, not for organizational aesthetics. The structure teaches people how the company is organized.

**Tasks can be autonomous after the user triggers them.** A user can kick off a task and let the agent work independently. But the user initiated it, scoped it, and decided when it's done. System-level automation (scheduled jobs, monitoring) can exist on top, but Portuni itself doesn't initiate anything.

## Problem

Organizations use many tools (Drive, Asana, Airtable, …) but none of them understand the organization's structure — its processes, areas, projects, and principles. Each tool has its own folder hierarchy, its own project list, its own way of organizing. Knowledge gets siloed.

When AI agents enter the picture, this gets worse:

- An agent working on project A can't see what was learned in project B, even when they share a process or an area
- Accumulated knowhow (too rich for a skill, too general for a single project) has no home
- Cross-referencing requires knowing where to look
- Setting up a new project means manually creating matching structures in 3+ tools
- Team handoffs lose context because knowledge lives in conversations, not in a shared structure

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Any MCP-compatible agent            │
└──────────────┬──────────────────────────────────┘
               │
     ┌─────────┼──────────────────────────┐
     │         │                │         │
     ▼         ▼                ▼         ▼
┌────────┐ ┌────────┐    ┌─────┐ ┌───────────┐
│Portuni │ │Task    │    │CRM  │ │ other MCP │
│  MCP   │ │mgmt MCP│    │ MCP │ │  servers  │
└──┬─────┘ └────────┘    └─────┘ └───────────┘
   │
   ├── Database + vector search (graph, events, search)
   └── File storage (files, docs)
```

Portuni is the knowledge graph and the POPP structure authority. It owns: the organizational map (nodes + edges), accumulated knowledge (events), search (keyword + semantic), and structure mirroring — ensuring the POPP graph is consistently reflected across connected tools.

**Structure mirroring** is a core concept. When a new node is created in Portuni, it can trigger creation of matching structures in connected tools — a folder, a project, a record. Portuni doesn't manage those tools, it just ensures they all reflect the same organizational map. This makes POPP implementation practical: define the structure once, mirror it everywhere. Since POPP is a graph (not a tree), mirrored structures are flat — each node gets its own folder/project/repo. The graph holds the relationships, the filesystem doesn't try to.

External tools (task management, CRM, file storage, code hosting) stay separate, each accessed via its own MCP server. Portuni doesn't sync with or duplicate their data. They're composed at the agent level. Events can reference external records via URL.

Any MCP-compatible agent can connect. Portuni uses standard MCP over Streamable HTTP (remote) — this is required for Claude Code compatibility in global MCP config, where SSE is not accepted. The auth flow (Google OAuth) is agent-agnostic. For agents that only support stdio transport, a thin local proxy can bridge to the remote server.

Current implementations: task management = Asana MCP, CRM = Airtable MCP, file storage = Google Drive, auth = Google Workspace. These are choices, not requirements — the architecture supports any tool with an MCP server.

**LLM independence:** team members don't need to use the same LLM or subscription. Each person picks their own terminal agent — Claude Code, Mistral Vibe, Codex CLI, or anything that supports MCP. Portuni sees users, not models. The audit trail logs who did what, regardless of which LLM they used.

**Note: model quality matters.** Agents produce the actual work outputs — documents, code, analysis — that get shared via Portuni. A stronger model produces better outputs, suggests more relevant events to log, and finds better context during traversal. A weaker model produces weaker work. Since the human decides what gets logged and shared (per design principles), they are the quality gate — but they can only gate what the model produces. Teams should be aware that the value they get from Portuni directly correlates with the capability of their agents.

## Deployment models

Two interaction modes. They coexist — same graph, same permissions, same audit trail.

### Terminal agent (deep work)

```
Terminal → any MCP agent (local) → Portuni MCP
```

Full power, interactive sessions. Code, complex reasoning, long context. Uses your LLM subscription (e.g. Claude Pro/Max). For focused work at your computer.

### Messaging agent (quick interactions)

```
Messaging app (phone or desktop)
    │ (E2E encrypted)
    ▼
VPS
    ├── Messaging daemon (always on, handles protocol)
    ├── Thin custom gateway
    │    - maps messaging identity → organizational identity (Google)
    │    - gets Portuni JWT
    │    - calls LLM (using user's subscription)
    │    - calls Portuni MCP tools
    └── sends reply back
```

Quick capture, questions, lightweight interactions. Works from any device — phone in a meeting, desktop between tasks. A thin, auditable gateway you fully control.

Requirements for the messaging protocol:

- Open source (client and server)
- End-to-end encrypted by default
- Supports voice notes, attachments, media
- Desktop and mobile apps
- Has a CLI/API for programmatic access

Identity linking (one-time setup per user): each user links their messaging account to their Google identity in Portuni settings. Permission checks are enforced server-side by Portuni — the gateway is untrusted transport.

Capabilities: text, voice notes (transcribed), photos, quick event capture, search the graph, get context.

Cost: The messaging agent makes LLM API calls per interaction — this is per-token billing, not subscription-based. LLM provider subscriptions (e.g. Claude Pro/Max) cannot be used for server-side API calls by third-party tools — this is a ToS restriction enforced by providers. For quick interactions (event logging, short questions), costs are low — typically a few cents per interaction. The gateway is LLM-agnostic: use whatever provider/model is cheapest for lightweight tasks. Transcription costs are negligible.

Current choice: Signal via signal-cli. Chosen for security, open source, and cross-platform support (iOS, Android, macOS, Windows, Linux).

## Secrets management — Varlock

All secrets managed via Varlock (https://varlock.dev) — an AI-safe env management tool. Agents read the `.env.schema` (variable names, types, descriptions) but never see actual secret values. Secrets are resolved at runtime from a pluggable backend.

Backend: Bitwarden, Enpass, or 1Password — via Varlock plugin or `exec()` fallback for any CLI tool. Choice of password manager is independent of Varlock.

What's in `.env.schema` (committed to repo, visible to agents):

```
# @defaultSensitive=true @defaultRequired=infer
# ---
# @type=url @required
TURSO_URL=
# @type=string @required @sensitive
TURSO_AUTH_TOKEN=
# @type=string @required @sensitive
GOOGLE_CLIENT_SECRET=
# @type=string @required @sensitive
OPENAI_API_KEY=
```

What's NOT visible to agents: actual values. Resolved via `varlock run -- node server.js`.

Leak prevention:

- `varlock scan` as pre-commit hook — catches secrets in AI-generated code
- Runtime log redaction for sensitive values
- Agents never `cat .env` or `echo $SECRET`

This applies to all MCP connections: Portuni server credentials, external tool API keys, OAuth secrets, embedding API key.

## Security model

> **Current state (Phase 1.5, 2026-05-05):** Phase 1.5 ships with a
> single shared Turso service token per org, distributed by the org
> admin to each teammate; the desktop app stores it in the OS
> keychain (see `docs/auth-refactor-plan.md` and
> `docs/vision/portuni-as-workspace.md`). There is no per-user
> identity in the backend yet — every change recorded by the sidecar
> looks like "the org" did it.
>
> The model below is the **Phase 2 target**: pluggable identity
> adapters (Google OAuth + Workspace Groups is the first/canonical
> adapter; future orgs may want Microsoft, Okta, GitHub, SAML, …)
> with per-user attribution. Land before opening Portuni outside
> trusted-circle distribution.

### Authentication

Users authenticate via a pluggable identity adapter. The first/canonical adapter ships Google OAuth 2.0 — the JWT token identifies who is making requests, and every event, node, and file is attributed to a user. Other adapters (Microsoft Entra, Okta, GitHub, SAML, …) bolt on as additive Tauri commands + keychain entries; the backend treats each adapter's ID token uniformly.

### Permissions via Google Workspace Groups

Permissions are managed in Google Workspace, not in Portuni. No user_roles table, no permission management UI. Adding someone to a project = adding them to a Google Group.

Portuni reads group memberships at login via the Admin SDK Directory API (available on all Workspace tiers including Business Standard). Group memberships are cached and refreshed periodically.

Setup: A service account with domain-wide delegation, scoped to `admin.directory.group.readonly`. Impersonates an admin user to read memberships.

Permission groups (in Google Workspace):

| Google Group | Portuni scope | Can do |
|---|---|---|
| admins@example.com | admin | everything + POPP sync, summary refresh, user management |
| managers@example.com | manage | read + write + create nodes, connect, disconnect, update nodes |
| team@example.com | write | read + log events, resolve, supersede, store files |
| (any authenticated user) | read | get context, search, list nodes, get node |

Highest matching group wins. User in both portuni-team and portuni-managers gets `manage`.

Node-level access via project groups:

For restricting access to specific nodes, use project-specific Google Groups:

| Google Group | Access |
|---|---|
| apollo@example.com | write access to Apollo project node and children |
| stellar-gws@example.com | write access to Stellar GWS project node and children |

Nodes have a `visibility` field:

| Visibility | Who sees it |
|---|---|
| team | All authenticated users (default) |
| private | Only the creator |
| group | **Planned, not yet implemented.** Members of a specified Google Group (stored in node `meta.access_group`). Not included in the current CHECK constraint -- will be added when the feature is built. |

Portuni checks (planned for group visibility): does the user's Google Group list include the node's access group? If yes, access granted. If no, fall back to global scope (read-only unless they have manage/admin globally).

The flow:

1. User connects via Google OAuth
2. Portuni calls Admin SDK Directory API → list user's groups
3. Cache group memberships (refresh every 15 min)
4. JWT issued with: user identity + resolved global scope + list of project groups
5. Every tool call validated:
   - Global scope check (can they do this action at all?)
   - Node-level check (can they access this specific node?)

Phase 1 (solo): everything is `team`, only global scope matters. Phase 2 (team): enable node-level group checks.

### What agents can NOT do

- **Read secrets** — Varlock ensures no credentials in agent context
- **Delete nodes or events** — events are append-only, nodes can be archived but not deleted (audit trail)
- **Modify other users' events** — you can supersede, but the original stays with its author
- **Access stored files directly** — agents get file URLs from Portuni, but actual file access goes through the storage provider's own auth
- **Bypass scope restrictions** — MCP tool calls are validated server-side, not client-side
- **Escalate permissions** — scopes come from Google Groups, not from the agent or user request

### Audit trail

| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK ulid |
| user_id | TEXT | FK who |
| action | TEXT | "create_node", "log_event", "connect", "update_node", … |
| target_type | TEXT | "node", "edge", "event", "file" |
| target_id | TEXT | what was affected |
| detail | TEXT (JSON) | what changed (before/after for updates) |
| timestamp | DATETIME | |

This is write-only, never edited. Answers "who changed what, when."

### MCP connection hardening

Each MCP server connection in the agent's config has:

- **Scoped token** — per-agent, per-user, with permission scope from Google Groups
- **Rate limiting** — prevent runaway agents from flooding the graph with events
- **Request logging** — all tool calls logged server-side
- **Token rotation** — tokens expire, refresh via Google OAuth

## Organizational structure — POPP

The graph follows the POPP framework — defined in a separate repository that captures the canonical entity definitions and relationships.

POPP maps all organizational activity into **Processes, Areas (Oblasti), Projects, and Principles**. These become node types in the graph, alongside **Organization** nodes that represent top-level entities (e.g. Acme, Globex, Initech, Stark). The exact definitions and relationships are defined in the repo — Portuni implements, not redefines.

**POPP is a graph, not a tree.** All POPP entity types are peers — including organizations. A project can relate to multiple areas, multiple processes, multiple principles via `related_to`, `applies`, and `informed_by` edges. The one exception to peer-level freedom is the organization invariant: every non-organization node `belongs_to` exactly one organization (single scoping parent, no orphans, no multi-parent). Relationships are expressed as typed, directed edges — not as a folder hierarchy. There is no "top level" — any node can be a starting point for traversal.

## The graph

### Nodes

Any POPP entity or knowledge container.

| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK ulid |
| type | TEXT | POPP type (strictly enforced, one of five): "organization", "project", "process", "area", "principle". Enforced by Zod enum in tools and CHECK constraint on this column |
| name | TEXT | human-readable name |
| description | TEXT | what this node represents |
| summary | TEXT | auto-generated distillation of the node's events — what an agent needs to know without reading every event |
| summary_updated_at | DATETIME | when summary was last regenerated |
| meta | TEXT (JSON) | type-specific data |
| status | TEXT | "active", "completed", "archived". Strictly enforced via CHECK constraint |
| visibility | TEXT | "team" (default), "private". Strictly enforced via CHECK constraint. "group" is planned but not yet implemented |
| created_by | TEXT | FK |
| created_at | DATETIME | |
| updated_at | DATETIME | |

### Node embeddings

Vector representations of nodes for semantic search.

| Column | Type | Notes |
|---|---|---|
| node_id | TEXT | PK FK to nodes |
| embedding | FLOAT[1536] | vector of name + description + summary |

Updated when: node is created, description changes, or summary is regenerated.

### Edges

Typed, directed relationships between nodes.

| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK ulid |
| source_id | TEXT | FK |
| target_id | TEXT | FK |
| relation | TEXT | see relation types below. Strictly enforced via CHECK constraint |
| meta | TEXT (JSON) | optional — edge-specific data |
| created_by | TEXT | FK |
| created_at | DATETIME | |

Constraints: `CHECK(source_id != target_id)` prevents self-loops. ULID length enforced on id.

Relation types (strictly enforced, four flat relations):

| Relation | Meaning | Example |
|---|---|---|
| related_to | lateral, semantically light connection. Near-default -- use when no more specific relation fits | "Stellar project" → "Atlas project" (similar client type) |
| belongs_to | entity is scoped to a larger scope. Multi-parent allowed -- not a tree | "License procurement" → "Area: Google Workspace services" |
| applies | concrete work uses a repeatable pattern | "Apollo" → "AI competency assessment process" |
| informed_by | knowledge transfer (learned from, drew on, referenced) | "New GWS project" → "Stellar project" |

Enforcement spans three layers:
- **Zod `z.enum`** on the MCP tool input (portuni_connect, portuni_disconnect)
- **SQL `CHECK` constraint** on `edges.relation` (blocks direct inserts that bypass the tool layer, e.g. seed scripts or migrations)
- **Single source of truth** in `src/popp.ts` — a dependency-free constants module imported by the backend (`src/schema.ts` and tools) and by the app frontend (`app/src/types.ts`) via a relative path. Backend and frontend cannot drift, because there is no duplicated list to synchronize

Edges are directed. `source` is the entity that has the relationship, `target` is what it points to. For bidirectional relationships, create two edges or query both directions.

No edge type is privileged. The graph is the structure, not a folder tree projected onto it.

**Organization invariant.** There is one exception to the "no privileged edge" framing: every non-organization node must have exactly one `belongs_to` edge pointing to an `organization`. No orphans, no multi-parent. This is the only topological invariant on the graph and it exists because ownership must be unambiguous -- a node cannot exist outside an organizational scope. It is enforced at three layers:

- **Tool layer create:** `portuni_create_node` requires an `organization_id` parameter for non-organization types and atomically inserts the node plus its `belongs_to` edge in a single batch. The node never exists in an orphan state.
- **Tool layer mutate:** `portuni_connect` rejects a second `belongs_to -> organization` for a non-org source. `portuni_disconnect` rejects removal of the last `belongs_to -> organization`.
- **DB layer:** two triggers on `edges` (`prevent_multi_parent_org` on INSERT, `prevent_orphan_on_edge_delete` on DELETE) catch any direct SQL that bypasses the tool layer. Defense in depth for seed scripts, migrations, and future REST endpoints.

On startup, `ensureSchema` runs an integrity sweep across all non-organization nodes (including archived). A violation aborts startup with the list of offenders -- Portuni refuses to serve requests on an inconsistent graph, and the error message is the punch list for the human to fix. There is no silent warning, because silent warnings were how orphans accumulated in the first place.

An earlier draft of the spec allowed a process to "belong to multiple organizations." That multi-parent rule is removed -- every non-organization node has one and only one organizational home.

**Principles are culture, not pointers.** There is no `guided_by` edge. Principles function as cultural defaults for the organizations they belong to -- anything within a scope implicitly follows the principles of that scope. Agents should look at principles in the relevant organization when unsure how to act. Explicit edges from every entity to every applicable principle would bloat the graph with low-signal pointer spaghetti and miss the point of culture as an ambient default.

**No hierarchy in disguise.** The spec does not include `depends_on`, `instance_of`, `part_of`, or similar relations that encode operational sequencing, containment, or containment-like hierarchy. A DAG is still a tree with arrows: POPP is a rhizome, not a DAG. Operational prerequisites belong in events (blockers) or external task systems; the graph holds semantic relations, not execution order.

### Edge lifecycle

Edges are created and corrected across the lifetime of the graph, never as a one-time ceremony. Two complementary paths, both human-driven.

**At write time.** When a node is created or its description changes meaningfully, the agent searches the graph for candidate edges — across all POPP types, without a per-type checklist. The human validates each candidate: accept, reject, adjust the relation, or attach a missing counterpart as a new node on the spot. This is the primary opportunity to land correct edges early, and the main mechanism by which a newly added node connects back into the rest of the graph.

**Organically at read time.** When someone reads a node and notices that a connection is missing, they create the edge right then. From that moment on, everyone benefits. No periodic audit, no staleness dashboard, no session-start warnings. The backlog of missing edges between older nodes is resolved by the act of using the graph — if an edge is never missed during use, it does not need to exist.

**Edge currency vs. node currency.** Whether an edge still reflects reality is the concern of this lifecycle. Whether a node's description still reflects reality is a separate concern, handled by POPP metadata (status, update time, ownership) — the graph is the canonical record, and when reality changes, the human updates the node. These two concerns should not be conflated.

**Pending.** Node ownership requires a schema change: the `nodes` table currently has `created_by` but no explicit `owner` field. Without an explicit owner distinct from the creator, there is no single person responsible for reviewing and updating stale node content. Additive migration, tracked as a TODO — to be addressed before node currency workflows are designed.

### Events

Attached to nodes. The core unit of knowledge — anything worth remembering.

| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK ulid |
| node_id | TEXT | FK which node this event belongs to |
| type | TEXT | "decision", "discovery", "blocker", "reference", "milestone", "note", "change". Strictly enforced via CHECK constraint |
| content | TEXT | what happened, in plain language |
| meta | TEXT (JSON) | type-specific data |
| status | TEXT | "active", "resolved", "superseded", "archived". Strictly enforced via CHECK constraint |
| refs | TEXT (JSON) | array of related event IDs (cross-references). `CHECK(refs IS NULL OR json_valid(refs))` |
| task_ref | TEXT | optional external reference (e.g. task management URL, CRM record) |
| created_by | TEXT | FK |
| created_at | DATETIME | |

### Event embeddings

Vector representations for semantic search.

| Column | Type | Notes |
|---|---|---|
| event_id | TEXT | PK FK to events |
| embedding | FLOAT[1536] | vector of content + type + parent node name |

Updated when: event is created or superseded.

### Files

References to shared files in file storage, attached to nodes. Intentionally published — like a git commit, not continuous sync.

| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK ulid |
| node_id | TEXT | FK |
| status | TEXT | "wip" (draft, shared for collaboration) or "output" (final deliverable). Strictly enforced via CHECK constraint |
| drive_file_id | TEXT | |
| drive_url | TEXT | |
| filename | TEXT | |
| mime_type | TEXT | |
| description | TEXT | |
| created_by | TEXT | FK |
| created_at | DATETIME | |
| updated_at | DATETIME | when the remote version was last pushed |

### File sync state

> **Implementation note (2026-04):** the actual Phase 1 implementation diverged from the per-user `file_sync` table sketched here. Sync state is now split across two layers — Turso holds canonical remote state on `files` (`current_remote_hash`, `last_pushed_by`, `last_pushed_at`), and each device keeps "what I last saw" in a local SQLite at `~/.portuni/sync.db`. There is no `device_id` column in Turso. The pluggable `FileAdapter` interface (gdrive / dropbox / s3 / fs / webdav / sftp), routing via `remotes` + `remote_routing`, and `sync_key`-anchored paths replace the Drive-only assumptions in the schema below. See `docs/architecture/file-sync.md` for the live design and `src/sync/README.md` for the user-facing summary.

Per-user tracking of when each file was last synced (pulled or pushed). Used for conflict detection.

| Column | Type | Notes |
|---|---|---|
| file_id | TEXT | FK |
| user_id | TEXT | FK |
| synced_at | DATETIME | last time this user pulled or pushed this file |
| local_path | TEXT | where the file lives on this user's machine |

Primary key: (`file_id`, `user_id`). Updated on every `portuni_store` or `portuni_pull`.

Conflict = `file.updated_at > sync.synced_at` AND local file modified after `sync.synced_at`.

### Local mirrors

Per-user tracking of where nodes live on each user's local filesystem. Written by `portuni_mirror`, updated when the agent detects a path mismatch.

| Column | Type | Notes |
|---|---|---|
| user_id | TEXT | FK |
| node_id | TEXT | FK |
| local_path | TEXT | absolute path to the node's local folder |
| registered_at | DATETIME | when this mapping was created or last updated |

Primary key: (`user_id`, `node_id`). Created by `portuni_mirror { targets: ["local"] }`. Updated when the agent detects the stored path no longer exists and the user provides the new location.

**Resolution logic:** When the agent needs to access a related node's local folder:

1. Look up stored `local_path` for this user + node
2. If path exists on disk — use it
3. If path does not exist — ask the user where it is, update the mapping
4. If no mapping exists — the node has no local mirror for this user (remote-only)

No scanning, no guessing. The agent asks the user when reality drifts. This happens rarely (only when someone moves a folder) and one answer resolves it permanently.

### Users

| Column | Type | Notes |
|---|---|---|
| id | TEXT | PK ulid |
| email | TEXT | UNIQUE Google account email |
| name | TEXT | |
| google_refresh_token | TEXT | encrypted |
| created_at | DATETIME | |

## Summaries and embedding updates

Summaries and embeddings are not static — they stay current as the graph changes.

### When summaries regenerate

A node's summary is regenerated when:

- A new event is logged on the node (`portuni_log`)
- An event is resolved or superseded (`portuni_resolve`, `portuni_supersede`)
- Manually triggered (`portuni_refresh_summary`)

How: The server collects all active events on the node, sends them to an LLM with instructions to produce a concise summary of the current state — what's decided, what's blocked, what's the latest. The summary replaces the previous one.

Debouncing: If multiple events are logged in quick succession (e.g. an agent logging 5 things in a row), summary regeneration is debounced — wait 30 seconds after the last event before regenerating.

Cost control: Summary generation uses a cheap, fast model — not the primary agent model. Not every event triggers immediate regeneration — a dirty flag marks the node, and regeneration happens on next read (`portuni_get_context` or `portuni_get_node`). This is lazy evaluation, not a background job — consistent with the principle that Portuni doesn't initiate anything on its own.

### When embeddings update

Node embedding is regenerated when:

- Node is created
- `description` changes
- `summary` is regenerated

The embedding input is: `name + description + summary` concatenated.

Event embedding is generated when:

- Event is created
- Event is superseded (new event gets new embedding)

The embedding input is: `content + type + parent node name`.

### Cascade: event → summary → node embedding

```
portuni_log (new event on node X)
  → event embedding generated
  → node X marked dirty
  → (debounce 30s)
  → summary regenerated from all active events
  → node embedding regenerated from name + description + summary
```

This ensures that when you search for "client onboarding problems" you find both:

- Individual events that mention onboarding issues (via event embeddings)
- Methodology/project nodes whose accumulated summary reflects onboarding patterns (via node embeddings)

## Search

Two search modes, combined in one tool:

**Keyword search (FTS5)** — exact term matching. Fast, precise. Good for known terms: "OAuth", "StreamOne", "Stellar."

**Semantic search (sqlite-vec)** — meaning-based similarity. Searches across both event embeddings AND node embeddings. Finds conceptually related content even when wording differs.

`portuni_search` runs both by default and merges results. Node matches surface the node with its summary. Event matches surface the event with its node context.

## How context traversal works

When an agent starts working on something, it walks the graph. Since POPP is a graph (not a tree), traversal follows edges in all directions — there's no "up" or "down," just connected nodes.

```
Agent: portuni_get_context { node: "project:stellar-gws", depth: 2 }

Server traverses:

project:stellar-gws (depth 0)
    ├── events: 3 decisions, 1 blocker
    ├── files: proposal.pdf (output), license-research.md (wip)
    ├── mirrors: drive, asana
    │
    ├─[applies]→ process:gws-implementation (depth 1)
    │   ├── summary: "Key learnings: admin access is always the bottleneck..."
    │   │
    │   ├─[applies]← project:atlas-gws (depth 2, sibling using the same process)
    │   │   └── summary: "Completed. Migration took 2 weeks..."
    │   │
    │   └─[applies]← project:sportega-gws (depth 2, sibling)
    │       └── summary: "Completed. License issues resolved via..."
    │
    ├─[applies]→ process:license-procurement (depth 1)
    │   └── summary: "Standard process: quote via StreamOne Ion..."
    │
    ├─[belongs_to]→ area:google-workspace-services (depth 1)
    │   └── summary: "Core service area. 4 active projects..."
    │
    └─[informed_by]→ project:atlas-gws (depth 1)
        └── summary: "Earlier GWS rollout we reused onboarding materials from"
```

Note: no edge type is privileged. All four relations (`related_to`, `belongs_to`, `applies`, `informed_by`) are peers. Principles are not reached via an edge -- traversal into principles happens through their `belongs_to` edge to the scoping organization, or they are consulted as ambient culture.

Depth controls detail level:

- **depth 0:** full events + all files (wip + outputs) + mirrors
- **depth 1:** recent events + summary + outputs only
- **depth 2:** summary only

This keeps context size manageable while still surfacing connected knowledge.

## MCP tools

### Graph

**`portuni_get_context { node_id, depth?, max_tokens? }`** Traverse the graph from a node. Returns events, files (wip + outputs), mirrors, and connected nodes — with detail decreasing by depth. Triggers summary regeneration on dirty nodes. If `max_tokens` is set, server truncates intelligently — summaries before events, depth 2 before depth 1, older before newer.

**`portuni_search { query, mode?, node_type?, event_type?, status? }`** Hybrid search across nodes and events. `mode`: "auto" (default — keyword + semantic merged), "keyword", "semantic". Returns matching events with node context and matching nodes with summaries.

**`portuni_get_node { node_id }`** Single node with its events, files, summary, mirrors, and direct edges.

**`portuni_list_nodes { type?, status? }`** List nodes, filterable by type.

### Nodes and edges

**`portuni_create_node { type, name, description?, meta?, mirror? }`** Create a new node. Generates node embedding. If `mirror` is specified (e.g. `["drive", "asana"]`), triggers structure mirroring in connected tools.

**`portuni_connect { source_id, target_id, relation, meta? }`** Create an edge between two nodes.

**`portuni_disconnect { source_id, target_id, relation? }`** Remove an edge.

**`portuni_update_node { node_id, name?, description?, status?, meta? }`** Update node properties. Regenerates node embedding if name or description changed.

### Events

**`portuni_log { node_id, type, content, meta?, refs?, task_ref? }`** Log knowledge worth remembering across sessions. The human decides what to log — the agent suggests but doesn't log autonomously. Guidance for suggestions: decisions, discoveries, blockers, resolved issues, references, key changes, handoff context are worth logging. Routine actions (renamed file, ran tests, installed package) typically are not. Generates event embedding. Marks node summary as dirty.

**`portuni_resolve { event_id, resolution? }`** Mark event as resolved. Marks parent node summary as dirty.

**`portuni_supersede { event_id, new_content, meta? }`** Replace with newer version. New embedding generated. Marks parent node summary as dirty.

**`portuni_list_events { node_id?, type?, status?, since? }`** Query events with filters.

### Files

**`portuni_store { node_id, local_path, description, status? }`** Intentional publish — uploads file to file storage (into the node's mirrored folder), indexes in Portuni. `status`: "wip" (default) or "output". Like a git commit: you share when you're ready. Records the upload timestamp as the file's `synced_at`.

**`portuni_promote { file_id }`** Change a WIP file to output. Same file, just a status update.

**`portuni_list_files { node_id?, status? }`** List files with storage links. Filterable by node and status.

**`portuni_pull { node_id?, file_id? }`** Intentional pull — like `git pull`, not auto-sync. Two modes:

- **Pull node:** compares all published files on a node (remote) against local copies. Returns a status for each file: `new` (not local), `updated` (remote is newer, local unchanged), `unchanged`, or `conflict`. Agent presents the list, user picks what to pull.
- **Pull file:** downloads one specific file from storage to local folder.

**Conflict detection:**

A file is in conflict when BOTH are true:

- Remote version is newer than your last `synced_at` (someone else pushed)
- Local file is modified after your last `synced_at` (you have local changes)

Conflict resolution: agent-guided, no auto-merge, no silent data loss. The agent presents the conflict to the user and offers resolution options. Portuni does not merge files — it flags, explains, and the user decides.

The `synced_at` field: In the `file_sync` table — tracks per-user when each file was last pulled or pushed. This is the reference point for conflict detection.

### Summaries

**`portuni_refresh_summary { node_id }`** Force regenerate a node's summary and embedding. Useful after bulk event imports or when the auto-generated summary isn't good enough.

### Graph insight (Phase 3)

**`portuni_related { node_id }`** Find nodes likely related but not yet connected — based on node embedding similarity and shared connections. Suggests edges to create.

**`portuni_hub_nodes { }`** Nodes with highest connectivity — knowledge hubs.

## Structure mirroring

**`portuni_mirror { node_id, targets }`** Mirror a node's structure to specified tools. `targets` is an array of adapter names (e.g. `["files", "tasks", "code", "local"]`). Each adapter creates a matching structure in its tool and stores the reference back on the node.

**Technology is a mirror, not the structure.** Not every node needs every mirror. A POPP entity doesn't change because it happens to need a repo or a project board. The organizational graph stays clean — external references are just metadata hanging off the node:

```json
{
  "mirrors": {
    "files": { "folder_id": "...", "url": "..." },
    "tasks": { "project_id": "...", "url": "..." },
    "code": { "repo": "...", "url": "..." }
  }
}
```

Note: local filesystem mirrors are NOT stored on the node. Local paths are per-user and stored in the `local_mirrors` table. The agent resolves a node's local path by looking up the current user's mapping. Shared mirrors (Drive, Asana, GitHub) are the same for everyone and live on the node.

Any agent can ask "where is this project's repo?" or "what's the folder for this area?" without searching.

### Mirroring structure — two levels, then flat

Organization and shared drives have **type-level subdirectories** (`projects/`, `processes/`, `areas/`, `principles/`). Within each subdirectory, node folders are **flat** — no further nesting. The graph holds the relationships between them, not the filesystem.

This gives predictable navigation (you always know where to look by type) without deep hierarchy.

### Google Drive architecture — multiple shared drives

> **Implementation note (2026-04):** the routing policy described below is implemented data-driven via `remotes` + `remote_routing` tables, not hard-coded. The Drive backend is one concrete `FileAdapter` (Service Account, Shared Drives only); other backends slot in through the same interface. See `docs/architecture/file-sync.md` for the adapter design and Phase 1 limitations (SA-only auth, no domain-wide delegation).

One root shared drive doesn't work. Different orgs need separate access control, and one folder for everything is unmanageable. Instead, use **multiple Google Shared Drives** with a configurable **mirroring policy** that defines which node types go where.

**Example shared drives:**

- **Projects Hub** — all projects, regardless of org. Flat structure, one folder per project.
- **Shared Processes** — cross-org processes (e.g. license-procurement used by both Globex and Acme). One folder per process. Single source of truth — no copies in org drives.
- **Globex (org drive)** — Globex-internal processes, areas, principles.
- **Acme (org drive)** — Acme-internal processes, areas, principles.
- **Initech (org drive)** — same pattern.
- **Stark (org drive)** — same pattern.

**Mirroring policy** defines the mapping:

| Node type | Condition | Target drive |
|---|---|---|
| project | any org | Projects Hub |
| process | any | The org's drive it belongs_to |
| area | any | The org's drive it belongs_to |
| principle | any | The org's drive it belongs_to |

Since every non-organization node belongs to exactly one organization (enforced by the organization invariant), the mirroring target is always unambiguous. The earlier "shared processes" branch is removed — a process has one organization, and that organization's drive is its home.

The policy is configured once and applied consistently. No exceptions — predictability is the system.

**Example: Projects Hub (shared drive)**

```
projects/
    stellar-gws/
        ├── outputs/
        ├── wip/
        └── resources/
    atlas-gws/
    apollo/
```

**Example: Shared Processes (shared drive)**

```
processes/
    license-procurement/
        ├��─ outputs/
        ├── wip/
        └���─ resources/
    onboarding-framework/
areas/
principles/
```

**Example: Globex org drive**

```
projects/
areas/
    google-workspace-services/
    ai-transformation/
processes/
    hiring/
principles/
    start-with-assessment/
```

Note: License Procurement belongs to both Acme and Globex — it lives once in the Shared Processes drive. The graph expresses the shared ownership via edges. People from both orgs access the same folder.

### Node folder internal structure

Each node folder has a standard internal structure:

- **outputs/** — finished deliverables (published via `portuni_store` with status "output")
- **wip/** — work in progress (published via `portuni_store` with status "wip")
- **resources/** — reference materials, transcripts, research, context

This internal structure is the same everywhere — Drive, local filesystem, any mirror target. Additional folders may emerge per team convention, but these three are the baseline.

### Single source of truth

A file lives in one place. If a process is shared across orgs, its files live in the Shared Processes drive — not copied to each org. If a project touches multiple areas, its files live in the Projects Hub. People find files by understanding the mirroring policy, or by navigating the graph (UI or agent) which points them to the right drive/folder.

**`portuni_sync_mirrors { node_id? }`** Check that mirrors still match the graph. If a node was renamed, update the corresponding external structures. If `node_id` is omitted, syncs all nodes with mirrors.

Archiving: set node status to "archived" via `portuni_update_node`. The node stays in the graph — still traversable, its events and files still inform sibling projects. External mirrors stay as-is. Local cleanup is the user's responsibility.

### Local folder management

When `portuni_mirror { node_id, targets: ["local"] }` is called, Portuni creates a local folder for the node and registers the path in the `local_mirrors` table for the current user.

The local workspace mirrors the same structure as Drive: organization and shared drives have type-level subdirectories (`projects/`, `processes/`, `areas/`, `principles/`). Within each subdirectory, node folders are flat with standard internal structure.

```
~/Workspaces/portuni/                  ← configurable root (PORTUNI_WORKSPACE_ROOT env var)
├── acme/                              ← org mirror
│   ├── projects/
│   │   └── stellar-gws/
│   │       ├── outputs/
│   │       ├── wip/
│   │       └── resources/
│   ├── processes/
│   │   └── partner-account-management/
│   ├── areas/
│   │   └── google-workspace-services/
│   └── principles/
│       └── start-with-assessment/
├── globex/                            ← org mirror
│   ├── projects/
│   ├── processes/
│   ├── areas/
│   │   └── staffing-services/
│   └── principles/
└── globex_sdilene/                    ← shared (multi-org)
    ├── projects/
    ├── processes/
    │   └── navrhy-cenotvorba/
    ├── areas/
    └── principles/
```

Folder names are slug-ified from node names. Within each type subdirectory, folders are flat — no further nesting. Each node folder gets the standard internal structure (outputs/, wip/, resources/). The source of truth for where a folder actually lives is the `local_mirrors` table, not the convention.

**Why per-user:** Local paths cannot be stored on the node because each user's machine is different. Users may have different root directories, may move folders, or may not mirror a node locally at all. Shared mirrors (Drive, Asana, GitHub) are the same for everyone and live on the node. Local mirrors are per-user.

**Path resolution for related nodes:** When an agent traverses the graph and finds connected nodes, it checks `local_mirrors` for the current user to determine which of those nodes have local folders and where they are. Nodes without a mapping for this user are remote-only — the agent doesn't try to find them on disk.

**Path drift:** If a user moves a folder, the stored path becomes stale. The agent detects this when it tries to access the path and it doesn't exist. It asks the user for the new location and updates the mapping. No scanning, no guessing — one question, permanently resolved.

What goes in a local folder: whatever the agent puts there. Code, notes, scratch files. This is the agent's working directory for that node. Some of those files get intentionally published via `portuni_store`, the rest stays local.

Lifecycle:

- **Active:** local folder exists, agent works in it
- **Dormant:** node is still active but not recently worked on. Local folder stays.
- **Archived:** node status set to "archived" via `portuni_update_node`. Knowledge stays in graph. Local cleanup is the user's responsibility. An archived node can be restored by re-mirroring locally.

### Mirroring pattern

Portuni mirrors the POPP graph into connected tools. The pattern is the same for every target:

1. Create a matching structure in the target tool (folder, project, repo, …)
2. Store the external reference back on the node in `meta.mirrors`
3. Optionally rename when the node changes (`portuni_sync_mirrors`)

**This is not sync.** It's a one-time structure creation with a stored reference. Portuni doesn't poll external tools for changes. If the agent needs to interact with the mirrored structure (create tasks, edit files), it uses the tool's own MCP directly — using the reference from `meta.mirrors`.

Adapters are pluggable. Adding a new mirror target means implementing one adapter. Current targets: file storage (Google Drive), task management (Asana), code hosting (GitHub), local filesystem. Future targets follow the same pattern.

## Tech stack (current choices)

These are implementation choices, not architectural requirements. They can change without affecting the spec.

| Role | Current choice | Notes |
|---|---|---|
| Runtime | Node.js / TypeScript | |
| Database | Turso (libSQL) for team / production; local SQLite fallback for solo / testing | Recursive CTEs for graph traversal. Same libsql client, same schema, both modes. |
| Vector search | sqlite-vec | Same DB, no extra service |
| Embeddings | TBD — must be cheap, fast, multilingual (CZ/EN) | Evaluate before Phase 1 launch |
| Summary generation | TBD — cheap LLM, not the primary model | |
| FTS | Turso FTS5 | Keyword search alongside vector |
| File storage | Google Drive (googleapis npm) | |
| Auth | Google OAuth 2.0 + Admin SDK Directory API | |
| MCP transport | Streamable HTTP (remote) + stdio proxy (optional) | Required for Claude Code compatibility; SSE is not accepted by Claude Code in global MCP config. |
| Hosting | VPS | |
| Secrets | Varlock + password manager (Bitwarden/Enpass) | |
| Messaging agent | Signal via signal-cli | Phase 2 |
| Voice transcription | TBD — cheap transcription service | Phase 2 |

Why not a graph DB: At the expected scale (hundreds to low thousands of nodes), recursive SQL handles traversal fine. The model is graph-shaped, the storage doesn't need to be.

## Phases

### Phase 1 — Solo

- Database with full schema (nodes, edges, events, files, file_sync, embeddings, audit_log)
- Vector search for node + event embeddings
- Full-text index on event content + node name/description
- Summary generation on event changes (lazy, on read)
- Embedding cascade (event → summary → node embedding)
- MCP server (Streamable HTTP) with all tools except graph insight
- Simple web UI for graph browsing, node overview, and "mirror locally" action
- Google OAuth login
- Secrets via Varlock
- Permission scopes scaffolded but not enforced — solo user gets admin by default
- Audit trail on all mutations
- File storage structure mirroring (flat — each node gets its own folder)
- Seed initial POPP structure from evoluce repo
- Deploy on VPS, connect from any MCP agent
- Terminal agents only (messaging agent in Phase 2)

### Phase 2 — Team

- Auto-seed read scope on MCP connect: each mirror's `.mcp.json` / `.codex/config.toml` carries `?home_node_id=<id>`; the server seeds the home node + depth-1 neighbors before the first tool call. Harness-agnostic, deterministic.
- Multi-user with Google OAuth
- Permissions via Google Workspace Groups (Admin SDK Directory API)
- Node-level visibility via project groups
- Messaging agent: gateway + messaging daemon on VPS
- Identity linking (messaging account → Google identity)
- Quick capture from any device: text, voice notes (transcription), photos
- File storage sharing based on group membership
- Per-user event attribution
- Structure mirroring to task management tool

### Phase 3 — Smart graph

- `portuni_related` — suggest missing connections via embedding similarity
- `portuni_hub_nodes` — identify knowledge centers
- Auto-archive: staleness detection based on connectivity + event recency
- "What changed since I last worked on this?" — diff events since a timestamp
- Context budget estimation — estimate token cost of a traversal before returning it
- Methodology distillation — summarize accumulated events into updated node description

### Phase 4 — Product

- Multi-tenant: each organization gets its own graph, own POPP structure
- Onboarding flow: connect identity provider, define POPP structure (or use POPP framework templates)
- Pluggable tool mirroring adapters
- Self-hosted or managed deployment options
- Billing, usage tracking
- POPP as a framework becomes the differentiator — Portuni is how you implement it

## User onboarding — what people need to know

People don't need to understand the technical implementation (graph database, MCP, embeddings). They need three things:

**1. POPP as a mental model.** What a process is, what a project is, what an area is, what a principle is, what an organization is. Not the database schema — just the categories. "Everything we do fits into these types, and they connect to each other." If they get this, they can navigate the folder structure, because it mirrors POPP directly.

**2. Where things live.** The mirroring policy: projects are in the Projects Hub. Shared processes are in the Shared Processes drive. Org-specific stuff is in the org drive. This is the policy, it's consistent, learn it once, never guess again. The folder structure teaches the organizational structure.

**3. How to work with agents.** They don't need to understand the graph or MCP. They need to know: when you start work, tell the agent what project you're on. When you make a decision, the agent will ask if you want to log it. When you finish a file, store it. When you need context, ask for it. The agent handles the graph — the person handles the work.

The hardest part isn't any single concept. It's that people need to trust the system is predictable before they'll use it. That's why the folder structure and mirroring policy matter so much — they're the visible proof that the system is consistent.

## Open questions

1. **Event density at depth** — at depth 2+, how much from each node? Current proposal: summary only at depth 2+. Needs experimentation.
2. **POPP sync** — how does Portuni stay in sync with the evoluce repo? On server start? Webhook? Manual `portuni_sync_popp` tool?
3. **Edge weights** — should some connections be "stronger" than others? Could influence traversal priority and context inclusion.
4. **File versioning** — overwrite and let storage handle history, or track in Portuni?
5. **Summary quality** — auto-generated summaries may miss nuance. Should there be a way to manually edit a summary? Or just log a correction event?
6. **Bootstrap** — when creating a new project that `applies` an existing process, auto-create standard edges and seed events?
7. **Embedding model** — must be cheap, fast, and multilingual (CZ/EN). Evaluate options before Phase 1 launch.
8. **Mirror drift** — what happens when someone renames a folder or project manually in an external tool? Should `portuni_sync_mirrors` detect and fix this, or just warn?
9. **Multi-tenant isolation (Phase 4)** — separate Turso databases per tenant? Or shared DB with row-level isolation? Affects cost, complexity, and data privacy.
10. **Organization-level access control** — should `belongs_to` → organization edges affect visibility/permissions? Currently deferred — orgs are just node types with edges. If needed later, it's a query filter on traversal, not a schema change.

## Identified blind spots

### Critical — will block on day one

**1. Session start** Status: RESOLVED — agent-side concern, not a Portuni tool. The user initiates the session. The agent matches the current working directory to a known POPP path convention, then calls `portuni_get_context` or `portuni_list_nodes` to get context. This logic lives in agent startup instructions (CLAUDE.md, system prompt), not in Portuni.

Note: proactive/autonomous agents (agents that start sessions on their own, without user initiation) are out of scope for now. The current model assumes human-initiated sessions.

**2. Bootstrapping — cold start** Status: RESOLVED — not a migration problem. Start from scratch. Seed the POPP structure (areas, processes, principles, methodologies) from the evoluce repo. Then build knowledge organically — log events as work happens. Old knowledge gets added only when it becomes relevant (e.g. "we dealt with this before" → log it as a reference event). No bulk import needed.

**3. Simple UI for graph browsing** Status: RESOLVED — included in Phase 1. Agents are great for working within context, but discovering what's available requires a visual overview. A simple web UI that shows:

- The POPP graph (nodes, edges, structure)
- Node status, summaries, file counts
- "Mirror locally" action (equivalent to `portuni_mirror { targets: ["local"] }`)
- Who's working on what

This is not a full management dashboard — it's a read-mostly view with a few actions. The heavy work (logging events, creating nodes, connecting edges) still happens through agents via MCP. The UI is for orientation and discovery.

CLI is not enough for this. A team member joining an existing project needs to see the landscape, not type commands.

**4. Context budget** Status: RESOLVED — `max_tokens` parameter added to `portuni_get_context`. A depth 2 traversal on a well-connected node could return 50K+ tokens. Server truncates intelligently: summaries before full events, deeper depths before shallow, older before newer. Agent controls the budget based on its available context window.

### Important — will hurt within weeks

**5. Event quality / logging noise** Status: RESOLVED — human decides. The human decides what's worth logging, consistent with the core design principle. The agent can suggest ("should I log this decision?") but doesn't log autonomously. The `portuni_log` tool description guides the agent on what kinds of things are typically worth logging (decisions, discoveries, blockers, references) vs not (routine actions, intermediate steps), but this is guidance for the agent's suggestions, not enforcement.

Summaries act as a natural noise filter — even if some low-value events get logged, the summary regeneration prompt focuses on decisions, discoveries, and blockers.

**6. Error handling / offline** Status: RESOLVED — fail gracefully. If Turso is unreachable, Portuni tools return clear errors. The agent informs the user and offers to work without Portuni. No local buffering, no caching, no complexity. The session's knowledge is not captured — the user can log important events manually later when the connection is back. Consistent with the "intentional, not automatic" principle.

**7. Schema migration** Status: RESOLVED — deal with it as it comes. Turso supports ALTER TABLE. Additive changes (new columns, new tables) are trivial. Destructive changes are rare and handled when they arise. No migration framework needed at this scale. If it becomes a problem, it's a good problem — it means Portuni is being used enough to evolve.

**8. Monitoring / observability** Status: DEFERRED — not Phase 1. Add when something breaks that you didn't notice.

### Good to think about — not urgent

**9. Concurrent agents on same node** Two agents working on the same node. Events: fine (append-only, both succeed). Files: `portuni_store` on the same filename from two agents = last-write-wins in storage. The conflict detection in `portuni_pull` helps, but if both push without pulling first, one overwrites the other. Mitigation: file-level locking or filename conventions. Not urgent at solo/small team scale.

**10. Node correction / mistakes** Events are append-only, nodes can't be deleted. What if you create a wrong node or a wrong edge? Archive is for completed things, not mistakes. Need a "void" or "soft delete" mechanism — set status to "voided", excluded from traversal and search, but still in audit trail. Not urgent but will be needed.

**11. Multi-language embeddings** Events are CZ/EN mixed. text-embedding-3-small handles multilingual okay but not great for Czech. This affects search quality — a Czech query might miss an English event and vice versa. Voyage-3 or multilingual-e5-large could be better choices. Worth testing before Phase 1 launch. Added as open question #7.

**12. Import from existing tools** Beyond bootstrapping: ongoing knowledge capture from tools that aren't MCP-connected. Task management comments contain decisions. Chat threads contain discoveries. Documents contain analysis. Options:

- One-time migration scripts per tool
- Periodic extraction jobs (automation workflows that scan tools for new content and log as events)
- LLM-assisted: feed a document or thread to an LLM, ask it to extract events

Not Phase 1, but important for making the graph rich enough to be useful.

**13. Proactive / autonomous agents** Status: NOTED — out of scope for now, per design principles. Portuni is built on human-agent symbiosis. The current spec assumes human-initiated sessions. System-level automation can exist on top of Portuni but is a separate layer:

- A management job that prunes stale events, regenerates summaries (system-level, scheduled)
- A monitoring job that flags nodes without recent activity (system-level)
- An import pipeline from connected tools (n8n workflow, system-level)

These are system automation, not autonomous agents. They run with explicit configuration, not self-directed behavior. The distinction matters: a cron job is predictable, an autonomous agent is not.