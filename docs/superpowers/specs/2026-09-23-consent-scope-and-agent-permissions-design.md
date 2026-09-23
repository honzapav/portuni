# Consent, scope and agent permissions: the session decides

Supersedes, in `docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md`,
the session-type table (types derived from the credential), the
reason-based read expansion, `confirmed_hard_floor`, and the `headless`
type; and, in `apps/server/domain/runner/permissions.ts`, the runner's own
question before `portuni_expand_scope`. Edge-reachable expansion, the
write gate in the domain layer, `session_scope`, persistent sessions and
the chat runtime stand unchanged. Analysis: `docs/notes/2026-09-23-souhlas-a-opravneni-agentu.md`.
Agent identity and connectors: Asana "Agenti jako servisní účty" and
"Konektory: MCP servery relace řídí Portuni".

## Principle

Three questions, each answered in one place, none on the agent's word:

| Question | Answered by | From |
|---|---|---|
| May this principal do this to this node? | permissions | grants to the person or the agent |
| Is this node part of the work in front of the person? | scope | the session's anchor and graph edges |
| Is there someone to ask, and did they say yes? | consent | the session's channel and the owner's answer |

Permissions always apply and apply alone: a search, a read, a write that
the principal may not do is refused before anything else. Scope exists
only where a person is watching; it keeps the agent from wandering, it is
not a security boundary. Consent is a real answer from the session's
owner in a dialog they saw, or it is nothing: no `reason` string, no
`confirmed_hard_floor` flag, no "the client can show dialogs so somebody
must have answered". Where nobody can be asked, nobody is asked, and
nothing is recorded as a refusal.

## The session is the record

Portuni creates the session before anything runs (already true for chat
tasks: `POST /sessions`, `X-Portuni-Spawn-Id`; for a hand-opened CLI and
a connector the MCP handshake creates it) and every gate reads it. The
credential only authenticates; the session authorizes. Two fields are
added to `sessions`; the anchor is the existing `node_id`:

- **`principal_kind`** `person | agent` and **`principal_id`**: the user,
  or the automation actor (`actors.type = 'automation'`) whose credential
  opened the session. The server sets both from the credential at
  creation (a person's device token or OAuth grant → person; an actor's
  token → agent); nothing on the client can choose them. A person's
  session may still run an agent's routine, but then the *actor* is the
  principal and the person is the owner who reads along.
- **`node_id`** is the anchor, set at creation (`?home_node_id`, or the
  task's node for a runtime-started session), never changed afterwards.
  `portuni_session_init` seeds a session that has no anchor yet and is
  refused once one is set (`ANCHOR_SET`); today it re-anchors on every
  call and the new anchor becomes writable, which is a write-scope bypass.
- **`channel`** `chat | cli | connector | none`, set by the server from
  how the connection arrived, never declared by the client:
  - `chat`: a `X-Portuni-Spawn-Id` naming a session the runtime created;
    the runtime answers dialogs from the chat (PR #473).
  - `cli`: a person's credential, no spawn id, a mirror's `?home_node_id`;
    the CLI renders dialogs itself.
  - `connector`: an OAuth grant (claude.ai, Claude Desktop); dialogs only
    when the client declared elicitation, and a phone may not show them
    (see Consent).
  - `none`: an agent principal. No dialog is ever sent.

**Binding is by principal, not only by owner.** Today a connection with a
spawn id binds to any running session of the same `user_id`. An agent
acting for its owner would bind to the owner's own chat session and
inherit its scope; the bind requires the credential's principal to equal
the session's `principal_kind`/`principal_id`.

**The record is authoritative only once written.** Session creation and
every grant are written to the store before the answer that depends on
them is returned; a failed write refuses the operation. Today
`session-persistence.ts` writes asynchronously and logs failures while the
in-memory scope decides; that order inverts.

The sidecar stops deriving a type from the credential
(`deriveAgentSessionType`, `deriveSessionType`): in a team workspace it
reads the session through `CentralClient`, in a personal workspace from
the local store. `session_type` stays as a derived, read-only view for
audit payloads (`interactive_task` = person with anchor, `interactive_chat`
= person without anchor, `agent` = agent principal). `env` disappears as
a session type: the desktop UI's own REST calls and the sync agent's
deterministic runs are not sessions and keep their documented exemptions
(next section); an agent's credential is never accepted on those paths
without a session.

## Permissions

A person's permissions are unchanged: global role from groups, node
grants to groups and users.

An agent is an automation actor with:

- **A credential of its own**: a device token bound to `actor_id`
  (`device_tokens.actor_id`, minted from the actor's page by `admin`;
  today's `headless` flag becomes "has an actor"). The token identifies
  the agent; the acting user is the actor's owner (`actors.created_by`).
- **A grant set** (`agent_grants`, rows of `actor_id, kind, value`):
  - **place**: an organization or any node, meaning its subtree; or one
    node, meaning that node alone;
  - **node type**: which types may be touched at all;
  - **operation**: `read`, `log_event`, `store_file`, `create_node`,
    `update_node`, `link`, `delete`, `share`. `delete` and `share` are
    never proposed automatically.
- **Effective rights = owner ∩ grant set**: an agent never exceeds the
  person who owns it; an owner who leaves or loses a right leaves the
  agent without it, and its runs end with that reason.
- **Hard floor**: a `scope_sensitive` node or another person's private
  node is reachable by an agent only through a grant that names that
  node itself; a subtree grant never covers it. This holds against the
  anchor and against anything already in the session's scope.

`agentMay(actor, node, operation)` is one pure function over the grant
rows and the owner's `canSeeNode`/scope tier, evaluated on the server
(central, or the local store in a personal workspace), never on the
device from a cached copy. Its result is deterministic: the same rows,
the same answer, with the matching grant row in the audit entry.

Grants are written two ways, both by a person:

- by hand on the actor's page;
- from repeated consent: when the same `(actor, place, operation)` has
  been approved by a person `N` times (default 3), Portuni records a
  **proposed grant** and shows it on the actor's page and in Přehled.
  A person accepts or dismisses it; nothing is granted on its own.

## Scope

Scope applies to sessions with a channel (`chat`, `cli`, `connector`):

- The read set is the anchor, its depth-1 neighbours and what the
  session reached through edges, as today. Seeding respects the hard
  floor: a `scope_sensitive` neighbour or another user's private node is
  not seeded (today it is, and the hard floor never applies to it again).
- A disconnected jump and a hard-floor read ask through a dialog. The
  reason-based path is removed: `portuni_expand_scope` keeps `node_ids`
  and `reason` (audit text only), drops `confirmed_hard_floor`, and every
  accepted node came through a dialog the owner answered. Without a
  dialog the tool returns `scope_expansion_required` with
  `request_id` (see Consent), never an expansion.
- The write set is the anchor, nodes the session created, and grants of
  the current turn. A grant is `(node, operation)`, not a node-wide
  `writable` flag: a yes to "zapsat událost" does not cover a delete on
  the same node in the same turn. `session_scope` gains `operation` and
  `turn_seq`; `writable` is derived from them.
- The hard floor is checked before scope membership on every read, for
  persons (dialog) and agents (grant naming the node); today
  `scope.has()` short-circuits it.
- `interactive_chat` (connector, no anchor) keeps permission-only reads
  and the durable write set of nodes it created.

Sessions with `channel = none` have no scope. Reads are permission-only,
like search. Every write is `agentMay` plus audit with the session and
task; a write the grant set does not cover is refused with
`grant_required` and a **request** (below) is recorded instead of a
refusal that pretends a person said no.

## Consent

- **One question per operation, asked by the server.** The runner stops
  asking before `portuni_expand_scope` (`permissions.ts` keeps
  `AskUserQuestion`, `ExitPlanMode` and file-tier decisions). The server's
  dialog is the only scope question, and the chat shows it in the same
  Confirmation card as every other question (PR #473).
- **A "yes" lasts one turn.** A grant from a dialog is recorded in
  `session_scope` with the owner's message it belongs to (`turn_seq`);
  it expires when the owner sends the next message. The next write to
  the same node asks again. The card says so ("platí do tvé další
  zprávy"). There is no "for the whole session" button in this spec; a
  standing right is a grant, made on the actor's or the node's page.
  - `turn_seq` is owned by the server: the `chat` runtime increments it
    when it records a `user_message`, and the increment closes every open
    dialog of the previous turn as `unanswered` (a request, below). For
    `cli` and `connector` the server never sees the person's messages, so
    a dialog grant there covers the one operation it was asked for.
- **Who answered.** In the `chat` channel the runtime knows who clicked:
  only the owner, checked on the server as `answer()` does today, and Ne
  is a real `declined`. Through the MCP protocol (`cli`, `connector`) the
  server only sees `accept`/`decline`/`cancel` from the person's own
  client: an `accept` is the owner's answer (their client is theirs), a
  `decline` or `cancel` cannot be told from a client that answered on its
  own and is recorded as `unanswered`. A connected window is never
  consent; the owner's answer is.
- **Outcomes** are kept apart in the audit and in the tool's answer:
  `accepted`, `declined` (the owner clicked Ne in the chat),
  `unanswered` (deadline, cancel, protocol decline, or the turn changed),
  `no_channel`.
- **A request outlives the dialog.** Every `unanswered` or `no_channel`
  outcome creates a row in `consent_requests` (`session_id`,
  `principal`, `node_id`, `operation`, `turn_seq`, `expires_at`,
  `state`), one per `(session, node, operation, turn)`: a retry finds the
  open row instead of creating a second. The tool returns `request_id`
  and the run goes on without the write. The owner sees the request in
  the chat and in Přehled ("Čeká na mě") and answers it there. Answering
  needs no live run: it writes a grant row (`operation` on that node,
  bound to the request, not to a turn) and re-checks permissions at that
  moment; the agent learns of it at its next tool call, or at resume for
  a suspended session. A grant from a request is applied to one
  operation (`state = applied`); a failed operation leaves it open for
  the retry. A closed or archived session expires its requests; expiry
  otherwise defaults to 7 days.
- **The dialog deadline stays bounded** (`ELICIT_TIMEOUT_MS`); a longer
  wait runs into the client's tool-call timeout. The request is what
  makes a late answer possible.

## One gate

`domain/authorize.ts` replaces the pair `guardWrite` + `decideRead`:

```
authorize(session, operation, nodeId) ->
  | { kind: "allow", via: "permission" | "scope" | "grant" | "created" }
  | { kind: "ask", prompt }          // a channel exists: dialog, then grant or request
  | { kind: "request", request_id }  // no channel, or unanswered
  | { kind: "refuse", reason }       // permissions, hard floor for agents, owner gone
```

Called from every mutation and every scoped read: MCP tools, the
graph-plane REST routes, the sidecar's device-local tools (which today
keep a write set of their own that central's `expand_scope` never
updates), and the runner's file-tier decision for Edit/Write inside
mirrors, mapped to the node the mirror belongs to. Bash and the disk stay
outside this gate and are named as such in `docs/architecture/`; the
sandbox is a separate spec.

Targets, per operation:

| Operation | Authorized on |
|---|---|
| read, `log_event`, `store_file`, `update_node`, `delete` | the node |
| `create_node` | the place: the organization or parent the new node is created under |
| `link`, `move_file`, `move_node` | both nodes, each on its own |
| actors, remotes, routing (global registries) | permission tier only, as today; never a grant of an agent |

Exemptions that stay, and how they are told apart from an agent: the
desktop UI's own REST calls (`X-Portuni-Webview-Proxy`, the person acting
directly) and the sync agent's file-plane runs (a *person's* device token,
no session header, deterministic reconciliation of the device's own
disk). An actor credential on either path is refused: an agent reaches
files only through a session and this gate.

The gate runs on the central server for a team workspace and in the
sidecar for a personal workspace, over the same session store interface;
the device never decides from a copy. Every decision writes one audit row
with the session, the principal, the operation, the node and `via`.

## UI

Part of the gate: the question card ships with the gate in phase 1, the
rest with the phase that needs it.

- **Question card in the chat** (AI Elements Confirmation): who asks
  (Portuni, or the runner for its own questions), the node with its type
  and organization, the operation in words ("zapsat událost", "uložit
  soubor do wip/"), what Ano grants and for how long ("do tvé další
  zprávy"), what Ne does ("agent pokračuje bez zápisu"). Ano/Ne send
  booleans. A question the run abandoned shows as closed, not answered.
- **Session scope panel** in the thread header (phase 2): anchor, this
  turn's grants, expansions with their origin (edge, dialog, request),
  and a link to the audit. Replaces `portuni_session_log` as the
  person's view.
- **Přehled › Čeká na mě** lists open consent requests: from threads
  whose dialog went unanswered and from agents' runs (`channel = none`).
  Answering there is the same `answer` as in the chat.
- **Actor page** (Aktéři › automation): credential (issue, revoke, last
  used), the grant set editor (places, node types, operations), proposed
  grants with accept/dismiss, and the last runs with their audit.
- **Node page › Přístup** shows agents that hold a grant covering this
  node, next to people and groups.

## Data

- `sessions`: `principal_kind`, `principal_id`, `channel`;
  `session_scope.operation`, `session_scope.turn_seq`.
- `device_tokens.actor_id` (replaces the meaning of `headless`).
- `agent_grants`, `agent_grant_proposals`, `consent_requests`.
- Both dialects (`MIGRATIONS` and `PG_BASELINE_DDL`), `docs/lessons-learned.md`
  §7 first.

## Phases

1. **The session decides.** `principal_*`, `channel`, immutable anchor,
   bind by principal, synchronous persistence; sidecar reads the session
   instead of deriving from the credential; hard-floor seed and order;
   `authorize()` behind MCP, REST and device-local tools with
   `(node, operation)` grants; runner scope question removed; reason
   path and `confirmed_hard_floor` removed; outcomes split; question
   card v2. Self-contained interim for AIQ: it still connects with a
   person's device token, so its sessions are `cli`; a dialog the
   headless CLI declines is `unanswered`, recorded as a request row that
   Přehled lists (not yet answerable), and the write does not happen.
   Nothing is recorded as the owner's refusal any more.
2. **Turn-bound consent and requests.** `turn_seq` grants and the
   card's wording; `consent_requests` answerable from the chat and
   Přehled without a live run; the scope panel in the thread header.
3. **Agents with grants.** Actor credential, `agent_grants`, `agentMay`,
   actor page, node page access list; AIQ moves to the actor credential
   (`channel = none`) with a first grant set (Workflow organization;
   projects; `log_event`, `store_file`, `create_node`); proposed grants
   from repeated approvals.
4. **Connectors** consume the same grant set (their own spec).

Each phase works in a team workspace and in a personal workspace before
it closes; the personal workspace runs the same gate over the local
session store with a single person principal.

## Tests

`authorize()` as a pure table over (principal, channel, scope, grant)
for every operation; `agentMay` over grant rows and owner rights;
seed hard floor; immutable anchor; outcome split (declined vs
unanswered vs no_channel) through the chat runtime and the fake
adapter; request lifecycle (create, answer, apply once, expire);
sidecar device-local tools against the fake `CentralClient`; REST
graph-plane routes; both drivers (`npm test`, `npm run test:pglite`).

## Docs

`docs/architecture/mcp-scope-and-integrations.md` and
`sessions-and-runner.md` (the gate, session fields, outcomes),
`apps/server/mcp/resources/scope-rules.md` (the agent contract: no reason
path, requests), `sites/docs` (`concepts/scope-enforcement.md`,
`reference/scope.md`, `reference/actors.md`, `guides/working-in-the-app.md`).

## Out of scope

- Which credential a shared connector carries and how a person lends
  one to an agent (connector spec).
- Uploading a file from a session without a device (`portuni_store`
  with content; separate issue).
- A sandbox for Bash and the disk; named as outside the gate.
- Learning grants from anything but explicit approvals.
