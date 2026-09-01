// MCP tool registrations for node CRUD. Logic lives in src/domain/nodes.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { logAudit } from "../../infra/audit.js";
import {
  NODE_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
} from "../../infra/schema.js";
import { getMirrorPath } from "../../domain/sync/mirror-registry.js";
import { NodeRow, NodeSummaryRow } from "../../shared/types.js";
import type { InValue } from "@libsql/client";
import {
  createNodeInternal,
  purgeNodeLocalCleanup,
  purgeNodeRows,
  updateNodeInternal,
} from "../../domain/nodes.js";
import { filterVisibleNodeIds, nodeVisibleTo } from "../../auth/node-access.js";
import { guardNodeWrite } from "../write-gate.js";
import type { SessionCtx } from "../server.js";

export function registerNodeTools(server: McpServer, ctx: SessionCtx): void {
  const { scope } = ctx;
  server.tool(
    "portuni_create_node",
    // Not write-gated: creation is exempt because there is no existing node
    // to protect -- the new node is added to the read AND write set below,
    // as soon as it exists (see the addWritable call after createNodeInternal).
    "Create a new node in the Portuni knowledge graph. Create only when the user explicitly asks — agent-initiative nodes pollute the graph and the user cannot easily distinguish them later. Non-organization nodes must specify organization_id; the node and its belongs_to edge are inserted atomically. Optionally set goal (textual purpose) and lifecycle_state — status is derived. See portuni://architecture for the invariant and portuni://enums for the closed type / lifecycle sets.",
    {
      type: z.enum(NODE_TYPES).describe("Node type. See portuni://enums for the closed set."),
      name: z.string().describe("Human-readable name"),
      description: z.string().optional().describe("What this node represents"),
      organization_id: z.string().optional().describe("Organization ID (ULID) — required for non-organization types. Ignored when type='organization'. The new node is atomically connected to this organization via belongs_to."),
      meta: z.record(z.string(), z.unknown()).optional().describe("Type-specific JSON data"),
      status: z.enum(NODE_STATUSES).optional().describe("Node status (default: active). Prefer setting lifecycle_state — status is derived from it."),
      visibility: z.enum(NODE_VISIBILITIES).optional().describe("Visibility (default: team)"),
      goal: z.string().optional().describe("Optional textual goal / purpose of the node."),
      lifecycle_state: z.string().optional().describe("Optional primary lifecycle state — type-specific. See portuni://enums for the per-type closed set. status is derived from this."),
    },
    async (args) => {
      const db = getDb();

      // organization_id is an FK from the request -- when present, verify
      // the caller can see that org, otherwise this is an IDOR: creating a
      // node under an organization the user has no access to. Same rule as
      // the REST path (handleCreateNode).
      if (
        args.organization_id &&
        !(await nodeVisibleTo(db, ctx.identity, args.organization_id))
      ) {
        return {
          content: [{ type: "text" as const, text: "Error: node not found" }],
          isError: true,
        };
      }

      // Surface duplicate name+type as a non-blocking warning -- the LLM
      // sees it and can ask the user before continuing.
      const dupeNameCheck = await db.execute({
        sql: "SELECT id, name FROM nodes WHERE name = ? AND type = ?",
        args: [args.name, args.type],
      });
      const nameWarning =
        dupeNameCheck.rows.length > 0
          ? `Warning: node with same name and type already exists: ${dupeNameCheck.rows.map((r) => r.id).join(", ")}. This is allowed but may cause ambiguity in name-based lookups.`
          : null;

      let id: string;
      try {
        id = await createNodeInternal(db, ctx.identity.userId, args);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      // A node created by this session enters its read and write set
      // automatically -- a task's outputs are part of its context by
      // definition (spec: "Read scope").
      scope.addWritable(id);
      scope.recordExpansion({
        at: new Date().toISOString(),
        node_ids: [id],
        reason: "node created by this session",
        triggered_by: "agent",
        addedVia: "created",
      });

      const result = {
        id,
        type: args.type,
        name: args.name,
        status: args.status ?? "active",
        ...(args.organization_id && args.type !== "organization"
          ? { belongs_to: args.organization_id }
          : {}),
        ...(nameWarning ? { warning: nameWarning } : {}),
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "portuni_update_node",
    "Update an existing node in the Portuni knowledge graph. Only provided fields change. Status is derived from lifecycle_state — prefer setting lifecycle_state. owner_id must reference an existing actor (person, placeholder, or automation).",
    {
      node_id: z.string().describe("Node ID (ULID)"),
      name: z.string().optional().describe("New human-readable name"),
      description: z.string().nullable().optional().describe("New description"),
      status: z.enum(NODE_STATUSES).optional().describe("New coarse status. Prefer setting lifecycle_state — status is derived from it."),
      visibility: z.enum(NODE_VISIBILITIES).optional().describe("New visibility"),
      meta: z.record(z.string(), z.unknown()).optional().describe("New type-specific JSON data"),
      goal: z.string().nullable().optional().describe("New goal text. Pass null to clear."),
      lifecycle_state: z.string().nullable().optional().describe("New lifecycle state — type-specific. See portuni://enums for the per-type closed set. Pass null to clear."),
      owner_id: z.string().nullable().optional().describe("New owner (actors.id). Any existing actor works — person, placeholder, or automation. Pass null to clear."),
    },
    async (args) => {
      const db = getDb();

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
      // Group-visibility write guard: non-members see not-found.
      if (!(await nodeVisibleTo(db, ctx.identity, args.node_id))) {
        return {
          content: [{ type: "text" as const, text: "Error: node not found" }],
          isError: true,
        };
      }
      const writeGuard = await guardNodeWrite(scope, args.node_id, ctx.elicit);
      if (writeGuard.kind === "error") return writeGuard.response;
      NodeRow.parse(current.rows[0]);

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
        await updateNodeInternal(db, ctx.identity.userId, args);
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
          { type: "text" as const, text: JSON.stringify({ id: args.node_id, updated: updatedKeys }) },
        ],
      };
    },
  );

  server.tool(
    "portuni_list_nodes",
    "List nodes from the Portuni knowledge graph, optionally filtered by type and/or status. Default scope='session' returns only nodes already in the session scope set. scope='global' is discovery, not ingestion: it is permission-only in every session type (no scope gate) and returns every node the caller can see, filtered by visibility like any other read. Empty session-scope results mean the agent should call portuni_expand_scope or ask the user; a global result is not itself added to scope -- reading a hit's full detail follows the normal expansion rules. See portuni://scope-rules.",
    {
      type: z.enum(NODE_TYPES).optional().describe("Filter by node type"),
      status: z.enum(NODE_STATUSES).optional().describe("Filter by status"),
      scope: z
        .enum(["session", "global"])
        .optional()
        .default("session")
        .describe("session (default): nodes already in the session scope set. global: every node the caller can see, permission-only — see portuni://scope-rules."),
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

      if (args.scope !== "global") {
        const inScope = scope.list();
        if (inScope.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify([], null, 2) }] };
        }
        const placeholders = inScope.map(() => "?").join(",");
        conditions.push(`id IN (${placeholders})`);
        values.push(...inScope);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const result = await db.execute({
        sql: `SELECT id, type, name, status, description FROM nodes ${where} ORDER BY created_at DESC`,
        args: values,
      });

      const allNodes = result.rows.map((row) => NodeSummaryRow.parse(row));

      // Filter by group visibility: non-members never see group-restricted nodes.
      const rawIds = allNodes.map((n) => n.id);
      const visibleSet = await filterVisibleNodeIds(db, ctx.identity, rawIds);
      const nodes = allNodes.filter((n) => visibleSet.has(n.id));

      return { content: [{ type: "text" as const, text: JSON.stringify(nodes, null, 2) }] };
    },
  );

  server.tool(
    "portuni_delete_node",
    "Delete a node from the Portuni knowledge graph. Use only when the user explicitly asks. Two modes: 'archive' (default, soft delete — sets status to archived, preserves edges and history) and 'purge' (hard delete — permanently removes node and cascade-deletes all edges, files, events, and mirrors). Organizations with children cannot be purged — re-parent children first.",
    {
      node_id: z.string().describe("Node ID (ULID) to delete"),
      mode: z
        .enum(["archive", "purge"])
        .default("archive")
        .describe("archive (soft delete, default) or purge (hard delete)"),
    },
    async (args) => {
      const db = getDb();

      const existing = await db.execute({
        sql: "SELECT id, type, name, status FROM nodes WHERE id = ?",
        args: [args.node_id],
      });
      if (existing.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
          isError: true,
        };
      }
      // Group-visibility write guard: non-members see not-found.
      if (!(await nodeVisibleTo(db, ctx.identity, args.node_id))) {
        return {
          content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
          isError: true,
        };
      }
      const deleteWriteGuard = await guardNodeWrite(scope, args.node_id, ctx.elicit);
      if (deleteWriteGuard.kind === "error") return deleteWriteGuard.response;
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
        await logAudit(ctx.identity.userId, "archive_node", "node", args.node_id, {
          type: nodeType,
          name: nodeName,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ id: args.node_id, name: nodeName, action: "archived" }),
            },
          ],
        };
      }

      // --- purge mode ---

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

      const mirrorPath = await getMirrorPath(ctx.identity.userId, args.node_id);

      await purgeNodeRows(db, args.node_id);

      await purgeNodeLocalCleanup(db, ctx.identity.userId, args.node_id);

      await logAudit(ctx.identity.userId, "purge_node", "node", args.node_id, {
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

      return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
    },
  );
}
