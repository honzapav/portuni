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
import { filterVisibleNodeIds, nodeVisibleTo } from "../../auth/node-access.js";
import { readableMirrorRoot } from "../disk-projection.js";
import { guardNodeRead } from "../scope.js";
import { guardNodeWrite } from "../write-gate.js";
import { readNodeFile, formatNodeFileContent } from "../../domain/read-node-file.js";
import { searchFiles } from "../../domain/search-files.js";
import { SEARCH_HITS_DEFAULT_LIMIT, SEARCH_HITS_MAX_LIMIT, SEARCH_SNIPPET_MAX_CHARS } from "../../domain/sync/types.js";
import type { SessionCtx } from "../server.js";
import type { Client } from "@libsql/client";

// Resolves a file's owning node so callers can run the same visibility
// guard as node-targeted tools. Returns null when the file row is missing
// (callers fall through to the domain function's own not-found error).
async function fileNodeId(db: Client, fileId: string): Promise<string | null> {
  const row = await db.execute({
    sql: "SELECT node_id FROM files WHERE id = ?",
    args: [fileId],
  });
  return row.rows.length > 0 ? (row.rows[0].node_id as string) : null;
}

const NODE_NOT_FOUND = {
  content: [{ type: "text" as const, text: "Error: node not found" }],
  isError: true,
};

export function registerFileTools(server: McpServer, ctx: SessionCtx): void {
  const { scope } = ctx;

  server.tool(
    "portuni_read_file",
    "Read a file's content from an in-scope node that is NOT your home node or one of its direct neighbours. Those nodes' folders are directly readable on disk (use the native Read/Grep tools on the local_path from portuni_get_context/get_node); this tool is for nodes reached by deeper graph traversal, whose files the sandbox does not expose on disk -- and for sessions with no local workspace at all (a remote client): when the node has no mirror on the serving machine, the file is read straight from its routed remote (Google Drive). Returns UTF-8 text, or base64 for binary. `path` is the file's path within the node (e.g. \"wip/notes.md\"). Reading a node not yet in scope triggers a scope-expansion prompt, same as portuni_get_node.",
    {
      node_id: z.string().describe("Node the file belongs to"),
      path: z.string().describe("File path within the node, e.g. 'wip/notes.md'"),
    },
    async (args) => {
      const db = getDb();
      const guard = await guardNodeRead(db, scope, args.node_id, ctx.identity.userId, ctx.identity, ctx.elicit);
      if (guard.kind === "not_found") {
        return { content: [{ type: "text" as const, text: "Node not found" }], isError: true };
      }
      if (guard.kind === "elicit" || guard.kind === "refused") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(guard.error) }],
          isError: true,
        };
      }
      const r = await readNodeFile(db, ctx.identity.userId, args.node_id, args.path);
      return formatNodeFileContent(r, args.path);
    },
  );

  server.tool(
    "portuni_search_files",
    "Search file CONTENTS across Portuni-tracked files, using the configured remote(s)' own full-text search (Google Drive `fullText contains`; text grep on fs remotes). Search is discovery, not ingestion: permission-only in every session type, no scope gate -- results are filtered by node visibility, same as any other read, not by session scope. With node_id the search is restricted to that node; without node_id it searches every node the caller can see. Each hit carries node_id + path plus a bounded snippet; open the full file with portuni_read_file(node_id, path) (that read follows the normal scope-expansion rules). Drive matches whole words/phrases in indexed content (docs, PDFs, text); it is not a substring or regex search.",
    {
      query: z.string().min(1).describe("Words or a phrase to find in file contents"),
      node_id: z.string().optional().describe("Restrict to one node"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(SEARCH_HITS_MAX_LIMIT)
        .optional()
        .describe(`Max hits (default ${SEARCH_HITS_DEFAULT_LIMIT}, max ${SEARCH_HITS_MAX_LIMIT})`),
    },
    async (args) => {
      const db = getDb();
      const limit = args.limit ?? SEARCH_HITS_DEFAULT_LIMIT;

      // Over-fetch so group-visibility filtering below still leaves `limit`
      // rows in the common case.
      const records = await searchFiles(db, {
        query: args.query,
        limit: Math.min(limit * 2, 100),
        nodeId: args.node_id,
      });
      const distinctNodeIds = [...new Set(records.map((r) => r.node_id))];
      const visible = await filterVisibleNodeIds(db, ctx.identity, distinctNodeIds);
      const hits = records
        .filter((r) => visible.has(r.node_id))
        .slice(0, limit)
        .map((r) => ({
          file_id: r.file_id,
          node_id: r.node_id,
          node_name: r.node_name,
          node_type: r.node_type,
          filename: r.filename,
          path: r.path,
          mime_type: r.mime_type,
          ...(r.modified_at !== undefined ? { modified_at: r.modified_at } : {}),
          // Cap enforced here, at the tool boundary, rather than trusted to
          // each remote adapter: search is discovery, not ingestion (spec,
          // "Search is discovery, not ingestion") -- a producer that forgets
          // to bound its own snippet (or grows one from a backend-provided
          // full match) must not turn into an ingestion channel.
          ...(r.snippet !== undefined ? { snippet: r.snippet.slice(0, SEARCH_SNIPPET_MAX_CHARS) } : {}),
        }));
      return { content: [{ type: "text" as const, text: JSON.stringify(hits, null, 2) }] };
    },
  );

  server.tool(
    "portuni_store",
    "Register a file with Portuni AND upload it to the routed remote (a deliberate push): copies into the node's local mirror if needed, uploads, and creates/updates the files row. New files in a mirror are normally registered automatically (without upload) by the desktop watcher, so reach for portuni_store when you explicitly want to push a file to the remote -- or to register+upload in an environment without the watcher (files there surface as new_local from portuni_status). For files surfaced as new_remote (created elsewhere, already on the remote), use portuni_adopt_files instead. Uses sync_key-based paths so renaming nodes does not break remote storage. See portuni://sync-model.",
    {
      node_id: z.string().describe("Target node ID"),
      local_path: z.string().describe("Absolute path of the source file on this device"),
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
      if (!(await nodeVisibleTo(db, ctx.identity, args.node_id))) {
        return NODE_NOT_FOUND;
      }
      const storeWriteGuard = await guardNodeWrite(scope, args.node_id, ctx.elicit);
      if (storeWriteGuard.kind === "error") return storeWriteGuard.response;
      const result = await storeFile(db, {
        userId: ctx.identity.userId,
        nodeId: args.node_id,
        localPath: args.local_path,
        status: args.status,
        subpath: args.subpath ?? null,
      });
      // local_path intentionally excluded: the audit log lives in Turso
      // and absolute machine paths should not leave the device.
      await logAudit(ctx.identity.userId, "portuni_store", "file", result.file_id, {
        file_id: result.file_id,
        remote_name: result.remote_name,
        remote_path: result.remote_path,
        hash: result.hash,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "portuni_pull",
    "Two modes selected by which argument you pass. With file_id: download the remote version into the mirror and refresh the local hash cache — use to restore a deleted local copy or pull a teammate's update. With node_id: classify each file (unchanged/updated/conflict/remote_missing/remote_error/native) without modifying anything — use as a preview before pulling. Exactly one of file_id or node_id must be provided.",
    {
      file_id: z.string().optional().describe("File ID (ULID). Download mode — fetches the remote version into the mirror."),
      node_id: z.string().optional().describe("Node ID (ULID). Preview mode — classifies each file without modifying anything."),
      force: z.boolean().optional().describe("Download mode only: overwrite the local file even when it has unpushed local changes. Default false — such pulls are refused to protect local edits."),
    },
    async (args) => {
      if (!args.file_id && !args.node_id) {
        throw new Error("portuni_pull requires either file_id or node_id");
      }
      const db = getDb();
      if (args.file_id) {
        const nodeId = await fileNodeId(db, args.file_id);
        if (nodeId) {
          if (!(await nodeVisibleTo(db, ctx.identity, nodeId))) {
            return NODE_NOT_FOUND;
          }
          const pullWriteGuard = await guardNodeWrite(scope, nodeId, ctx.elicit);
          if (pullWriteGuard.kind === "error") return pullWriteGuard.response;
        }
        const r = await pullFile(db, { userId: ctx.identity.userId, fileId: args.file_id, force: args.force });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }],
        };
      }
      if (!(await nodeVisibleTo(db, ctx.identity, args.node_id!))) {
        return NODE_NOT_FOUND;
      }
      const p = await previewNode(db, { userId: ctx.identity.userId, nodeId: args.node_id! });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(p, null, 2) }],
      };
    },
  );

  server.tool(
    "portuni_list_files",
    "List files across nodes, optionally filtered by node and/or status. Each file includes a derived local_path built from the current mirror + remote_path + sync_key (null when the node has no mirror on this device). With node_id the node must be in session scope; without node_id results are restricted to the current session scope set (empty scope means an empty result), except for connector (interactive_chat) sessions, which have no scope set and see every file on nodes visible to them — see portuni://scope-rules.",
    {
      node_id: z.string().optional(),
      status: z.enum(FILE_STATUSES).optional(),
      limit: z.number().int().min(1).max(2000).optional().describe("Max rows (default 500, newest first)"),
    },
    async (args) => {
      const db = getDb();

      const gate = await guardListScope(
        db,
        scope,
        args.node_id,
        ctx.identity.userId,
        ctx.identity,
        ctx.elicit,
      );
      if (gate.kind === "error") return gate.response;

      const conds: string[] = [];
      const params: InValue[] = [];
      if (args.node_id !== undefined) {
        conds.push("f.node_id = ?");
        params.push(args.node_id);
      } else if (scope.sessionType === "interactive_chat") {
        // interactive_chat has no in-memory scope set to restrict to (read
        // scope = permissions): fall through with no node filter, and rely
        // on the group-visibility filter below, same as global list_nodes.
      } else {
        // No node filter: restrict to the in-memory scope set so unrelated
        // nodes aren't surfaced.
        const inScope = scope.list();
        if (inScope.length === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify([], null, 2) }],
          };
        }
        const placeholders = inScope.map(() => "?").join(",");
        conds.push(`f.node_id IN (${placeholders})`);
        params.push(...inScope);
      }
      if (args.status !== undefined) {
        conds.push("f.status = ?");
        params.push(args.status);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";

      const result = await db.execute({
        sql: `SELECT f.id, f.node_id, n.name AS node_name, n.type AS node_type, n.sync_key AS node_sync_key,
                     f.filename, f.status,
                     f.remote_name, f.remote_path, f.current_remote_hash,
                     f.last_pushed_at, f.is_native_format, f.updated_at,
                     (SELECT org.sync_key FROM edges e JOIN nodes org ON org.id = e.target_id
                       WHERE e.source_id = f.node_id AND e.relation = 'belongs_to' AND org.type = 'organization' LIMIT 1) AS org_sync_key
              FROM files f JOIN nodes n ON f.node_id = n.id
              ${where}
              ORDER BY f.updated_at DESC
              LIMIT ?`,
        args: [...params, args.limit ?? 500],
      });

      // Filter rows by group visibility before enrichment.
      const distinctNodeIds = [...new Set(result.rows.map((r) => r.node_id as string))];
      const visibleFileNodeSet = await filterVisibleNodeIds(db, ctx.identity, distinctNodeIds);
      const visibleRows = result.rows.filter((r) => visibleFileNodeSet.has(r.node_id as string));

      // One mirror lookup per visible node, not per file row (it hits the
      // local sync.db each time). For in-scope non-home nodes, we resolve to
      // this session's hardlink projection directory so paths match what the
      // Seatbelt sandbox actually allows the agent to read.
      const mirrorByNode = new Map<string, string | null>();
      const homeMirror = scope.homeNodeId
        ? await getMirrorPath(ctx.identity.userId, scope.homeNodeId)
        : null;
      for (const row of visibleRows) {
        const nodeId = row.node_id as string;
        if (!mirrorByNode.has(nodeId)) {
          const real = await getMirrorPath(ctx.identity.userId, nodeId);
          let projectionDir: string | null = null;
          if (nodeId !== scope.homeNodeId && scope.has(nodeId)) {
            const r = await ctx.projector.projectNode(nodeId);
            projectionDir = r?.dir ?? null;
          }
          mirrorByNode.set(
            nodeId,
            readableMirrorRoot({ scope, nodeId, homeMirror, realMirror: real, projectionDir }),
          );
        }
      }

      const enriched = await Promise.all(
        visibleRows.map(async (row) => {
          const nodeId = row.node_id as string;
          const rp = row.remote_path as string | null;
          let localPath: string | null = null;
          if (rp) {
            const mirror = mirrorByNode.get(nodeId) ?? null;
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
      const sourceNodeId = await fileNodeId(db, args.file_id);
      if (sourceNodeId) {
        if (!(await nodeVisibleTo(db, ctx.identity, sourceNodeId))) {
          return NODE_NOT_FOUND;
        }
        const sourceWriteGuard = await guardNodeWrite(scope, sourceNodeId, ctx.elicit);
        if (sourceWriteGuard.kind === "error") return sourceWriteGuard.response;
      }
      if (args.new_node_id) {
        if (!(await nodeVisibleTo(db, ctx.identity, args.new_node_id))) {
          return NODE_NOT_FOUND;
        }
        const destWriteGuard = await guardNodeWrite(scope, args.new_node_id, ctx.elicit);
        if (destWriteGuard.kind === "error") return destWriteGuard.response;
      }
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
      if (!(await nodeVisibleTo(db, ctx.identity, args.node_id))) {
        return NODE_NOT_FOUND;
      }
      const renameWriteGuard = await guardNodeWrite(scope, args.node_id, ctx.elicit);
      if (renameWriteGuard.kind === "error") return renameWriteGuard.response;
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
      if (!(await nodeVisibleTo(db, ctx.identity, args.node_id))) {
        return NODE_NOT_FOUND;
      }
      const adoptWriteGuard = await guardNodeWrite(scope, args.node_id, ctx.elicit);
      if (adoptWriteGuard.kind === "error") return adoptWriteGuard.response;
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
      const nodeId = await fileNodeId(db, args.file_id);
      if (nodeId) {
        if (!(await nodeVisibleTo(db, ctx.identity, nodeId))) {
          return NODE_NOT_FOUND;
        }
        const deleteWriteGuard = await guardNodeWrite(scope, nodeId, ctx.elicit);
        if (deleteWriteGuard.kind === "error") return deleteWriteGuard.response;
      }
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
