import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { statusScan } from "../../domain/sync/engine.js";
import { nodeVisibleTo } from "../../auth/node-access.js";
import {
  LOCAL_STATUS_CLASS_VALUES,
  STATUS_CLASS_VALUES,
  filterStatusResult,
  localStatusView,
} from "../../domain/sync/status-filter.js";
import { isLocalWorkspace } from "../../infra/server-config.js";
import type { SessionCtx } from "../server.js";

const TEAM_DESCRIPTION =
  "Scan tracked files (and optionally new local / new remote) for one node or across all mirrors. Classifies each tracked file as clean/push/pull/conflict/remote_missing/remote_error/native and, with includeDiscovery (default true), reports new_local + new_remote + deleted_local. File state is normally kept current automatically by the desktop watcher; call this to force a recompute or to inspect what is unsynced before a deliberate sync (the report shows what to reconcile via portuni_store, portuni_delete_file, or portuni_adopt_files). The result always carries per-class `counts` (even for classes filtered out of the entry lists), so \"what is left to fix\" is one cheap call; use `classes`/`path_prefix`/`limit`/`offset` to narrow a large node down to a response that fits. See portuni://sync-model.";

const PERSONAL_DESCRIPTION =
  "Scan the files of one node or of all mirrors on this device and report the local state: clean (registered and on disk), deleted_local (registered, gone from disk) and, with include_discovery (default true), new_local (on disk, not registered yet). This is a personal workspace: files stay on this device and there is no remote. File state is normally kept current automatically by the desktop watcher; call this to force a recompute. The result always carries per-class `counts`; use `classes`/`path_prefix`/`limit`/`offset` to narrow a large node down. See portuni://sync-model.";

// A personal workspace has no remote (#310, #575): portuni_status there
// speaks only the local classes -- a tracked file on disk (clean), a
// tracked file gone from disk (deleted_local), a file on disk with no
// record (new_local) -- and takes no remote_name.
export function registerSyncStatusTools(server: McpServer, ctx: SessionCtx): void {
  const personal = isLocalWorkspace();
  const classValues = personal ? LOCAL_STATUS_CLASS_VALUES : STATUS_CLASS_VALUES;
  server.tool(
    "portuni_status",
    personal ? PERSONAL_DESCRIPTION : TEAM_DESCRIPTION,
    {
      node_id: z.string().optional(),
      ...(personal ? {} : { remote_name: z.string().optional() }),
      include_discovery: z
        .boolean()
        .optional()
        .describe(
          personal
            ? "Default true -- scan the mirror folders for files that are not registered yet."
            : "Default true -- scan filesystem + remotes for untracked files.",
        ),
      classes: z
        .array(z.enum(classValues as unknown as typeof STATUS_CLASS_VALUES))
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
        remoteName: personal ? undefined : (args as { remote_name?: string }).remote_name,
        includeDiscovery: args.include_discovery !== false,
      });
      const filtered = filterStatusResult(result, {
        classes: args.classes,
        pathPrefix: args.path_prefix,
        limit: args.limit,
        offset: args.offset,
      });
      const body = personal ? localStatusView(filtered) : filtered;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
      };
    },
  );
}
