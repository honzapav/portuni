import { z } from "zod";
import { getDb } from "../db.js";
import { logAudit } from "../audit.js";
import { SOLO_USER, FILE_STATUSES } from "../schema.js";
import {
  storeFile,
  pullFile,
  previewNode,
  moveFile,
  renameFolder,
  adoptFiles,
  deleteFile,
} from "../sync/engine.js";
import { getMirrorPath } from "../sync/mirror-registry.js";
import { buildNodeRoot, deriveLocalPath } from "../sync/remote-path.js";
import type { InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decideGlobalQuery, guardNodeRead, type SessionScope } from "../scope.js";

export function registerFileTools(server: McpServer, scope: SessionScope): void {
  server.tool(
    "portuni_store",
    "Store a file for a node: copies into the node's local mirror, uploads to the routed remote, and tracks it for sync. Uses sync_key-based paths so renaming nodes does not break remote storage.",
    {
      node_id: z.string().describe("Target node ID"),
      local_path: z.string().describe("Absolute path of the source file on this device"),
      description: z.string().optional(),
      status: z
        .enum(["wip", "output"])
        .optional()
        .describe("Section routing (wip or outputs)"),
      subpath: z
        .string()
        .nullable()
        .optional()
        .describe("Optional subfolder within the section"),
    },
    async (args) => {
      const db = getDb();
      const result = await storeFile(db, {
        userId: SOLO_USER,
        nodeId: args.node_id,
        localPath: args.local_path,
        description: args.description ?? null,
        status: args.status,
        subpath: args.subpath ?? null,
      });
      await logAudit(SOLO_USER, "portuni_store", "file", result.file_id, {
        ...result,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "portuni_pull",
    "Pull mode: with file_id, download remote content into mirror. With node_id (preview), classify each file (unchanged/updated/conflict/orphan/native) without modifying anything.",
    {
      file_id: z.string().optional(),
      node_id: z.string().optional(),
    },
    async (args) => {
      if (!args.file_id && !args.node_id) {
        throw new Error("portuni_pull requires either file_id or node_id");
      }
      const db = getDb();
      if (args.file_id) {
        const r = await pullFile(db, { userId: SOLO_USER, fileId: args.file_id });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }],
        };
      }
      const p = await previewNode(db, { userId: SOLO_USER, nodeId: args.node_id! });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(p, null, 2) }],
      };
    },
  );

  server.tool(
    "portuni_list_files",
    "List files across nodes, optionally filtered by node and/or status. Each file includes a derived local_path built from the current mirror + remote_path + sync_key (null when the node has no mirror on this device). Subject to session scope: with node_id the node must be in scope; without node_id the call is treated as a global query and is mode-gated.",
    {
      node_id: z.string().optional(),
      status: z.enum(FILE_STATUSES).optional(),
    },
    async (args) => {
      const db = getDb();

      // Scope gate. With node_id, ensure the node is in scope. Without it,
      // treat as global query.
      if (args.node_id !== undefined) {
        const guard = await guardNodeRead(
          db,
          scope,
          args.node_id,
          SOLO_USER,
          async (action, targetId, detail) => {
            await logAudit(SOLO_USER, action, "scope", targetId, detail);
          },
        );
        if (guard.kind === "not_found") {
          return {
            content: [
              { type: "text" as const, text: `Error: node ${args.node_id} not found` },
            ],
            isError: true,
          };
        }
        if (guard.kind === "elicit") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(guard.error) }],
            isError: true,
          };
        }
      } else {
        const g = decideGlobalQuery(scope);
        if (g.kind === "elicit") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "scope_expansion_required",
                  tool: "portuni_list_files",
                  hint: g.message,
                }),
              },
            ],
            isError: true,
          };
        }
        scope.globalQuerySeen = true;
        await logAudit(SOLO_USER, "scope_global_query", "scope", "list_files", {
          tool: "portuni_list_files",
          filters: { status: args.status ?? null },
          mode: scope.mode,
        });
      }

      const conds: string[] = [];
      const params: InValue[] = [];
      if (args.node_id !== undefined) {
        conds.push("f.node_id = ?");
        params.push(args.node_id);
      } else {
        // No node filter: when not yet permissive-mode auto-allowed, restrict
        // to the in-memory scope set so unrelated nodes aren't surfaced.
        const inScope = scope.list();
        if (scope.mode !== "permissive") {
          if (inScope.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify([], null, 2) }],
            };
          }
          const placeholders = inScope.map(() => "?").join(",");
          conds.push(`f.node_id IN (${placeholders})`);
          params.push(...inScope);
        }
      }
      if (args.status !== undefined) {
        conds.push("f.status = ?");
        params.push(args.status);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

      const result = await db.execute({
        sql: `SELECT f.id, f.node_id, n.name AS node_name, n.type AS node_type, n.sync_key AS node_sync_key,
                     f.filename, f.status, f.description,
                     f.remote_name, f.remote_path, f.current_remote_hash,
                     f.last_pushed_at, f.is_native_format, f.updated_at,
                     (SELECT org.sync_key FROM edges e JOIN nodes org ON org.id = e.target_id
                       WHERE e.source_id = f.node_id AND e.relation = 'belongs_to' AND org.type = 'organization' LIMIT 1) AS org_sync_key
              FROM files f JOIN nodes n ON f.node_id = n.id
              ${where}
              ORDER BY f.updated_at DESC`,
        args: params,
      });

      const enriched = await Promise.all(
        result.rows.map(async (row) => {
          const nodeId = row.node_id as string;
          const rp = row.remote_path as string | null;
          let localPath: string | null = null;
          if (rp) {
            const mirror = await getMirrorPath(SOLO_USER, nodeId);
            if (mirror) {
              const nodeRoot = buildNodeRoot({
                orgSyncKey: (row.org_sync_key as string | null) ?? null,
                nodeType: row.node_type as string,
                nodeSyncKey: row.node_sync_key as string,
              });
              try {
                localPath = deriveLocalPath({
                  mirrorRoot: mirror,
                  nodeRoot,
                  remotePath: rp,
                });
              } catch {
                localPath = null;
              }
            }
          }
          return {
            id: row.id,
            node_id: nodeId,
            node_name: row.node_name,
            filename: row.filename,
            status: row.status,
            description: row.description,
            remote_name: row.remote_name,
            remote_path: rp,
            current_remote_hash: row.current_remote_hash,
            last_pushed_at: row.last_pushed_at,
            is_native_format: Number(row.is_native_format) === 1,
            local_path: localPath,
            updated_at: row.updated_at,
          };
        }),
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }],
      };
    },
  );

  server.tool(
    "portuni_move_file",
    "Move a file within its node (new subpath or section) or across nodes. First call returns a preview; pass confirmed: true on the second call to execute. Best-effort ordered: remote, then local, then DB. Partial failure returns repair_needed with a hint.",
    {
      file_id: z.string(),
      new_subpath: z.string().nullable().optional(),
      new_section: z.enum(["wip", "outputs", "resources"]).optional(),
      new_node_id: z.string().optional(),
      confirmed: z.boolean().optional(),
    },
    async (args) => {
      const db = getDb();
      const r = await moveFile(db, {
        userId: SOLO_USER,
        fileId: args.file_id,
        newSubpath: args.new_subpath ?? null,
        newSection: args.new_section,
        newNodeId: args.new_node_id,
        confirmed: args.confirmed,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "portuni_rename_folder",
    "Rename a subpath within a node's sync layout. Default dry_run: true returns preview of affected files. Pass dry_run: false to apply.",
    {
      node_id: z.string(),
      old_prefix: z.string(),
      new_prefix: z.string(),
      dry_run: z.boolean().optional(),
    },
    async (args) => {
      const db = getDb();
      const r = await renameFolder(db, {
        userId: SOLO_USER,
        nodeId: args.node_id,
        oldPrefix: args.old_prefix,
        newPrefix: args.new_prefix,
        dryRun: args.dry_run !== false,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "portuni_adopt_files",
    "Register existing remote files (not currently tracked) as files rows for the given node. Safe, non-destructive.",
    {
      node_id: z.string(),
      paths: z.array(z.string()),
      status: z.enum(["wip", "output"]).optional(),
    },
    async (args) => {
      const db = getDb();
      const r = await adoptFiles(db, {
        userId: SOLO_USER,
        nodeId: args.node_id,
        paths: args.paths,
        status: args.status,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "portuni_delete_file",
    "Delete a file. Modes: complete (remote + local + portuni) or unregister_only (only portuni row). First call returns preview; second call with confirmed: true executes.",
    {
      file_id: z.string(),
      mode: z.enum(["complete", "unregister_only"]).optional(),
      confirmed: z.boolean().optional(),
    },
    async (args) => {
      const db = getDb();
      const r = await deleteFile(db, {
        userId: SOLO_USER,
        fileId: args.file_id,
        mode: args.mode,
        confirmed: args.confirmed,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );
}
