import { z } from "zod";
import { getDb } from "../../infra/db.js";
import { SOLO_USER } from "../../infra/schema.js";
import {
  createMirrorForNode,
  MirrorCreateError,
} from "../../domain/sync/mirror-create.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMirrorTools(server: McpServer): void {
  server.tool(
    "portuni_mirror",
    "Create a local folder for a node and register it. Default path: {root}/{org-slug}/{type-plural}/{node-slug}/ (e.g. workflow/processes/gws-implementation). Organizations mirror directly to {root}/{org-slug}/. Creates outputs/, wip/, resources/ subfolders. Targets: only 'local' supported in Phase 1.",
    {
      node_id: z.string().describe("Node ID (ULID)"),
      targets: z
        .array(z.enum(["local"]))
        .describe("Mirror targets (only 'local' supported in Phase 1)"),
      custom_path: z
        .string()
        .optional()
        .describe("Optional override for default path ({root}/{org-slug}/{type-plural}/{node-slug})"),
    },
    async (args) => {
      try {
        const result = await createMirrorForNode(getDb(), SOLO_USER, {
          nodeId: args.node_id,
          customPath: args.custom_path,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                node_id: result.node_id,
                local_path: result.local_path,
                subdirs: result.subdirs,
                remote_scaffold: result.remote_scaffold,
                scope_config: result.scope_config,
              }),
            },
          ],
        };
      } catch (e) {
        if (e instanceof MirrorCreateError) {
          return {
            content: [{ type: "text" as const, text: `Error: ${e.message}` }],
            isError: true,
          };
        }
        throw e;
      }
    },
  );
}
