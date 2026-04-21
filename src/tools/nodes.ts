import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "../db.js";
import { logAudit } from "../audit.js";
import {
  NODE_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
  SOLO_USER,
} from "../schema.js";
import { getLifecycleStatesForType } from "../popp.js";
import type { NodeType } from "../popp.js";
import { NodeRow, NodeSummaryRow } from "../types.js";
import type { Client, InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// --- Task E1: pure updateNode, exported for tests ---
//
// updateNodeInternal accepts db explicitly so tests can run it against an
// in-memory client. The MCP tool handler below calls this with getDb().
export const UpdateNodeInput = z.object({
  node_id: z.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  status: z.enum(NODE_STATUSES).optional(),
  visibility: z.enum(NODE_VISIBILITIES).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  goal: z.string().nullable().optional(),
  lifecycle_state: z.string().nullable().optional(),
  owner_id: z.string().nullable().optional(),
});
export type UpdateNodeInput = z.infer<typeof UpdateNodeInput>;

// Direct audit writer taking db explicitly. The shared logAudit() helper
// hard-codes getDb(), so we re-implement the INSERT here to keep the pure
// function pure.
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

export async function updateNodeInternal(
  db: Client,
  updatedBy: string,
  input: UpdateNodeInput,
): Promise<void> {
  const args = UpdateNodeInput.parse(input);

  // Look up node type for lifecycle validation and to confirm existence.
  const row = await db.execute({
    sql: "SELECT type FROM nodes WHERE id = ?",
    args: [args.node_id],
  });
  if (row.rows.length === 0) {
    throw new Error(`node ${args.node_id} not found`);
  }
  const nodeType = row.rows[0].type as NodeType;

  // Pre-validate lifecycle_state against per-type enum for a friendly error
  // before the DB trigger fires.
  if (args.lifecycle_state !== undefined && args.lifecycle_state !== null) {
    const valid = getLifecycleStatesForType(nodeType);
    if (!valid.includes(args.lifecycle_state)) {
      throw new Error(
        `invalid lifecycle_state '${args.lifecycle_state}' for node type '${nodeType}'. Valid: ${valid.join(", ")}`,
      );
    }
  }

  // Update non-lifecycle fields first (all in one UPDATE so owner_id trigger
  // fires once, and updated_at bumps once).
  const sets: string[] = [];
  const values: InValue[] = [];
  if (args.name !== undefined) {
    sets.push("name = ?");
    values.push(args.name);
  }
  if (args.description !== undefined) {
    sets.push("description = ?");
    values.push(args.description);
  }
  if (args.status !== undefined) {
    sets.push("status = ?");
    values.push(args.status);
  }
  if (args.visibility !== undefined) {
    sets.push("visibility = ?");
    values.push(args.visibility);
  }
  if (args.meta !== undefined) {
    sets.push("meta = ?");
    values.push(JSON.stringify(args.meta));
  }
  if (args.goal !== undefined) {
    sets.push("goal = ?");
    values.push(args.goal);
  }
  if (args.owner_id !== undefined) {
    sets.push("owner_id = ?");
    values.push(args.owner_id);
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(args.node_id);
    await db.execute({
      sql: `UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`,
      args: values,
    });
  }

  // Update lifecycle_state separately so the AFTER UPDATE OF lifecycle_state
  // trigger fires and derives status. (Splitting guarantees the trigger
  // sees a real column-value change on exactly that column.)
  if (args.lifecycle_state !== undefined) {
    await db.execute({
      sql: "UPDATE nodes SET lifecycle_state = ? WHERE id = ?",
      args: [args.lifecycle_state, args.node_id],
    });
  }

  await writeAudit(db, updatedBy, "update_node", "node", args.node_id, { input: args });
}

export function registerNodeTools(server: McpServer): void {
  server.tool(
    "portuni_create_node",
    "Create a new node in the Portuni knowledge graph. ONLY create nodes when the user explicitly asks. Never create nodes as a side effect of other work or to organize things on your own initiative. Node types (strictly enforced): organization, project, process, area, principle. Every non-organization node MUST specify organization_id -- it will be atomically connected to that organization via a belongs_to edge. Every non-organization node belongs to exactly one organization.",
    {
      type: z.enum(NODE_TYPES).describe("Node type: organization, project, process, area, or principle"),
      name: z.string().describe("Human-readable name"),
      description: z.string().optional().describe("What this node represents"),
      organization_id: z.string().optional().describe("Organization ID (ULID) -- required for non-organization types. Ignored when type='organization'. The new node will be atomically connected to this organization via belongs_to."),
      meta: z.record(z.string(), z.unknown()).optional().describe("Type-specific JSON data"),
      status: z.enum(NODE_STATUSES).optional().describe("Node status (default: active)"),
      visibility: z.enum(NODE_VISIBILITIES).optional().describe("Visibility (default: team)"),
    },
    async (args) => {
      const db = getDb();

      // Validate organization_id requirement: non-org types MUST belong to
      // exactly one organization. Pre-validate the org exists and has the
      // right type so the error message is clear rather than a DB-level
      // FK/trigger error fired deep inside the batch.
      if (args.type !== "organization") {
        if (!args.organization_id) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: organization_id is required for type=${args.type}. Every non-organization node must belong to exactly one organization.`,
              },
            ],
            isError: true,
          };
        }
        const orgCheck = await db.execute({
          sql: "SELECT id, type FROM nodes WHERE id = ?",
          args: [args.organization_id],
        });
        if (orgCheck.rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: organization_id ${args.organization_id} not found`,
              },
            ],
            isError: true,
          };
        }
        if (orgCheck.rows[0].type !== "organization") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${args.organization_id} is a ${orgCheck.rows[0].type}, not an organization`,
              },
            ],
            isError: true,
          };
        }
      }

      // B2: Check for duplicate name+type (warning, not block).
      const dupeNameCheck = await db.execute({
        sql: "SELECT id, name FROM nodes WHERE name = ? AND type = ?",
        args: [args.name, args.type],
      });
      const nameWarning =
        dupeNameCheck.rows.length > 0
          ? `Warning: node with same name and type already exists: ${dupeNameCheck.rows.map((r) => r.id).join(", ")}. This is allowed but may cause ambiguity in name-based lookups.`
          : null;

      const id = ulid();
      const now = new Date().toISOString();
      const edgeId = args.type !== "organization" ? ulid() : null;

      // Atomic batch: node INSERT and (for non-org types) belongs_to edge
      // INSERT succeed or fail together. Guarantees the org invariant from
      // the moment the node comes into existence -- there is no window in
      // which the node exists without its required organization link.
      const statements: Parameters<typeof db.batch>[0] = [
        {
          sql: `INSERT INTO nodes (id, type, name, description, meta, status, visibility, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            args.type,
            args.name,
            args.description ?? null,
            args.meta ? JSON.stringify(args.meta) : null,
            args.status ?? "active",
            args.visibility ?? "team",
            SOLO_USER,
            now,
            now,
          ],
        },
      ];

      if (edgeId && args.organization_id) {
        statements.push({
          sql: `INSERT INTO edges (id, source_id, target_id, relation, meta, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [edgeId, id, args.organization_id, "belongs_to", null, SOLO_USER, now],
        });
      }

      await db.batch(statements, "write");

      await logAudit(SOLO_USER, "create_node", "node", id, {
        type: args.type,
        name: args.name,
        ...(args.organization_id ? { organization_id: args.organization_id } : {}),
      });

      const result = {
        id,
        type: args.type,
        name: args.name,
        status: args.status ?? "active",
        ...(args.organization_id && edgeId
          ? { belongs_to: args.organization_id, edge_id: edgeId }
          : {}),
        ...(nameWarning ? { warning: nameWarning } : {}),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_update_node",
    "Update an existing node in the Portuni knowledge graph. Only provided fields are changed. Status is derived automatically from lifecycle_state -- prefer setting lifecycle_state. owner_id must reference an actor of type=person with user_id set, in the same organization.",
    {
      node_id: z.string().describe("Node ID (ULID)"),
      name: z.string().optional().describe("New human-readable name"),
      description: z.string().nullable().optional().describe("New description"),
      status: z.enum(NODE_STATUSES).optional().describe("New coarse status. Prefer setting lifecycle_state -- status is derived automatically."),
      visibility: z.enum(NODE_VISIBILITIES).optional().describe("New visibility"),
      meta: z.record(z.string(), z.unknown()).optional().describe("New type-specific JSON data"),
      goal: z.string().nullable().optional().describe("New goal text. Pass null to clear."),
      lifecycle_state: z.string().nullable().optional().describe("New lifecycle state. Must be valid for node type (project: backlog/planned/in_progress/on_hold/done/cancelled; process: not_implemented/implementing/operating/at_risk/broken/retired; etc.). Pass null to clear."),
      owner_id: z.string().nullable().optional().describe("New owner (actors.id). Must reference an actor of type=person with user_id set (non-placeholder) in the same organization. Pass null to clear."),
    },
    async (args) => {
      const db = getDb();

      // Pre-existing behavior: verify node exists up front so the error
      // message is friendly (rather than letting the UPDATE silently affect
      // zero rows or a trigger fire with confusing text).
      const current = await db.execute({
        sql: "SELECT * FROM nodes WHERE id = ?",
        args: [args.node_id],
      });
      if (current.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: node not found" }],
          isError: true,
        };
      }
      // Parse so legacy callers still get the same validation surface.
      NodeRow.parse(current.rows[0]);

      // Determine whether any field was actually provided, so we keep the
      // pre-existing "no fields to update" error.
      const provided = [
        args.name,
        args.description,
        args.status,
        args.visibility,
        args.meta,
        args.goal,
        args.lifecycle_state,
        args.owner_id,
      ].some((v) => v !== undefined);
      if (!provided) {
        return {
          content: [{ type: "text" as const, text: "Error: no fields to update" }],
          isError: true,
        };
      }

      try {
        await updateNodeInternal(db, SOLO_USER, args);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      const updatedKeys = Object.entries(args)
        .filter(([k, v]) => k !== "node_id" && v !== undefined)
        .map(([k]) => k);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: args.node_id, updated: updatedKeys }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_list_nodes",
    "List nodes from the Portuni knowledge graph, optionally filtered by type and/or status.",
    {
      type: z.enum(NODE_TYPES).optional().describe("Filter by node type"),
      status: z.enum(NODE_STATUSES).optional().describe("Filter by status"),
    },
    async (args) => {
      const db = getDb();

      const conditions: string[] = [];
      const values: InValue[] = [];

      if (args.type !== undefined) {
        conditions.push("type = ?");
        values.push(args.type);
      }
      if (args.status !== undefined) {
        conditions.push("status = ?");
        values.push(args.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await db.execute({
        sql: `SELECT id, type, name, status, description FROM nodes ${where} ORDER BY created_at DESC`,
        args: values,
      });

      const nodes = result.rows.map((row) => NodeSummaryRow.parse(row));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(nodes, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_delete_node",
    "Delete a node from the Portuni knowledge graph. Two modes: 'archive' (default, soft delete -- sets status to archived, preserves edges and history) or 'purge' (hard delete -- permanently removes node and cascade-deletes all edges, files, events, and mirrors). Purge is irreversible. Organizations with children cannot be purged -- re-parent children first.",
    {
      node_id: z.string().describe("Node ID (ULID) to delete"),
      mode: z
        .enum(["archive", "purge"])
        .default("archive")
        .describe("archive (soft delete, default) or purge (hard delete, irreversible)"),
    },
    async (args) => {
      const db = getDb();

      // Verify node exists and fetch its type/name for messages.
      const existing = await db.execute({
        sql: "SELECT id, type, name, status FROM nodes WHERE id = ?",
        args: [args.node_id],
      });
      if (existing.rows.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `Error: node ${args.node_id} not found` },
          ],
          isError: true,
        };
      }
      const node = existing.rows[0];
      const nodeType = node.type as string;
      const nodeName = node.name as string;

      if (args.mode === "archive") {
        if (node.status === "archived") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Node ${args.node_id} ("${nodeName}") is already archived.`,
              },
            ],
          };
        }
        const now = new Date().toISOString();
        await db.execute({
          sql: "UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?",
          args: [now, args.node_id],
        });
        await logAudit(SOLO_USER, "archive_node", "node", args.node_id, {
          type: nodeType,
          name: nodeName,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: args.node_id,
                name: nodeName,
                action: "archived",
              }),
            },
          ],
        };
      }

      // --- purge mode ---

      // If this is an organization, check that no non-org children belong to it.
      if (nodeType === "organization") {
        const children = await db.execute({
          sql: `SELECT n.id, n.type, n.name FROM edges e
                  JOIN nodes n ON n.id = e.source_id
                 WHERE e.target_id = ?
                   AND e.relation = 'belongs_to'
                   AND n.type != 'organization'`,
          args: [args.node_id],
        });
        if (children.rows.length > 0) {
          const list = children.rows
            .map((r) => `${r.type}:${r.name} (${r.id})`)
            .join("; ");
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: cannot purge organization "${nodeName}" -- it has ${children.rows.length} child node(s). Re-parent them first: ${list}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Fetch local mirror path before deletion (for informational response).
      const mirrorRes = await db.execute({
        sql: "SELECT local_path FROM local_mirrors WHERE user_id = ? AND node_id = ?",
        args: [SOLO_USER, args.node_id],
      });
      const mirrorPath =
        mirrorRes.rows.length > 0
          ? (mirrorRes.rows[0].local_path as string)
          : null;

      // Delete edges first so the orphan-prevention trigger does not fire
      // during CASCADE. Then delete the node (remaining CASCADE covers
      // files, events, mirrors).
      await db.batch(
        [
          { sql: "DELETE FROM edges WHERE source_id = ? OR target_id = ?", args: [args.node_id, args.node_id] },
          { sql: "DELETE FROM nodes WHERE id = ?", args: [args.node_id] },
        ],
        "write",
      );

      await logAudit(SOLO_USER, "purge_node", "node", args.node_id, {
        type: nodeType,
        name: nodeName,
      });

      const response: Record<string, unknown> = {
        id: args.node_id,
        name: nodeName,
        action: "purged",
      };
      if (mirrorPath) {
        response.local_mirror_path = mirrorPath;
        response.note =
          "Local mirror folder was NOT deleted from disk. Remove it manually if no longer needed.";
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(response) },
        ],
      };
    },
  );
}
