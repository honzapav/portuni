// REST endpoints for /nodes/:id/access -- read and set the node_access ACL
// (spec: docs/superpowers/specs/2026-07-04-node-sharing-design.md §2).
// GET resolves the effective (possibly inherited) ACL for display; PUT
// replaces the node's own ACL and derives `nodes.visibility` from whether
// the new entry set is empty.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "@libsql/client";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import { logAudit } from "../infra/audit.js";
import {
  getIdentityContext,
  parseJsonBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import { nodeVisibleTo, resolveAccessChain } from "../auth/node-access.js";

const AccessEntryBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), principal: z.string().min(1), display_email: z.string().email() }),
  z.object({ kind: z.literal("user"), principal: z.string().min(1) }),
]);
const PutAccessBody = z.object({
  entries: z.array(AccessEntryBody).max(100),
  // Only meaningful when entries is non-empty; defaults to "private" there.
  // Ignored when entries is empty -- clearing the ACL always resets
  // access_mode to "private" regardless of what's passed here.
  mode: z.enum(["private", "request"]).optional(),
  // Authoritative target mode for the unified sharing control. When present
  // this endpoint owns the whole access state (visibility + entries +
  // access_mode) so the two can never drift:
  //   team|private -> entries are forced empty, visibility set directly.
  //   group        -> requires >= 1 entry (else 400).
  // When absent, visibility is derived from entries (legacy behaviour).
  visibility: z.enum(["team", "private", "group"]).optional(),
});

interface AccessViewEntry {
  kind: "group" | "user";
  principal: string;
  display_email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface AccessView {
  restricted: boolean;
  inherited: boolean;
  source_node_id: string | null;
  source_node_name: string | null;
  entries: AccessViewEntry[];
  mode: "private" | "request" | null;
  // The node's OWN visibility mode (team | private | group), so the unified
  // sharing control can render the selector. Distinct from `restricted`,
  // which reflects the *effective* (possibly inherited) ACL and cannot tell
  // team from private.
  visibility: string;
}

// Shared by GET and the post-PUT response: resolves the effective ACL for
// nodeId (walking up the belongs_to chain when the node has no ACL of its
// own) and joins display data (user name/email/avatar) for the UI.
async function buildAccessView(db: Client, nodeId: string): Promise<AccessView> {
  const [{ sourceNodeId, entries, mode, implicitPrivate }, ownVisRow] = await Promise.all([
    resolveAccessChain(db, nodeId),
    db.execute({ sql: "SELECT visibility FROM nodes WHERE id = ?", args: [nodeId] }),
  ]);
  const ownVisibility = String(ownVisRow.rows[0]?.visibility ?? "team");
  // A private node's entries are a synthetic creator-only grant for
  // enforcement; for display it has no shared grantees, so present it like
  // an unrestricted node (the selector renders "Soukromé" from `visibility`).
  if (entries === null || implicitPrivate) {
    return {
      restricted: false,
      inherited: false,
      source_node_id: null,
      source_node_name: null,
      entries: [],
      mode: null,
      visibility: ownVisibility,
    };
  }

  const sourceId = sourceNodeId as string;
  const [displayRows, sourceNodeRow] = await Promise.all([
    db.execute({
      sql: `SELECT na.kind, na.principal, na.display_email, u.name AS user_name, u.email AS user_email, u.avatar_url
            FROM node_access na LEFT JOIN users u ON na.kind = 'user' AND u.id = na.principal
            WHERE na.node_id = ?`,
      args: [sourceId],
    }),
    db.execute({ sql: "SELECT name FROM nodes WHERE id = ?", args: [sourceId] }),
  ]);

  const entriesOut: AccessViewEntry[] = displayRows.rows.map((row) => ({
    kind: row.kind as "group" | "user",
    principal: row.principal as string,
    display_email: (row.kind === "user" ? row.user_email : row.display_email) as string | null,
    display_name: (row.user_name as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
  }));

  return {
    restricted: true,
    inherited: sourceId !== nodeId,
    source_node_id: sourceId,
    source_node_name: (sourceNodeRow.rows[0]?.name as string | undefined) ?? null,
    entries: entriesOut,
    mode,
    visibility: ownVisibility,
  };
}

export async function handleGetNodeAccess(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    // The separate existence SELECT is NOT redundant with nodeVisibleTo:
    // resolveAccessChain returns entries=null for a nonexistent node (empty
    // chain), and canSeeNode(identity, null) is TRUE by contract (null means
    // "unrestricted", not "hidden") -- so nodeVisibleTo alone would answer
    // true for an id that doesn't exist at all. Both checks are required to
    // 404 correctly.
    const nodeRow = await db.execute({ sql: "SELECT id FROM nodes WHERE id = ?", args: [nodeId] });
    if (nodeRow.rows.length === 0 || !(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const view = await buildAccessView(db, nodeId);
    respondJson(res, 200, view);
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/access`, err);
  }
}

export async function handlePutNodeAccess(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    // See handleGetNodeAccess above: the existence SELECT is load-bearing,
    // not redundant with nodeVisibleTo (which answers true for a missing id).
    const nodeRow = await db.execute({
      sql: "SELECT id, visibility FROM nodes WHERE id = ?",
      args: [nodeId],
    });
    if (nodeRow.rows.length === 0 || !(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }

    const body = await parseJsonBody(req, res, PutAccessBody);
    if (!body) return;

    // Resolve the authoritative access state. When body.visibility is
    // present this endpoint owns visibility + entries + access_mode as one
    // atomic unit (the unified sharing control); team/private force the
    // entries empty, group requires at least one. When absent, fall back to
    // the legacy derive-from-entries behaviour.
    const wasGroup = String(nodeRow.rows[0].visibility) === "group";
    let effectiveEntries = body.entries;
    let newVisibility: string;
    let newAccessMode: "private" | "request";
    if (body.visibility === "group") {
      if (body.entries.length === 0) {
        respondJson(res, 400, {
          error: "group visibility requires at least one access entry",
        });
        return;
      }
      newVisibility = "group";
      newAccessMode = body.mode ?? "private";
    } else if (body.visibility === "team" || body.visibility === "private") {
      effectiveEntries = [];
      newVisibility = body.visibility;
      newAccessMode = "private";
    } else {
      // Legacy: non-empty entries always set 'group'; clearing reverts to
      // 'team' only if the node was 'group' -- never clobbers 'private'.
      newVisibility =
        body.entries.length > 0
          ? "group"
          : wasGroup
            ? "team"
            : String(nodeRow.rows[0].visibility);
      newAccessMode = body.entries.length > 0 ? (body.mode ?? "private") : "private";
    }

    // Reject duplicate (kind, principal) pairs up front -- letting them
    // through would hit the node_access PK (node_id, kind, principal)
    // inside the INSERT batch below and 500 instead of a clean 400.
    const seenEntries = new Set<string>();
    const duplicateEntries = new Set<string>();
    for (const entry of effectiveEntries) {
      const key = `${entry.kind}:${entry.principal}`;
      if (seenEntries.has(key)) duplicateEntries.add(key);
      seenEntries.add(key);
    }
    if (duplicateEntries.size > 0) {
      respondJson(res, 400, {
        error: `duplicate access entries: ${[...duplicateEntries].join(", ")}`,
      });
      return;
    }

    const userIds = effectiveEntries
      .filter((e): e is { kind: "user"; principal: string } => e.kind === "user")
      .map((e) => e.principal);
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(", ");
      const existing = await db.execute({
        sql: `SELECT id FROM users WHERE id IN (${placeholders})`,
        args: userIds,
      });
      const foundIds = new Set(existing.rows.map((r) => String(r.id)));
      const missing = userIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        respondJson(res, 400, { error: `unknown user id(s): ${missing.join(", ")}` });
        return;
      }
    }

    const statements: Parameters<typeof db.batch>[0] = [
      { sql: "DELETE FROM node_access WHERE node_id = ?", args: [nodeId] },
      ...effectiveEntries.map((entry) => ({
        sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          nodeId,
          entry.kind,
          entry.principal,
          entry.kind === "group" ? entry.display_email : null,
          identity.userId,
        ],
      })),
      {
        sql: "UPDATE nodes SET visibility = ?, access_mode = ?, updated_at = datetime('now') WHERE id = ?",
        args: [newVisibility, newAccessMode, nodeId],
      },
    ];
    await db.batch(statements, "write");

    await logAudit(identity.userId, "node.access.set", "node", nodeId, {
      entries: effectiveEntries,
      mode: newAccessMode,
      visibility: newVisibility,
    });

    const view = await buildAccessView(db, nodeId);
    respondJson(res, 200, view);
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/access`, err);
  }
}

// Domain groups picker for the node sharing UI (min-scope "manage" -- only
// editors of sharing get to see the org's group directory). Backed by
// GoogleAdapter.listDomainGroups; adapters without it (env mode) respond
// 501 so the UI can fall back to a plain "no groups available" state.
export async function handleListGroups(
  req: IncomingMessage,
  res: ServerResponse,
  _identity: RequestIdentity,
  url: URL,
): Promise<void> {
  try {
    const ctx = getIdentityContext();
    if (!ctx.adapter.listDomainGroups) {
      respondJson(res, 501, { error: "google_mode_only" });
      return;
    }
    const query = url.searchParams.get("query") ?? "";
    const groups = await ctx.adapter.listDomainGroups(query);
    respondJson(res, 200, { groups });
  } catch (err) {
    respondError(res, `${req.method} /auth/groups`, err);
  }
}
