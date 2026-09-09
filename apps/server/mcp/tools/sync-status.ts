import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { statusScan } from "../../domain/sync/engine.js";
import { nodeVisibleTo } from "../../auth/node-access.js";
import { STATUS_CLASS_VALUES, filterStatusResult } from "../../domain/sync/status-filter.js";
import type { SessionCtx } from "../server.js";

export function registerSyncStatusTools(server: McpServer, ctx: SessionCtx): void {
  server.tool(
    "portuni_status",
    "Scan tracked files (and optionally new local / new remote) for one node or across all mirrors. Classifies each tracked file as clean/push/pull/conflict/remote_missing/remote_error/native and, with includeDiscovery (default true), reports new_local + new_remote + deleted_local. File state is normally kept current automatically by the desktop watcher; call this to force a recompute or to inspect what is unsynced before a deliberate sync (the report shows what to reconcile via portuni_store, portuni_delete_file, or portuni_adopt_files). The result always carries per-class `counts` (even for classes filtered out of the entry lists), so \"what is left to fix\" is one cheap call; use `classes`/`path_prefix`/`limit`/`offset` to narrow a large node down to a response that fits. See portuni://sync-model.",
    {
      node_id: z.string().optional(),
      remote_name: z.string().optional(),
      include_discovery: z
        .boolean()
        .optional()
        .describe("Default true -- scan filesystem + remotes for untracked files."),
      classes: z
        .array(z.enum(STATUS_CLASS_VALUES))
        .optional()
        .describe("Only return entries for these classes (counts are still reported for every class)."),
      path_prefix: z
        .string()
        .optional()
        .describe("Only return entries whose path starts with this prefix."),
      limit: z.number().int().positive().optional().describe("Max entries per class."),
      offset: z.number().int().nonnegative().optional().describe("Skip this many entries per class first."),
    },
    async (args) => {
      const db = getDb();
      if (args.node_id !== undefined) {
        if (!(await nodeVisibleTo(db, ctx.identity, args.node_id))) {
          return {
            content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
            isError: true,
          };
        }
      }
      const result = await statusScan(db, {
        userId: ctx.identity.userId,
        nodeId: args.node_id,
        remoteName: args.remote_name,
        includeDiscovery: args.include_discovery !== false,
      });
      const filtered = filterStatusResult(result, {
        classes: args.classes,
        pathPrefix: args.path_prefix,
        limit: args.limit,
        offset: args.offset,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(filtered) }],
      };
    },
  );
}
