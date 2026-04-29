// Read-scope state for a single MCP connection.
//
// Each MCP session gets its own SessionScope. The scope set is a set of
// node IDs the agent is allowed to fetch. It starts narrow (home node +
// depth-1 neighbors) and grows only through audited expansions.
//
// See docs/superpowers/specs/2026-04-24-scope-model.md.

import type { Client } from "@libsql/client";

export type ScopeMode = "strict" | "balanced" | "permissive";

export function parseScopeMode(value: string | undefined | null): ScopeMode {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "strict" || v === "balanced" || v === "permissive") return v;
  return "strict";
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
  // Nodes the agent has tried to reach this session, used by `balanced` mode
  // to allow the second agent-initiated read of a node it has already asked
  // about. (Only nodes that were *added* via expansion populate this.)
  private readonly seenAgentExpansion = new Set<string>();

  homeNodeId: string | null = null;
  readonly mode: ScopeMode;
  readonly createdAt: string;
  // Tracks whether *any* global query has already been seen this session.
  // balanced mode uses this to elicit only on the first global query and
  // pass silently afterwards. strict always elicits; permissive auto-allows.
  globalQuerySeen = false;

  constructor(mode: ScopeMode) {
    this.mode = mode;
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

  // Add a node to the scope set. Returns true if it was actually added.
  add(nodeId: string): boolean {
    if (this.nodes.has(nodeId)) return false;
    this.nodes.add(nodeId);
    return true;
  }

  recordExpansion(record: ExpansionRecord): void {
    this.history.push(record);
    if (record.triggered_by === "agent") {
      for (const id of record.node_ids) this.seenAgentExpansion.add(id);
    }
  }

  hasSeenAgentExpansion(nodeId: string): boolean {
    return this.seenAgentExpansion.has(nodeId);
  }
}

// SessionStart hook calls portuni_session_init(home_node_id). That seeds the
// scope set with the home node + its depth-1 neighbors. Returns the seed
// node IDs so callers can audit / display them.
export async function seedScopeFromHome(
  db: Client,
  scope: SessionScope,
  homeNodeId: string,
): Promise<string[]> {
  scope.homeNodeId = homeNodeId;
  scope.add(homeNodeId);

  const neighbors = await db.execute({
    sql: `SELECT DISTINCT
            CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END AS peer_id
          FROM edges e
          WHERE e.source_id = ? OR e.target_id = ?`,
    args: [homeNodeId, homeNodeId, homeNodeId],
  });
  const neighborIds: string[] = [];
  for (const row of neighbors.rows) {
    const id = row.peer_id as string;
    if (id) {
      neighborIds.push(id);
      scope.add(id);
    }
  }
  return [homeNodeId, ...neighborIds];
}

// Decide whether a single-target read should be served. Hard floors and the
// configured scope mode determine the outcome. Caller is responsible for
// auditing on `allow` and surfacing the elicitation prompt on `elicit`.
//
// `nodeMeta` is a small bag with the bits of the target node that gate the
// hard floors (visibility + meta.scope_sensitive). Caller looks them up.
export interface NodeScopeMeta {
  visibility: string;
  ownerUserId: string | null;
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

  // Hard floors: visibility=private owned by someone else, or
  // meta.scope_sensitive=true. These elicit regardless of mode.
  if (
    nodeMeta.scopeSensitive ||
    (nodeMeta.visibility === "private" &&
      nodeMeta.ownerUserId !== null &&
      nodeMeta.ownerUserId !== sessionUserId)
  ) {
    return {
      kind: "elicit",
      message:
        `Target node ${nodeId} is scope-sensitive. Ask the user to confirm, ` +
        `then call portuni_expand_scope with reason 'user-confirmed-in-chat'.`,
    };
  }

  switch (scope.mode) {
    case "strict":
      return {
        kind: "elicit",
        message:
          `Node ${nodeId} is outside the session scope. Ask the user to ` +
          `confirm, then call portuni_expand_scope with reason 'user-confirmed-in-chat'.`,
      };
    case "balanced":
      if (scope.hasSeenAgentExpansion(nodeId)) {
        return { kind: "allow" };
      }
      return {
        kind: "elicit",
        message:
          `First agent-initiated reach for node ${nodeId} this session. ` +
          `Ask the user to confirm, then call portuni_expand_scope.`,
      };
    case "permissive":
      return { kind: "allow" };
  }
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
  ownerUserId: string | null;
  scopeSensitive: boolean;
}

// Look up the bits of a node that drive scope decisions:
// - visibility for the private-owned-by-other hard floor,
// - owner_id -> actors.user_id resolution for the same hard floor,
// - meta.scope_sensitive for the explicit-flag hard floor.
//
// Returns exists=false when the node is missing so callers can produce
// a friendly "node not found" rather than crashing.
export async function loadNodeScopeMeta(
  db: Client,
  nodeId: string,
): Promise<NodeScopeRow> {
  const r = await db.execute({
    sql: "SELECT visibility, owner_id, meta FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (r.rows.length === 0) {
    return { exists: false, visibility: "team", ownerUserId: null, scopeSensitive: false };
  }
  const row = r.rows[0];
  let ownerUserId: string | null = null;
  const oid = row.owner_id as string | null;
  if (oid) {
    const a = await db.execute({
      sql: "SELECT user_id FROM actors WHERE id = ?",
      args: [oid],
    });
    ownerUserId = a.rows.length === 0 ? null : ((a.rows[0].user_id as string | null) ?? null);
  }
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
    ownerUserId,
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

// One-shot scope check: load meta, run decideRead, on allow auto-add to
// scope (idempotent) and audit the implicit pass-through expansion if the
// node was newly added.
//
// auditFn is the audit-writer to use. Pass logAudit so this module stays
// independent of the audit module's import cycle.
export async function guardNodeRead(
  db: Client,
  scope: SessionScope,
  nodeId: string,
  sessionUserId: string,
  auditFn: (action: string, targetId: string, detail: Record<string, unknown>) => Promise<void>,
): Promise<ReadGuardOutcome> {
  const meta = await loadNodeScopeMeta(db, nodeId);
  if (!meta.exists) return { kind: "not_found" };

  const decision = decideRead(
    scope,
    nodeId,
    {
      visibility: meta.visibility,
      ownerUserId: meta.ownerUserId,
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

  if (scope.add(nodeId)) {
    scope.recordExpansion({
      at: new Date().toISOString(),
      node_ids: [nodeId],
      reason: "auto-allow on read (mode=" + scope.mode + ")",
      triggered_by: "agent",
    });
    await auditFn("expand_scope", nodeId, {
      node_ids: [nodeId],
      reason: "auto-allow on read",
      triggered_by: "agent",
      mode: scope.mode,
    });
  }
  return { kind: "allow" };
}

// Mode-gated decision for global queries (list_nodes(scope=global),
// list_events without node_id filter, list_files without node_id filter,
// search). Strict always refuses; balanced refuses first time, allows after
// any prior global query in the session; permissive auto-allows + audits.
export interface GlobalQueryGuard {
  kind: "allow" | "elicit";
  message?: string;
}

export function decideGlobalQuery(scope: SessionScope): GlobalQueryGuard {
  switch (scope.mode) {
    case "strict":
      return {
        kind: "elicit",
        message:
          "Global listing is gated in strict scope mode. Ask the user to confirm the broad query, then call portuni_expand_scope with reason 'user-confirmed-in-chat' or pass scope='global' under PORTUNI_SCOPE_MODE=permissive.",
      };
    case "balanced":
      if (scope.globalQuerySeen) return { kind: "allow" };
      return {
        kind: "elicit",
        message:
          "First global listing this session. Ask the user to confirm; subsequent global queries will pass silently.",
      };
    case "permissive":
      return { kind: "allow" };
  }
}

// Run a hard-floor check independently of any scope membership. Used by
// portuni_expand_scope so an explicit user-named expansion still cannot
// silently widen scope to a private-other or scope_sensitive node without
// explicit acknowledgement.
export function violatesHardFloor(
  meta: NodeScopeRow,
  sessionUserId: string,
): boolean {
  if (meta.scopeSensitive) return true;
  if (
    meta.visibility === "private" &&
    meta.ownerUserId !== null &&
    meta.ownerUserId !== sessionUserId
  ) {
    return true;
  }
  return false;
}
