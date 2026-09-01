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

export interface ExpansionRecord {
  at: string;
  node_ids: string[];
  reason: string;
  triggered_by: ExpansionTrigger;
}

export interface ScopeRequestDecision {
  // "allow" – serve the request, optionally with side effects (audit, expand).
  // "elicit" – respond with a structured refusal that the client/agent can turn
  //   into a user prompt (Claude Code does this via MCP elicitation; Codex via
  //   chat). The reason names the node and tells the agent to call
  //   portuni_expand_scope after the user agrees.
  kind: "allow" | "elicit";
  message?: string;
}

// In-memory state per MCP session. This object is captured by tool handler
// closures via registerXxxTools(server, scope) at session creation time.
export class SessionScope {
  private readonly nodes = new Set<string>();
  private readonly history: ExpansionRecord[] = [];
  // Nodes granted their REAL mirror on disk at terminal spawn (home + depth-1,
  // the stable seed set). The seatbelt read-allows exactly this set, so read
  // tools return their real path and the reconciler must NOT stage them.
  // Non-seed in-scope nodes (ad-hoc expansion) still stage into .portuni-scope.
  private readonly seed = new Set<string>();
  private readonly addListeners: ((nodeId: string) => void)[] = [];

  homeNodeId: string | null = null;
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
  // Marks before add() so onAdd listeners (the reconciler) already see
  // isSeed()===true and skip staging it.
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
  // them so read tools return the real mirror and the reconciler skips them.
  for (const id of neighborIds) {
    scope.addSeed(id);
  }
  return [homeNodeId, ...neighborIds];
}

// Decide whether a single-target read should be served. Hard floors always
// elicit; anything else out of scope elicits too (the strict/balanced/
// permissive switch is gone -- strict is the model now; session-type-aware
// nuance, e.g. headless deferred review, lands in a later phase). Caller is
// responsible for auditing on `allow` and surfacing the elicitation prompt
// on `elicit`.
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
): ScopeRequestDecision {
  if (scope.has(nodeId)) {
    return { kind: "allow" };
  }

  // Hard floors: visibility=private created by someone else, or
  // meta.scope_sensitive=true. These always elicit.
  if (
    nodeMeta.scopeSensitive ||
    (nodeMeta.visibility === "private" &&
      nodeMeta.creatorUserId !== null &&
      nodeMeta.creatorUserId !== sessionUserId)
  ) {
    return {
      kind: "elicit",
      message:
        `Target node ${nodeId} is scope-sensitive. Ask the user to confirm, ` +
        `then call portuni_expand_scope with reason 'user-confirmed-in-chat'.`,
    };
  }

  return {
    kind: "elicit",
    message:
      `Node ${nodeId} is outside the session scope. Ask the user to ` +
      `confirm, then call portuni_expand_scope with reason 'user-confirmed-in-chat'.`,
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

// Result of guardNodeRead. On allow, callers proceed with the read.
// On elicit, callers return the structured error to MCP.
// On notFound, callers report the missing node.
export type ReadGuardOutcome =
  | { kind: "allow" }
  | { kind: "elicit"; error: ReturnType<typeof scopeExpansionError> }
  | { kind: "not_found" };

// One-shot scope check: load meta, run decideRead. decideRead only ever
// returns "allow" for a node already in the scope set (out-of-scope reads
// always elicit now that the strict/balanced/permissive switch is gone), so
// there is nothing left to auto-add or audit here on the allow path -- that
// pass-through-expansion behavior was specific to balanced/permissive.
//
// identity is optional for backwards compatibility with callers that only
// need the classic scope gate. When provided, a group-visibility check
// runs FIRST (before scope): non-members see not_found, never an elicit.
export async function guardNodeRead(
  db: Client,
  scope: SessionScope,
  nodeId: string,
  sessionUserId: string,
  identity?: GroupIdentityView,
): Promise<ReadGuardOutcome> {
  const meta = await loadNodeScopeMeta(db, nodeId);
  if (!meta.exists) return { kind: "not_found" };

  // Group-visibility gate: runs before scope so non-members cannot probe
  // existence via the scope-expansion elicit.
  if (identity !== undefined) {
    const visible = await nodeVisibleTo(db, identity, nodeId);
    if (!visible) return { kind: "not_found" };
  }

  const decision = decideRead(
    scope,
    nodeId,
    {
      visibility: meta.visibility,
      creatorUserId: meta.creatorUserId,
      scopeSensitive: meta.scopeSensitive,
    },
    sessionUserId,
  );
  if (decision.kind === "elicit") {
    return {
      kind: "elicit",
      error: scopeExpansionError(nodeId, decision.message ?? "expand scope first"),
    };
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
