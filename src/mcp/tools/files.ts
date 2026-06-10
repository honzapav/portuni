import { z } from "zod";
import { getDb } from "../../infra/db.js";
import { logAudit } from "../../infra/audit.js";
import { FILE_STATUSES } from "../../infra/schema.js";
import {
  storeFile,
  pullFile,
  previewNode,
  moveFile,
  renameFolder,
  adoptFiles,
  deleteFile,
} from "../../domain/sync/engine.js";
import { getMirrorPath } from "../../domain/sync/mirror-registry.js";
import { buildNodeRoot, deriveLocalPath } from "../../domain/sync/remote-path.js";
import type { InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guardListScope } from "../list-scope-gate.js";
import { filterVisibleNodeIds } from "../../auth/node-access.js";
import type { SessionCtx } from "../server.js";

export function registerFileTools(server: McpServer, ctx: SessionCtx): void {
  const { scope } = ctx;
  server.tool(
    "portuni_store",
    "Register a file with Portuni: copies into the node's local mirror (if not already there), uploads to the routed remote, and creates the files row. Use this IMMEDIATELY after you create a new file inside any mirror via Write, Edit, MultiEdit, or shell cp/mv -- treat 'create file in wip/outputs/resources' and 'call portuni_store' as a single atomic step. Write alone places bytes on disk but does not register the file; the next session, the remote, and teammates will not see it. Also use for files surfaced as new_local by portuni_status. For files surfaced as new_remote (created elsewhere, already on the remote), use portuni_adopt_files instead. Uses sync_key-based paths so renaming nodes does not break remote storage. See portuni://sync-model.",
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
        userId: ctx.identity.userId,
        nodeId: args.node_id,
        localPath: args.local_path,
        description: args.description ?? null,
        status: args.status,
        subpath: args.subpath ?? null,
      });
      await logAudit(ctx.identity.userId, "portuni_store", "file", result.file_id, {
        ...result,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "portuni_pull",
    "Two modes selected by which argument you pass. With file_id: download the remote version into the mirror and refresh the local hash cache — use to restore a deleted local copy or pull a teammate's update. With node_id: classify each file (unchanged/updated/conflict/orphan/native) without modifying anything — use as a preview before pulling. Exactly one of file_id or node_id must be provided.",
    {
      file_id: z.string().optional().describe("File ID (ULID). Download mode — fetches the remote version into the mirror."),
      node_id: z.string().optional().describe("Node ID (ULID). Preview mode — classifies each file without modifying anything."),
    },
    async (args) => {
      if (!args.file_id && !args.node_id) {
        throw new Error("portuni_pull requires either file_id or node_id");
      }
      const db = getDb();
      if (args.file_id) {
        const r = await pullFile(db, { userId: ctx.identity.userId, fileId: args.file_id });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }],
        };
      }
      const p = await previewNode(db, { userId: ctx.identity.userId, nodeId: args.node_id! });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(p, null, 2) }],
      };
    },
  );

  server.tool(
    "portuni_list_files",
    "List files across nodes, optionally filtered by node and/or status. Each file includes a derived local_path built from the current mirror + remote_path + sync_key (null when the node has no mirror on this device). With node_id the node must be in session scope; without node_id the call is a global query — see portuni://scope-rules.",
    {
      node_id: z.string().optional(),
      status: z.enum(FILE_STATUSES).optional(),
    },
    async (args) => {
      const db = getDb();

      const gate = await guardListScope(
        db,
        scope,
        args.node_id,
        "portuni_list_files",
        "list_files",
        { status: args.status ?? null },
        ctx.identity.userId,
        ctx.identity,
      );
      if (gate.kind === "error") return gate.response;

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

      // Filter rows by group visibility before enrichment.
      const distinctNodeIds = [...new Set(result.rows.map((r) => r.node_id as string))];
      const visibleFileNodeSet = await filterVisibleNodeIds(db, ctx.identity, distinctNodeIds);
      const visibleRows = result.rows.filter((r) => visibleFileNodeSet.has(r.node_id as string));

      const enriched = await Promise.all(
        visibleRows.map(async (row) => {
          const nodeId = row.node_id as string;
          const rp = row.remote_path as string | null;
          let localPath: string | null = null;
          if (rp) {
            const mirror = await getMirrorPath(ctx.identity.userId, nodeId);
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
    "Move a file within its node (new subpath or section) or across nodes. Confirm-first: the first call returns a preview without acting; show the preview to the user, then call again with confirmed: true to execute. Best-effort ordered: remote, then local, then DB. Partial failure returns repair_needed with a hint. See portuni://sync-model.",
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
        userId: ctx.identity.userId,
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
    "Rename a subpath within a node's sync layout. Defaults to dry_run: true and returns a preview of affected files. Show the affected file list to the user; call again with dry_run: false to apply. See portuni://sync-model.",
    {
      node_id: z.string(),
      old_prefix: z.string(),
      new_prefix: z.string(),
      dry_run: z.boolean().optional(),
    },
    async (args) => {
      const db = getDb();
      const r = await renameFolder(db, {
        userId: ctx.identity.userId,
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
    "Register existing remote files (not currently tracked) as files rows for the given node. Non-destructive. Use after portuni_status surfaces new_remote entries to bring them under tracking. See portuni://sync-model.",
    {
      node_id: z.string(),
      paths: z.array(z.string()),
      status: z.enum(["wip", "output"]).optional(),
    },
    async (args) => {
      const db = getDb();
      const r = await adoptFiles(db, {
        userId: ctx.identity.userId,
        nodeId: args.node_id,
        paths: args.paths,
        status: args.status,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    "portuni_delete_file",
    "Delete a file. Confirm-first: the first call returns a preview without acting; show the preview to the user, then call again with confirmed: true to execute. Modes: complete (remote + local + portuni DB row) and unregister_only (only the DB row — use when the file is already gone from disk and remote). See portuni://sync-model.",
    {
      file_id: z.string(),
      mode: z.enum(["complete", "unregister_only"]).optional(),
      confirmed: z.boolean().optional(),
    },
    async (args) => {
      const db = getDb();
      const r = await deleteFile(db, {
        userId: ctx.identity.userId,
        fileId: args.file_id,
        mode: args.mode,
        confirmed: args.confirmed,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );
}
