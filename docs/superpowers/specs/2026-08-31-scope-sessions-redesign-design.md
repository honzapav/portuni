# Scope & sessions redesign: deterministic task context

Portuni limits an agent's context deterministically so it cannot silently
pick up the wrong input or write outside its task. The current model covers
only reads, its elicitation is unenforceable, and sessions die with the
process. This spec replaces scope modes with server-derived session types,
extends scope to writes, makes elicitation real, and turns sessions into
persistent domain objects with suspend/resume. It also adds the Přehled
(overview) tab, project health, and fixes eight write tools that today have
no access check at all.

Impact analysis grounding this spec: see the file/line inventory in the
session that produced it; key structural facts are restated inline where a
decision depends on them.

## Concepts

**Session** = one unit of agent work with an explicit context. Becomes a
persistent domain object (see Data model): anchor, read set, write set,
audit, agent-conversation pointer, state.

**Session type** is derived by the server from the authentication path —
never self-declared:

| Type | How recognized | Anchor | Elicitation channel |
|---|---|---|---|
| `interactive_task` | connection carries `?home_node_id` (desktop-spawned terminal, mirror `.mcp.json`) | task node | MCP protocol elicitation dialog; fallback below |
| `interactive_chat` | `via: "oauth_grant"` (connector: claude.ai, Claude Desktop chat, Claude Code added as connector) | none — read scope = everything permissions allow | dialog for hard floors and writes only |
| `headless` | device token minted with a new `headless` flag (admin-granted credential) | task node (required; connection without `home_node_id` is refused) | none — deferred review (audit + PR/session log) |

`env` mode (solo, loopback) keeps its current behavior and is out of scope
here. The `PORTUNI_SCOPE_MODE` env var and the strict/balanced/permissive
modes are **removed**: strict becomes the model, balanced existed only to
damp the fatigue of fake elicitation, permissive dissolves into the
`headless` type. `session_init`/`session_log` responses and audit payloads
drop `mode` and gain `session_type`.

**Read scope** = anchor + depth-1 seed, growing during the session:

- **Edge-reachable expansion** (target reachable from the current scope set
  via graph edges): auto-approved + audited. The server computes
  reachability itself — the classification is never in the agent's hands.
- **Disconnected jump** (target found only via search, no edge path):
  refused unless the call carries a declared reason; the server stamps the
  audit entry `disconnected` regardless of what the agent claims.
  Interactive types confirm via elicitation instead; headless proceeds with
  the reason and the jump is surfaced prominently in review (session log,
  RALPH PR description).
- **Hard floors** (`meta.scope_sensitive`, `visibility: private` owned by
  another user): always elicit in interactive types; always refused in
  headless.
- Nodes **created by the session** enter its read and write set
  automatically — a task's outputs are part of its context by definition.
- Repeated disconnected jumps to the same node are a signal of a missing
  edge in the graph; the audit should make that pattern visible.

**Write scope ⊆ read scope, stricter:**

- `interactive_task` / `headless`: write set = home node (its files, edges,
  events, responsibilities, attributes). Expansion of the write set is only
  via elicitation (interactive) and impossible for headless mid-run.
- `interactive_chat`: write set starts empty; every write elicits.
- Enforcement lives in the **domain layer**, not the MCP tool layer —
  otherwise it is bypassed by REST (the sidecar's `LOCAL_TOOLS` in central
  mode reach central through the same REST routes) — see Enforcement
  points.
- Actors and sync-remote administration are global registries, explicitly
  **scope-exempt** for writes (permissions still apply).

**Search is discovery, not ingestion.** `portuni_search_files` and the
global form of `portuni_list_nodes` are gated by permissions only, in every
session type. Hits return references plus a bounded snippet (enough to
judge relevance, capped in length and count). Reading a hit's full content
is the scope event and follows the expansion rules above.
`decideGlobalQuery`, `guardListScope`'s global branch, and the duplicated
inline gate in `tools/nodes.ts` are removed.

**Elicitation** moves from the honor system to MCP protocol elicitation
(`elicitInput`; SDK ≥1.29 already supports it):

- At `initialize` the server inspects client capabilities. Clients that
  declare `elicitation` get real dialogs; clients that do not fall back to
  today's structured-refusal + declared-confirmation convention (still
  audited, still server-classified).
- The agent-mode front door (`agent-transport.ts`) must proxy
  server-initiated elicitation requests upstream→downstream and advertise
  the real client's capabilities upstream; today it declares
  `capabilities: {}` and has no reverse path — without this, central-mode
  desktop sessions would never see a dialog.

## Enforcement points

The write gate is a domain-layer function taking a session context
(type, write set) so all three surfaces share it:

- MCP tools (all ~25 mutating tools; see Hotfix for the eight that today
  lack even a visibility check).
- REST routes: agent-originated calls (central client of the agent-mode
  sidecar) carry a session context and are gated. The desktop UI's own
  REST calls are the documented exemption — the UI acts as the human — and
  are marked as such by their auth path (session JWT / Tauri proxy), not by
  route.
- Deterministic consumers (future in-app automation) call the same guarded
  domain functions with a session context — one semantics, no LLM required.

## Disk contract

Two planes, one contract:

1. **Seed on real paths** (unchanged): at spawn the desktop app computes
   the sandbox profile — rw on the home mirror, ro on depth-1 neighbour
   mirrors. The Seatbelt profile is frozen for the process lifetime.
2. **Projection directory for mid-session expansions**: the sandbox
   additionally allows one per-session projection directory from spawn.
   The contract is: *expanded nodes appear there as readable files*. The
   v1 backend is **hardlinks** (no data duplication, content always
   current) created and maintained by the mirror-watcher (which already
   watches mirrors) and cleaned up by the app at session end — the agent
   never manages it. The backend can later be swapped (e.g. a virtual
   filesystem) without touching the contract; a virtual FS is explicitly
   NOT part of this spec (macOS mount complexity, new failure modes).
3. **Restart consolidates**: on resume the sandbox profile is recomputed
   from the session's accumulated read set, so previous expansions become
   real-path mirrors. The projection covers only the gap between an
   expansion and the next restart.

`portuni_read_file` continues to work for anything in scope (sidecar reads
the local mirror when one exists; the routed remote only when this machine
has no mirror). The retired `.portuni-scope` copy staging stays retired;
`ScopeReconciler` and its call sites are deleted.

## Persistent sessions

### Data model (new tables, sketch)

`sessions`: `id, node_id (anchor; NULL for interactive_chat), user_id,
session_type, cli (claude|codex|vibe|…), profile_id, agent_session_id,
state (running|suspended|closed|archived), handoff_path, handoff_hash,
created_at, last_active_at, closed_at`.

`session_scope`: `session_id, node_id, added_via (seed|edge|disconnected|
created|elicited), reason, added_at` — the read set and its audit in one
place. Write-set entries carry a `writable` flag.

Session-scope state moves from the in-memory `SessionScope` object to these
rows (the in-memory object becomes a cache over them). This is what makes
suspend/resume, the review UI, and deterministic consumers possible.

### Lifecycle

- **Suspend**: agent writes a handoff (below), server stores its hash and
  the agent-conversation pointer; terminal closes; state → `suspended`.
- **Resume**: app respawns the terminal in the same mirror, recomputes the
  sandbox profile from the stored read set, re-materializes the projection,
  and either continues the agent conversation (`claude --resume <id>`, only
  offered while the conversation still exists under the stored profile —
  the server checks) or starts fresh from the handoff. Handoff-resume works
  across profiles; conversation-resume does not.
- **Archive**: closed sessions auto-archive after a period — a view filter,
  never deletion. The durable core (record, audit, handoff) outlives every
  CLI's transcript retention by design.

### Handoff

- One file per session: `wip/sessions/<session-id>-handoff.md` — a normal
  synced path, so it lands on Drive and is visible to the team. (Decision
  deferred to implementation: a fourth synced root `sessions/` instead of a
  `wip/` subfolder, if mixing with human content proves noisy.)
- Written by the agent at suspend (and by the RALPH loop between
  iterations — same mechanism). The session record stores the file's hash;
  on resume a differing hash is surfaced (“handoff edited since suspend”)
  and the edited version is used — editing the handoff is a legitimate
  steering channel, it just must be visible.
- History is kept; cleanup is a manual concern, never automatic.

### Naming & UI

- Default name `node · date`, enriched from the handoff's title at suspend;
  always renamable. Shown with state, last activity, CLI + profile, write
  count.
- **Node detail**: sessions of that node.
- **Přehled** (below): sessions across the workspace — the same list serves
  as the headless review surface (what a session read, where it expanded,
  disconnected jumps, what it wrote).

## Spawn UX

- **No automatic first prompt.** Deterministic provisioning (seed on disk,
  `PORTUNI_SCOPE.md` fattened to contain what the orientation prompt used
  to fetch: context, responsibilities, recent events, handoff pointer)
  makes the orientation round unnecessary. The terminal starts empty and
  ready; the user's first message is their actual task.
- **Instrument spawn phases** (spawn → sidecar calls → CLI boot → first
  token) so future tuning is measured, not guessed. Likely lever: the
  per-mirror `.claude/settings.local.json` restricting MCP servers to what
  the node needs (`enabledMcpjsonServers`).
- **Profiles**: a registry in settings — name + what to inject at spawn
  (env vars, typically `CLAUDE_CONFIG_DIR=…`, optionally a custom command).
  Portuni never detects or parses the user's own profile mechanism. Zero
  registered profiles → the feature is invisible and spawn runs the plain
  CLI. Default profile per organization; per-spawn picker when ≥2 exist.
  The session record stores the profile; hitting a rate limit is handled by
  suspend → handoff-resume under another profile.

## Přehled (overview tab)

New default tab beside Graf and Práce, composed deterministically:

- **Sessions**: running + suspended across the workspace; headless review
  queue (disconnected jumps to inspect, batch PRs awaiting merge).
- **Vyžaduje pozornost**: processes in `at_risk|broken` ∪ areas in
  `needs_attention` ∪ projects with `health ≠ on_track`; plus sync
  conflicts and pending access requests.
- **Poslední aktivita**: recent events (`portuni_log`), recent session
  writes.
- **Nové nody**: recently created nodes (human- and agent-created alike).

## Project health

New `health` column on nodes, meaningful for `project` only:
`on_track | at_risk | off_track` (Asana vocabulary), default `on_track`,
orthogonal to `lifecycle_state` — a project is `in_progress` *and* at risk;
folding health into the phase enum would lose the phase. Process and area
keep their existing attention states; organization and principle need none.
Touches: migration, `portuni://enums`, `update_node` schema, project detail
UI, docs site.

## Hotfix (ships first, independent of the redesign)

Eight mutating tools have **no access check at all** today (not even
`nodeVisibleTo`): `portuni_create_node`, `portuni_store`, `portuni_pull`,
`portuni_move_file` (a two-node write via `new_node_id`),
`portuni_rename_folder`, `portuni_adopt_files`, `portuni_delete_file`,
`portuni_snapshot` (writes a tracked file to an arbitrary `node_id`). Add
visibility checks now; the write gate lands on top later.

Also in the hotfix batch: the `scope-rules.md` doc claims the default mode
is `balanced` while the code defaults to `strict` — fix the doc (the modes
section will be rewritten in phase 1 anyway, but the published contract
should not lie in the meantime).

## Roadmap

Phases are ordered so each ships alone; later phases build on earlier ones.

- **Phase 0 — hotfix**: the eight unguarded write tools + the
  strict/balanced doc bug. Small, urgent, no design dependencies.
- **Phase 1 — scope model v2**: session types from auth path, write gate in
  the domain layer, edge-reachability expansion, discovery search, protocol
  elicitation + capability fallback, front-door elicitation proxying, mode
  removal (code, tool descriptions, `scope-rules.md`, docs site, tests —
  `scope*.test.ts` and `search-files.test.ts` are rewrites).
- **Phase 2 — persistent sessions**: tables, suspend/resume, handoff,
  projection directory + hardlink backend, restart consolidation, archive.
- **Phase 3 — spawn UX**: empty-terminal start, provisioning fattening,
  spawn instrumentation, profiles registry.
- **Phase 4 — Přehled + health**: the overview tab, `health` migration and
  UI. (Health + attention query can be pulled earlier if desired — it only
  needs the migration, not the session work.)

Each phase gets its own issue batch for the sandcastle loop; the batch PR
per phase follows the release conventions (docs site changes ride in the
same branch as behavior changes).

## Testing

Existing patterns (`test/`, fake adapter, fake CIMD-style seams). Per
phase: unit tests for reachability classification, write-gate coverage
across MCP/REST/domain entry points, elicitation capability fallback,
session persistence round-trips (suspend → resume, cross-profile
handoff-resume, expired-conversation degradation), projection lifecycle
(link, update, cleanup), attention query. The scope test suites encode the
old modes and are rewritten in phase 1. Gate: `scripts/agent-gate.sh`.

## Explicitly out of scope

- Virtual filesystem backend (contract allows it later).
- Per-organization connector narrowing (option b of the anchor discussion —
  can ride on the OAuth grant later).
- Codex/Vibe/Gemini resume pointers (per-CLI capability; Claude first).
- `env` (solo) mode changes.

## References

- Positioning & prior art: `docs/notes/2026-08-31-scope-positioning.md`.
- Current model docs being superseded:
  `sites/docs/src/content/docs/concepts/scope-enforcement.md`,
  `apps/server/mcp/resources/scope-rules.md`,
  `docs/architecture/scope-disk-projection.md`.
- Related wishlist: Asana 1217391830778071 (list closed terminal sessions).
