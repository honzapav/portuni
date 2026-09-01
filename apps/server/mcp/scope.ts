// Read-scope state for a single MCP connection.
//
// Each MCP session gets its own SessionScope. The scope set is a set of
// node IDs the agent is allowed to fetch. It starts narrow (home node +
// depth-1 neighbors) and grows only through audited expansions.
//
// See docs/superpowers/specs/2026-04-24-scope-model.md.

import type { Client } from "@libsql/client";
import { nodeVisibleTo, filterVisibleNodeIds, type GroupIdentityView } from "../auth/node-access.js";
import { nodeNeighbourIds } from "../domain/queries/neighbours.js";
import type { RequestIdentity } from "../auth/request-identity.js";
import { writeAudit } from "../infra/audit.js";
import type { Elicitor } from "./elicit.js";

// Session type: derived by the server from the authentication path, never
// self-declared by the client/agent. See
// docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Concepts" -- session types table).
//
//   interactive_task  -- connection carries ?home_node_id (desktop-spawned
//                         terminal, mirror .mcp.json): anchor = task node.
//   interactive_chat  -- identity.via === "oauth_grant" (connector: claude.ai,
//                         Claude Desktop chat, Claude Code as connector):
//                         no anchor, read scope = everything permissions allow.
//   headless          -- device token minted with the headless flag
//                         (admin-granted credential): anchor required,
//                         connection without home_node_id is refused.
//   env               -- solo/loopback auth (identity.via === "env"). Out of
//                         scope for this redesign; keeps its current
//                         behavior. Still gets a session_type value so
//                         session_init/session_log/audit payloads have one
//                         field for every session, never a self-declared mode.
export type SessionType = "interactive_task" | "interactive_chat" | "headless" | "env";

// Pure derivation, no side effects. Order matters: oauth_grant and env are
// unambiguous from identity.via; headless requires the device-token flag;
// anything else (plain device_token, session_jwt) defaults to
// interactive_task, matching the historical fallback where a session without
// a recognized home node still works with session_init as manual seeding.
export function deriveSessionType(
  identity: Pick<RequestIdentity, "via" | "headless">,
  _homeNodeId: string | null,
): SessionType {
  if (identity.via === "env") return "env";
  if (identity.via === "oauth_grant") return "interactive_chat";
  if (identity.headless) return "headless";
  return "interactive_task";
}

export type ExpansionTrigger = "user" | "agent" | "traversal" | "init";

// Mirrors the `session_scope.added_via` column sketched for the persistent
// sessions table (phase 2): how a node entered the scope set. Kept here
// as the in-memory audit tag so the vocabulary is already stable when the
// table lands.
//   seed        - home node or depth-1 neighbor, granted at spawn.
//   edge        - reachable via a graph edge from the current scope set;
//                 auto-approved, never round-tripped through expand_scope.
//   disconnected- reached only via search/name, no edge path; requires a
//                 declared reason (interactive: elicitation; headless: the
//                 expand_scope reason argument, always present).
//   created     - the node was created by this session.
//   elicited    - a hard-floor or disconnected-jump read the user confirmed
//                 via a real MCP protocol elicitation dialog (see elicit.ts),
//                 not the honor-system portuni_expand_scope round trip.
export type AddedVia = "seed" | "edge" | "disconnected" | "created" | "elicited";

export interface ExpansionRecord {
  at: string;
  node_ids: string[];
  reason: string;
  triggered_by: ExpansionTrigger;
  addedVia?: AddedVia;
}

export interface ScopeRequestDecision {
  // "allow" – serve the request, optionally with side effects (audit, expand).
  // "elicit" – respond with a structured refusal that the client/agent can turn
  //   into a user prompt (Claude Code does this via MCP elicitation; Codex via
  //   chat). The reason names the node and tells the agent to call
  //   portuni_expand_scope after the user agrees.
  // "refused" – a hard, non-negotiable refusal: no round-trip through
  //   expand_scope can succeed (headless session hitting a hard floor).
  kind: "allow" | "elicit" | "refused";
  message?: string;
  // Set on "allow" when the node was not already in scope and is being
  // auto-added because it is edge-reachable from the current scope set.
  // Callers (guardNodeRead) perform the actual add + audit; decideRead
  // stays a pure function.
  addedVia?: "edge";
}

// In-memory state per MCP session. This object is captured by tool handler
// closures via registerXxxTools(server, scope) at session creation time.
export class SessionScope {
  private readonly nodes = new Set<string>();
  private readonly history: ExpansionRecord[] = [];
  // Nodes granted their REAL mirror on disk at terminal spawn (home + depth-1,
  // the stable seed set). The seatbelt read-allows exactly this set, so read
  // tools return their real path and the disk projector must NOT hardlink
  // them. Non-seed in-scope nodes (ad-hoc expansion) get hardlinked into the
  // session's projection directory instead (mcp/disk-projection.ts).
  private readonly seed = new Set<string>();
  // Write set: a placeholder for the write gate that lands in a later
  // phase (domain-layer enforcement, session_scope.writable). Populated
  // today only for nodes created by this session -- a task's own outputs
  // are part of its context by definition (spec: "Read scope").
  private readonly writeSet = new Set<string>();
  private readonly addListeners: ((nodeId: string) => void)[] = [];
  private readonly writableListeners: ((nodeId: string) => void)[] = [];

  homeNodeId: string | null = null;
  // Set once the session_scope cache row exists (bindSessionPersistence,
  // session-persistence.ts) -- null until then, and for SessionScope
  // instances built by test harnesses that never persist at all.
  sessionId: string | null = null;
  readonly sessionType: SessionType;
  readonly createdAt: string;

  constructor(sessionType: SessionType) {
    this.sessionType = sessionType;
    this.createdAt = new Date().toISOString();
  }

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  list(): string[] {
    return [...this.nodes];
  }

  size(): number {
    return this.nodes.size;
  }

  expansions(): ExpansionRecord[] {
    return [...this.history];
  }

  // Subscribe to node additions. Listeners fire synchronously, once, only
  // when a node is newly inserted (not on a duplicate add). A throwing
  // listener is swallowed so disk-projection failures never corrupt the
  // authoritative in-memory scope. This is the single hook every disk
  // projection of the scope set hangs off.
  onAdd(listener: (nodeId: string) => void): void {
    this.addListeners.push(listener);
  }

  // Add a node to the scope set. Returns true if it was actually added.
  add(nodeId: string): boolean {
    if (this.nodes.has(nodeId)) return false;
    this.nodes.add(nodeId);
    for (const listener of this.addListeners) {
      try {
        listener(nodeId);
      } catch {
        /* listeners are best-effort disk projections; never fail a graph add */
      }
    }
    return true;
  }

  // Add a node AND mark it part of the spawn seed set (real-path granted).
  // Marks before add() so onAdd listeners (the disk projector) already see
  // isSeed()===true and skip projecting it.
  addSeed(nodeId: string): boolean {
    this.seed.add(nodeId);
    return this.add(nodeId);
  }

  // True for nodes granted their real mirror at spawn (home + depth-1).
  isSeed(nodeId: string): boolean {
    return this.seed.has(nodeId);
  }

  recordExpansion(record: ExpansionRecord): void {
    this.history.push(record);
  }

  // Subscribe to write grants. Mirrors onAdd (best-effort, swallows
  // listener errors): the session-scope persistence cache hangs off this
  // to keep session_scope.writable in sync.
  onWritable(listener: (nodeId: string) => void): void {
    this.writableListeners.push(listener);
  }

  // Add a node to BOTH the read and write set -- a node cannot be writable
  // without being readable. Returns true if it was newly writable.
  addWritable(nodeId: string): boolean {
    this.add(nodeId);
    if (this.writeSet.has(nodeId)) return false;
    this.writeSet.add(nodeId);
    for (const listener of this.writableListeners) {
      try {
        listener(nodeId);
      } catch {
        /* listeners are best-effort persistence; never fail a graph write */
      }
    }
    return true;
  }

  canWrite(nodeId: string): boolean {
    return this.writeSet.has(nodeId);
  }

  writableNodes(): string[] {
    return [...this.writeSet];
  }
}

// Seed the scope set with the home node + its depth-1 neighbors. Auto-seed
// runs on session initialize when the MCP URL carries `?home_node_id=...`
// (set by `portuni_mirror` in each mirror's `.mcp.json` / `.codex/config.toml`).
// `portuni_session_init` invokes this as a manual fallback for clients that
// connect without the query param. Returns the seed node IDs so callers can
// audit / display them.
//
// When identity is provided, neighbor IDs are filtered through
// filterVisibleNodeIds so restricted neighbors are never added to scope.
// The home node itself is always added (it is the user's own mirror anchor).
export async function seedScopeFromHome(
  db: Client,
  scope: SessionScope,
  homeNodeId: string,
  identity?: GroupIdentityView,
): Promise<string[]> {
  scope.homeNodeId = homeNodeId;
  scope.addSeed(homeNodeId);

  const rawNeighborIds = await nodeNeighbourIds(db, homeNodeId);

  let neighborIds: string[];
  if (identity !== undefined) {
    const visibleSet = await filterVisibleNodeIds(db, identity, rawNeighborIds);
    neighborIds = rawNeighborIds.filter((id) => visibleSet.has(id));
  } else {
    neighborIds = rawNeighborIds;
  }

  // Seed set = home + depth-1: the seatbelt grants these real paths, so mark
  // them so read tools return the real mirror and the disk projector skips
  // them.
  for (const id of neighborIds) {
    scope.addSeed(id);
  }
  return [homeNodeId, ...neighborIds];
}

// Decide whether a single-target read should be served. The server computes
// the classification itself -- the agent never declares it:
//
//   - already in scope                       -> allow
//   - hard floor (scope_sensitive / private-  -> headless: refused outright
//     other)                                     interactive/env: elicit
//   - edge-reachable from the current scope   -> allow, addedVia: "edge"
//     set (reachable is precomputed by the
//     caller, see isEdgeReachable)
//   - otherwise (disconnected jump)           -> elicit (interactive types
//                                                  confirm via elicitation;
//                                                  headless proceeds only via
//                                                  portuni_expand_scope's
//                                                  mandatory `reason` field)
//
// See docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md
// ("Read scope"). Caller is responsible for auditing on `allow` (when
// addedVia is set) and surfacing the elicitation prompt on `elicit`.
//
// `nodeMeta` is a small bag with the bits of the target node that gate the
// hard floors (visibility + meta.scope_sensitive). Caller looks them up.
export interface NodeScopeMeta {
  visibility: string;
  creatorUserId: string | null;
  scopeSensitive: boolean;
}

export function decideRead(
  scope: SessionScope,
  nodeId: string,
  nodeMeta: NodeScopeMeta,
  sessionUserId: string,
  reachable: boolean,
): ScopeRequestDecision {
  if (scope.has(nodeId)) {
    return { kind: "allow" };
  }

  // Hard floors: visibility=private created by someone else, or
  // meta.scope_sensitive=true. Headless has no elicitation channel and no
  // deferred-review path for hard floors -- refused outright, every time.
  if (
    nodeMeta.scopeSensitive ||
    (nodeMeta.visibility === "private" &&
      nodeMeta.creatorUserId !== null &&
      nodeMeta.creatorUserId !== sessionUserId)
  ) {
    if (scope.sessionType === "headless") {
      return {
        kind: "refused",
        message: `Node ${nodeId} is scope-sensitive and cannot be reached by a headless session.`,
      };
    }
    return {
      kind: "elicit",
      message:
        `Target node ${nodeId} is scope-sensitive. Ask the user to confirm, ` +
        `then call portuni_expand_scope with reason 'user-confirmed-in-chat'.`,
    };
  }

  // interactive_chat has no anchor and no scope-expansion dance: past the
  // hard-floor gate above, read scope IS whatever the permission layer
  // (visibility/group ACLs, enforced by the caller before this decision)
  // allows -- visible means readable, full stop. See the session-type table
  // in docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md.
  if (scope.sessionType === "interactive_chat") {
    return { kind: "allow" };
  }

  // Edge-reachable: a node adjacent to something already in scope is a
  // natural traversal, not a jump -- auto-approve without a round trip.
  if (reachable) {
    return { kind: "allow", addedVia: "edge" };
  }

  // Disconnected jump: found only via search/name, no edge path from the
  // current scope set. Interactive types confirm via elicitation; headless
  // proceeds only through portuni_expand_scope, whose `reason` field is
  // mandatory -- the server stamps the audit `disconnected` regardless of
  // what the agent claims (see expand_scope's classification).
  if (scope.sessionType === "headless") {
    return {
      kind: "elicit",
      message:
        `Node ${nodeId} is outside the session scope and not reachable via a graph edge ` +
        `from anything already in scope (a disconnected jump). Headless sessions have no ` +
        `user to ask -- call portuni_expand_scope with a reason describing why this node ` +
        `is needed; the jump is recorded and surfaced in review.`,
    };
  }
  return {
    kind: "elicit",
    message:
      `Node ${nodeId} is outside the session scope and not reachable via a graph edge ` +
      `from anything already in scope (a disconnected jump). Ask the user to confirm, ` +
      `then call portuni_expand_scope with reason 'user-confirmed-in-chat'.`,
  };
}

// Build the structured-error JSON returned to MCP clients on out-of-scope
// reads (Codex CLI doesn't yet support MCP elicitation, so we return a
// machine-readable error and let the agent surface it in chat).
export function scopeExpansionError(
  nodeId: string,
  hint: string,
): {
  error: string;
  node_id: string;
  hint: string;
} {
  return {
    error: "scope_expansion_required",
    node_id: nodeId,
    hint,
  };
}

// Build the structured-error JSON for a hard, non-negotiable refusal (no
// expand_scope round trip can succeed -- headless hitting a hard floor).
export function scopeRefusedError(
  nodeId: string,
  hint: string,
): {
  error: string;
  node_id: string;
  hint: string;
} {
  return {
    error: "scope_refused",
    node_id: nodeId,
    hint,
  };
}

// --- Centralized helpers used by every scope-aware MCP tool ---

// Cheap shape for the columns scope decisions need. Loading nothing else
// keeps these checks fast on hot paths.
export interface NodeScopeRow {
  exists: boolean;
  visibility: string;
  creatorUserId: string | null;
  scopeSensitive: boolean;
}

// Look up the bits of a node that drive scope decisions:
// - visibility for the private hard floor,
// - created_by (the node's creator) for the same floor -- kept consistent
//   with the human graph, which enforces visibility='private' as
//   creator + admins only (apps/server/auth/node-access.ts). Using the
//   nullable business owner_id here would leave ownerless private nodes
//   unenforced, diverging from the graph.
// - meta.scope_sensitive for the explicit-flag hard floor.
//
// Returns exists=false when the node is missing so callers can produce
// a friendly "node not found" rather than crashing.
export async function loadNodeScopeMeta(
  db: Client,
  nodeId: string,
): Promise<NodeScopeRow> {
  const r = await db.execute({
    sql: "SELECT visibility, created_by, meta FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (r.rows.length === 0) {
    return { exists: false, visibility: "team", creatorUserId: null, scopeSensitive: false };
  }
  const row = r.rows[0];
  const creatorUserId = (row.created_by as string | null) ?? null;
  let scopeSensitive = false;
  const rawMeta = row.meta as string | null;
  if (rawMeta) {
    try {
      const parsed = JSON.parse(rawMeta) as { scope_sensitive?: unknown };
      scopeSensitive = parsed?.scope_sensitive === true;
    } catch {
      /* malformed meta — treat as not sensitive */
    }
  }
  return {
    exists: true,
    visibility: row.visibility as string,
    creatorUserId,
    scopeSensitive,
  };
}

// Is `nodeId` directly edge-adjacent to some node already in the scope set?
// Depth-1 only, reusing the same neighbour query seedScopeFromHome uses --
// the contract is "reachable from the current scope set via a graph edge",
// not a full multi-hop graph walk. A node two hops away becomes reachable
// naturally once the one-hop node between them enters scope.
export async function isEdgeReachable(
  db: Client,
  scope: SessionScope,
  nodeId: string,
): Promise<boolean> {
  if (scope.size() === 0) return false;
  const neighbourIds = await nodeNeighbourIds(db, nodeId);
  return neighbourIds.some((id) => scope.has(id));
}

// Result of guardNodeRead. On allow, callers proceed with the read.
// On elicit, callers return the structured error to MCP (a round trip
// through portuni_expand_scope can still succeed).
// On refused, callers return the structured error to MCP, but no round trip
// can succeed (headless hitting a hard floor) -- do not suggest expand_scope.
// On notFound, callers report the missing node.
export type ReadGuardOutcome =
  | { kind: "allow" }
  | { kind: "elicit"; error: ReturnType<typeof scopeExpansionError> }
  | { kind: "refused"; error: ReturnType<typeof scopeRefusedError> }
  | { kind: "not_found" };

// One-shot scope check: load meta, compute edge-reachability, run
// decideRead. On an edge-reachable allow, this is where the actual
// side effects happen (decideRead stays pure): the node is added to
// scope, the expansion is recorded, and the auto-expansion is audited.
//
// identity is optional for backwards compatibility with callers that only
// need the classic scope gate. When provided, a group-visibility check
// runs FIRST (before scope): non-members see not_found, never an elicit.
//
// elicitor is optional too (absent in most test harnesses -- see
// SessionCtx.elicit): when provided and the session is not headless (which
// has no elicitation channel by design, regardless of what the connected
// client declares), an "elicit" classification tries a real protocol
// dialog before falling back to the structured-refusal convention.
export async function guardNodeRead(
  db: Client,
  scope: SessionScope,
  nodeId: string,
  sessionUserId: string,
  identity?: GroupIdentityView,
  elicitor?: Elicitor,
): Promise<ReadGuardOutcome> {
  const meta = await loadNodeScopeMeta(db, nodeId);
  if (!meta.exists) return { kind: "not_found" };

  // Group-visibility gate: runs before scope so non-members cannot probe
  // existence via the scope-expansion elicit.
  if (identity !== undefined) {
    const visible = await nodeVisibleTo(db, identity, nodeId);
    if (!visible) return { kind: "not_found" };
  }

  const alreadyInScope = scope.has(nodeId);
  // interactive_chat never consults reachability (see decideRead) -- skip
  // the extra neighbour query.
  const reachable =
    scope.sessionType === "interactive_chat"
      ? false
      : alreadyInScope || (await isEdgeReachable(db, scope, nodeId));

  const decision = decideRead(
    scope,
    nodeId,
    {
      visibility: meta.visibility,
      creatorUserId: meta.creatorUserId,
      scopeSensitive: meta.scopeSensitive,
    },
    sessionUserId,
    reachable,
  );

  if (decision.kind === "refused") {
    return {
      kind: "refused",
      error: scopeRefusedError(nodeId, decision.message ?? "refused"),
    };
  }
  if (decision.kind === "elicit") {
    if (scope.sessionType !== "headless" && elicitor !== undefined) {
      const outcome = await elicitor.confirm(
        decision.message ?? `Allow this session to read node ${nodeId}?`,
      );
      if (outcome === "accept") {
        scope.add(nodeId);
        scope.recordExpansion({
          at: new Date().toISOString(),
          node_ids: [nodeId],
          reason: "elicited (protocol dialog confirmed by user)",
          triggered_by: "user",
          addedVia: "elicited",
        });
        await writeAudit(db, sessionUserId, "scope_auto_expand", "scope", nodeId, {
          added_via: "elicited",
          session_type: scope.sessionType,
        });
        return { kind: "allow" };
      }
    }
    return {
      kind: "elicit",
      error: scopeExpansionError(nodeId, decision.message ?? "expand scope first"),
    };
  }

  if (decision.addedVia === "edge" && !alreadyInScope) {
    scope.add(nodeId);
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: [nodeId],
      reason: "edge-reachable from the current scope set",
      triggered_by: "traversal",
      addedVia: "edge",
    });
    await writeAudit(db, sessionUserId, "scope_auto_expand", "scope", nodeId, {
      added_via: "edge",
      session_type: scope.sessionType,
    });
  }

  return { kind: "allow" };
}

// Run a hard-floor check independently of any scope membership. Used by
// portuni_expand_scope so an explicit user-named expansion still cannot
// silently widen scope to a private-created-by-other or scope_sensitive node
// without explicit acknowledgement.
export function violatesHardFloor(
  meta: NodeScopeRow,
  sessionUserId: string,
): boolean {
  if (meta.scopeSensitive) return true;
  if (
    meta.visibility === "private" &&
    meta.creatorUserId !== null &&
    meta.creatorUserId !== sessionUserId
  ) {
    return true;
  }
  return false;
}
