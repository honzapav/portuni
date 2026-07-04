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
import { parseJsonBody, respondError, respondJson, type RequestIdentity } from "../http/middleware.js";
import { nodeVisibleTo, resolveAccessChain } from "../auth/node-access.js";

const AccessEntryBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), principal: z.string().min(1), display_email: z.string().email() }),
  z.object({ kind: z.literal("user"), principal: z.string().min(1) }),
]);
const PutAccessBody = z.object({ entries: z.array(AccessEntryBody).max(100) });

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
}

// Shared by GET and the post-PUT response: resolves the effective ACL for
// nodeId (walking up the belongs_to chain when the node has no ACL of its
// own) and joins display data (user name/email/avatar) for the UI.
async function buildAccessView(db: Client, nodeId: string): Promise<AccessView> {
  const { sourceNodeId, entries } = await resolveAccessChain(db, nodeId);
  if (entries === null) {
    return {
      restricted: false,
      inherited: false,
      source_node_id: null,
      source_node_name: null,
      entries: [],
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

    const userIds = body.entries
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

    // Restricting (non-empty entries) always sets 'group'. Clearing
    // (empty entries) only reverts to 'team' if the node was 'group' --
    // never clobbers 'private', which is an independent, manually-set state.
    const wasGroup = String(nodeRow.rows[0].visibility) === "group";
    const newVisibility =
      body.entries.length > 0 ? "group" : wasGroup ? "team" : String(nodeRow.rows[0].visibility);

    const statements: Parameters<typeof db.batch>[0] = [
      { sql: "DELETE FROM node_access WHERE node_id = ?", args: [nodeId] },
      ...body.entries.map((entry) => ({
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
        sql: "UPDATE nodes SET visibility = ?, updated_at = datetime('now') WHERE id = ?",
        args: [newVisibility, nodeId],
      },
    ];
    await db.batch(statements, "write");

    await logAudit(identity.userId, "node.access.set", "node", nodeId, { entries: body.entries });

    const view = await buildAccessView(db, nodeId);
    respondJson(res, 200, view);
  } catch (err) {
    respondError(res, `${req.method} /nodes/${nodeId}/access`, err);
  }
}
