import { z } from "zod";
import { ulid } from "ulid";
import type { Client } from "@libsql/client";
import { getDb } from "../db.js";
import { logAudit } from "../audit.js";
import { EDGE_RELATIONS, SOLO_USER } from "../schema.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Direct audit writer used by pure functions that take a db param. Mirrors
// the helper in src/tools/actors.ts so tests can pass an in-memory client
// without hitting the singleton getDb().
async function writeAudit(
  db: Client,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [ulid(), userId, action, targetType, targetId, detail ? JSON.stringify(detail) : null],
  });
}

export type MoveNodeResult = {
  moved: boolean;
  edge_id: string;
  from_org_id: string;
  to_org_id: string;
};

// Disconnect an edge by id. Pre-checks the org-invariant before letting
// SQLite's trigger abort, so callers (REST and MCP) get a clean,
// actionable error instead of a 500 with an opaque "ABORT" message.
// Returns { deleted: edge_id } on success; throws Error on validation
// failure or "edge not found".
export async function disconnectEdgeById(
  db: Client,
  userId: string,
  edgeId: string,
): Promise<{ deleted: string }> {
  const existing = await db.execute({
    sql: `SELECT e.id, e.source_id, e.target_id, e.relation,
                 ns.type AS source_type, nt.type AS target_type
            FROM edges e
            JOIN nodes ns ON ns.id = e.source_id
            JOIN nodes nt ON nt.id = e.target_id
           WHERE e.id = ?`,
    args: [edgeId],
  });
  if (existing.rows.length === 0) {
    const err = new Error(`edge ${edgeId} not found`);
    (err as Error & { code?: string }).code = "EDGE_NOT_FOUND";
    throw err;
  }
  const row = existing.rows[0];
  const sourceId = row.source_id as string;
  const relation = row.relation as string;
  const sourceType = row.source_type as string;
  const targetType = row.target_type as string;

  if (relation === "belongs_to" && sourceType !== "organization" && targetType === "organization") {
    const orgCount = await db.execute({
      sql: `SELECT COUNT(*) as n FROM edges e
              JOIN nodes t ON t.id = e.target_id
             WHERE e.source_id = ?
               AND e.relation = 'belongs_to'
               AND t.type = 'organization'`,
      args: [sourceId],
    });
    const n = Number(orgCount.rows[0].n);
    if (n <= 1) {
      const err = new Error(
        `cannot remove the only belongs_to -> organization edge of node ${sourceId}; use moveNodeToOrganization to relocate it instead`,
      );
      (err as Error & { code?: string }).code = "ORG_INVARIANT";
      throw err;
    }
  }

  await db.execute({
    sql: "DELETE FROM edges WHERE id = ?",
    args: [edgeId],
  });
  await writeAudit(db, userId, "disconnect", "edge", edgeId, {
    source_id: row.source_id,
    target_id: row.target_id,
    relation,
  });
  return { deleted: edgeId };
}

// Move a non-organization node from its current organization to another by
// rebinding the existing belongs_to edge in place. The org-invariant
// triggers (prevent_multi_parent_org on INSERT, prevent_orphan_on_edge_delete
// on DELETE) only fire on INSERT/DELETE, so a single UPDATE preserves the
// "exactly one belongs_to -> organization" invariant by construction. The
// edge id stays stable, so audit history attached to the membership is
// continuous across the move.
export async function moveNodeToOrganization(
  db: Client,
  userId: string,
  nodeId: string,
  newOrgId: string,
): Promise<MoveNodeResult> {
  const nodeRes = await db.execute({
    sql: "SELECT id, type FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (nodeRes.rows.length === 0) {
    throw new Error(`node ${nodeId} not found`);
  }
  if (nodeRes.rows[0].type === "organization") {
    throw new Error(
      `node ${nodeId} is an organization; organizations cannot belong to another organization`,
    );
  }

  const orgRes = await db.execute({
    sql: "SELECT id, type FROM nodes WHERE id = ?",
    args: [newOrgId],
  });
  if (orgRes.rows.length === 0) {
    throw new Error(`organization ${newOrgId} not found`);
  }
  if (orgRes.rows[0].type !== "organization") {
    throw new Error(
      `target ${newOrgId} is not an organization (type: ${orgRes.rows[0].type})`,
    );
  }

  const existing = await db.execute({
    sql: `SELECT e.id, e.target_id
            FROM edges e
            JOIN nodes t ON t.id = e.target_id
           WHERE e.source_id = ?
             AND e.relation = 'belongs_to'
             AND t.type = 'organization'`,
    args: [nodeId],
  });
  if (existing.rows.length === 0) {
    throw new Error(
      `node ${nodeId} has no organization membership; integrity invariant violated`,
    );
  }
  const edgeId = existing.rows[0].id as string;
  const fromOrgId = existing.rows[0].target_id as string;

  if (fromOrgId === newOrgId) {
    return { moved: false, edge_id: edgeId, from_org_id: fromOrgId, to_org_id: newOrgId };
  }

  await db.execute({
    sql: "UPDATE edges SET target_id = ? WHERE id = ?",
    args: [newOrgId, edgeId],
  });

  await writeAudit(db, userId, "move_node", "node", nodeId, {
    edge_id: edgeId,
    from_org_id: fromOrgId,
    to_org_id: newOrgId,
  });

  return { moved: true, edge_id: edgeId, from_org_id: fromOrgId, to_org_id: newOrgId };
}

export function registerEdgeTools(server: McpServer): void {
  server.tool(
    "portuni_connect",
    "Create a directed edge between two nodes. ONLY create edges when the user explicitly asks or when creating a node that requires a belongs_to edge. Never speculatively connect nodes because they seem related. Relations (strictly enforced): related_to (near-default lateral connection), belongs_to (scope; EXACTLY ONE per non-organization node), applies (concrete work uses a pattern, e.g. project applies process), informed_by (knowledge transfer). To move a node between organizations, prefer portuni_move_node -- it rebinds the existing belongs_to atomically. Do NOT disconnect-then-connect across organizations: the disconnect of the only belongs_to is rejected to preserve the invariant. See portuni://architecture.",
    {
      source_id: z.string().describe("Source node ID (ULID)"),
      target_id: z.string().describe("Target node ID (ULID)"),
      relation: z.enum(EDGE_RELATIONS).describe("Relation type: related_to, belongs_to, applies, or informed_by"),
      meta: z.record(z.string(), z.unknown()).optional().describe("Optional metadata for the edge"),
    },
    async (args) => {
      const db = getDb();

      // Verify both nodes exist -- fetch type at the same time so we can
      // enforce the belongs_to -> organization invariant with clear error
      // messages instead of raw trigger abort.
      const sourceCheck = await db.execute({
        sql: "SELECT id, type FROM nodes WHERE id = ?",
        args: [args.source_id],
      });
      if (sourceCheck.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: source node ${args.source_id} not found` }],
          isError: true,
        };
      }
      const sourceType = sourceCheck.rows[0].type as string;

      const targetCheck = await db.execute({
        sql: "SELECT id, type FROM nodes WHERE id = ?",
        args: [args.target_id],
      });
      if (targetCheck.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: target node ${args.target_id} not found` }],
          isError: true,
        };
      }
      const targetType = targetCheck.rows[0].type as string;

      // Organization invariant: a non-org source can only have a single
      // belongs_to -> organization edge. Reject a second one at the tool
      // layer with a clear error (the DB trigger would catch this anyway,
      // but the trigger's message is less actionable).
      if (args.relation === "belongs_to" && targetType === "organization" && sourceType !== "organization") {
        const existing = await db.execute({
          sql: `SELECT e.id, e.target_id, n.name as target_name
                  FROM edges e
                  JOIN nodes n ON n.id = e.target_id
                 WHERE e.source_id = ?
                   AND e.relation = 'belongs_to'
                   AND n.type = 'organization'`,
          args: [args.source_id],
        });
        if (existing.rows.length > 0) {
          const existingOrgName = existing.rows[0].target_name as string;
          const existingOrgId = existing.rows[0].target_id as string;
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: node ${args.source_id} already belongs to organization "${existingOrgName}" (${existingOrgId}). Every non-organization node belongs to exactly one organization -- disconnect the existing belongs_to edge first, or move the node by calling portuni_disconnect followed by a new portuni_connect in a single agent turn.`,
              },
            ],
            isError: true,
          };
        }
      }

      // Self-loop prevention
      if (args.source_id === args.target_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: cannot create edge from a node to itself (${args.source_id}). Self-loops are not allowed.`,
            },
          ],
          isError: true,
        };
      }

      // Check for duplicate edge
      const dupeCheck = await db.execute({
        sql: "SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?",
        args: [args.source_id, args.target_id, args.relation],
      });
      if (dupeCheck.rows.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ id: dupeCheck.rows[0].id, message: "Edge already exists" }),
            },
          ],
        };
      }

      // Insert new edge
      const id = ulid();
      const now = new Date().toISOString();

      await db.execute({
        sql: `INSERT INTO edges (id, source_id, target_id, relation, meta, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          args.source_id,
          args.target_id,
          args.relation,
          args.meta ? JSON.stringify(args.meta) : null,
          SOLO_USER,
          now,
        ],
      });

      await logAudit(SOLO_USER, "connect", "edge", id, {
        source_id: args.source_id,
        target_id: args.target_id,
        relation: args.relation,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id,
              source_id: args.source_id,
              target_id: args.target_id,
              relation: args.relation,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_disconnect",
    "Remove an edge between two nodes. If relation is omitted, removes all edges between the two nodes. Cannot remove the last belongs_to -> organization edge of a non-organization node -- that would orphan the node. To move a node to a different organization, call portuni_move_node({ node_id, new_org_id }) instead: it rebinds the existing belongs_to atomically (single agent turn, single audit row, no transient invariant break). See portuni://architecture.",
    {
      source_id: z.string().describe("Source node ID (ULID)"),
      target_id: z.string().describe("Target node ID (ULID)"),
      relation: z.enum(EDGE_RELATIONS).optional().describe("Relation type to remove (omit to remove all edges between the nodes)"),
    },
    async (args) => {
      const db = getDb();

      // Organization invariant: refuse to remove the last belongs_to ->
      // organization edge of a non-organization node. The DB trigger
      // catches this as a safety net, but returning a clean tool error is
      // more actionable than an "ABORT" bubbled up from SQLite.
      const removingBelongsToOrg =
        args.relation === undefined || args.relation === "belongs_to";
      if (removingBelongsToOrg) {
        const sourceType = await db.execute({
          sql: "SELECT type FROM nodes WHERE id = ?",
          args: [args.source_id],
        });
        const targetType = await db.execute({
          sql: "SELECT type FROM nodes WHERE id = ?",
          args: [args.target_id],
        });
        const srcIsNonOrg =
          sourceType.rows.length > 0 && sourceType.rows[0].type !== "organization";
        const tgtIsOrg =
          targetType.rows.length > 0 && targetType.rows[0].type === "organization";
        if (srcIsNonOrg && tgtIsOrg) {
          const orgCount = await db.execute({
            sql: `SELECT COUNT(*) as n FROM edges e
                    JOIN nodes t ON t.id = e.target_id
                   WHERE e.source_id = ?
                     AND e.relation = 'belongs_to'
                     AND t.type = 'organization'`,
            args: [args.source_id],
          });
          const n = Number(orgCount.rows[0].n);
          if (n <= 1) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: cannot remove the only belongs_to -> organization edge of node ${args.source_id}. Every non-organization node must belong to exactly one organization. To move this node to a different organization, call portuni_move_node({ node_id, new_org_id }) -- it rebinds the existing edge atomically and keeps audit history continuous.`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      let result: Awaited<ReturnType<typeof db.execute>>;
      if (args.relation !== undefined) {
        result = await db.execute({
          sql: "DELETE FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?",
          args: [args.source_id, args.target_id, args.relation],
        });
      } else {
        result = await db.execute({
          sql: "DELETE FROM edges WHERE source_id = ? AND target_id = ?",
          args: [args.source_id, args.target_id],
        });
      }

      await logAudit(SOLO_USER, "disconnect", "edge", `${args.source_id}->${args.target_id}`, {
        source_id: args.source_id,
        target_id: args.target_id,
        relation: args.relation ?? "all",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ disconnected: result.rowsAffected }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_move_node",
    "Move a non-organization node from its current organization to another. Rebinds the existing belongs_to edge atomically -- the org-invariant triggers fire on INSERT/DELETE only, so an UPDATE preserves the 'exactly one belongs_to -> organization' invariant by construction. The edge id stays stable so audit history attached to the membership is continuous. Use this instead of disconnect+connect when relocating a node between organizations.",
    {
      node_id: z.string().describe("Node ID (ULID) to move. Must be non-organization."),
      new_org_id: z.string().describe("Target organization ID (ULID). Must be type 'organization'."),
    },
    async (args) => {
      try {
        const result = await moveNodeToOrganization(
          getDb(),
          SOLO_USER,
          args.node_id,
          args.new_org_id,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
