import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { SOLO_USER } from "../../infra/schema.js";
import { statusScan } from "../../domain/sync/engine.js";

export function registerSyncStatusTools(server: McpServer): void {
  server.tool(
    "portuni_status",
    "Scan tracked files (and optionally new local / new remote) for one node or across all mirrors. Classifies each tracked file as clean/push/pull/conflict/orphan/native and, with includeDiscovery (default true), reports new_local + new_remote + deleted_local. Call after any local file modification (git mv, git rm, edits, plain mv) in a Portuni-mirrored repo and before ending the turn -- the report tells you what to reconcile via portuni_store, portuni_delete_file, or portuni_adopt_files. See portuni://sync-model.",
    {
      node_id: z.string().optional(),
      remote_name: z.string().optional(),
      include_discovery: z
        .boolean()
        .optional()
        .describe("Default true -- scan filesystem + remotes for untracked files."),
    },
    async (args) => {
      const db = getDb();
      const result = await statusScan(db, {
        userId: SOLO_USER,
        nodeId: args.node_id,
        remoteName: args.remote_name,
        includeDiscovery: args.include_discovery !== false,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
