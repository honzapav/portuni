import { z } from "zod";
import { getDb } from "../db.js";
import { SOLO_USER } from "../schema.js";
import { NodeRow } from "../types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildContextPayload } from "./context.js";

export function registerGetNodeTool(server: McpServer): void {
  server.tool(
    "portuni_get_node",
    "Get a single node from the Portuni knowledge graph by ID or name. Returns the node's core fields plus owner, responsibilities (with assignees), data_sources, tools, goal, lifecycle_state, direct edges (both directions), files, events, and local mirror path.",
    {
      node_id: z.string().optional().describe("Node ID (ULID)"),
      name: z.string().optional().describe("Node name (case-insensitive match)"),
    },
    async (args) => {
      const db = getDb();

      // 1. Look up the node (by id or case-insensitive name).
      let result;
      if (args.node_id) {
        result = await db.execute({
          sql: "SELECT * FROM nodes WHERE id = ?",
          args: [args.node_id],
        });
      } else if (args.name) {
        result = await db.execute({
          sql: "SELECT * FROM nodes WHERE name = ? COLLATE NOCASE",
          args: [args.name],
        });
      } else {
        return {
          content: [{ type: "text" as const, text: "Error: provide either node_id or name" }],
          isError: true,
        };
      }

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Node not found" }],
          isError: true,
        };
      }

      // B2: Name-based lookups may be ambiguous if duplicate names exist.
      if (args.name && result.rows.length > 1) {
        const matches = result.rows.map((r) => `${r.type}:${r.name} (${r.id})`).join("; ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Ambiguous: ${result.rows.length} nodes match name '${args.name}'. Use node_id instead. Matches: ${matches}`,
            },
          ],
          isError: true,
        };
      }

      const row = NodeRow.parse(result.rows[0]);

      // 2. Delegate depth-0 enrichment to buildContextPayload so the
      //    owner/responsibilities/data_sources/tools/goal/lifecycle_state
      //    logic stays in a single place. We still own the one-off fields
      //    this tool returns that the context payload does not: files,
      //    visibility, created_by/at, updated_at, meta, local_mirror
      //    (registered_at).
      const { root } = await buildContextPayload(db, row.id, 0);

      // 3. Fetch files for this node (kept here -- buildContextPayload does
      //    not include files).
      const fileResult = await db.execute({
        sql: `SELECT id, filename, status, description, local_path, mime_type
              FROM files WHERE node_id = ? ORDER BY created_at DESC`,
        args: [row.id],
      });

      const files = fileResult.rows.map((f) => ({
        id: f.id as string,
        filename: f.filename as string,
        status: f.status as string,
        description: f.description as string | null,
        local_path: f.local_path as string | null,
        mime_type: f.mime_type as string | null,
      }));

      // 4. Fetch local mirror with registered_at (the context payload only
      //    exposes local_path; this tool returns the richer pair).
      const mirrorResult = await db.execute({
        sql: `SELECT local_path, registered_at
              FROM local_mirrors WHERE user_id = ? AND node_id = ?`,
        args: [SOLO_USER, row.id],
      });

      const localMirror =
        mirrorResult.rows.length > 0
          ? {
              local_path: mirrorResult.rows[0].local_path as string,
              registered_at: mirrorResult.rows[0].registered_at as string,
            }
          : null;

      // 5. Assemble response. The new E3 fields (owner, responsibilities,
      //    data_sources, tools, goal, lifecycle_state) come from root;
      //    everything else retains the previous shape so existing consumers
      //    are unaffected.
      const node = {
        id: row.id,
        type: row.type,
        name: row.name,
        description: row.description,
        meta: row.meta ? JSON.parse(row.meta) : null,
        status: row.status,
        visibility: row.visibility,
        goal: root.goal,
        lifecycle_state: root.lifecycle_state,
        owner: root.owner,
        responsibilities: root.responsibilities,
        data_sources: root.data_sources,
        tools: root.tools,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        edges: root.edges,
        files,
        events: root.events,
        local_mirror: localMirror,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(node, null, 2) }],
      };
    },
  );
}
