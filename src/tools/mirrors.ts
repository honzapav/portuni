import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDb } from "../db.js";
import { logAudit } from "../audit.js";
import { SOLO_USER } from "../schema.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const NodeMinimalRow = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

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
      const db = getDb();

      // 1. Verify node exists, get name and type
      const nodeResult = await db.execute({
        sql: "SELECT id, name, type FROM nodes WHERE id = ?",
        args: [args.node_id],
      });

      if (nodeResult.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
          isError: true,
        };
      }

      const node = NodeMinimalRow.parse(nodeResult.rows[0]);
      const nodeName = node.name;

      // 2. Compute slug and path
      const slug = slugify(nodeName);
      const root = process.env.PORTUNI_WORKSPACE_ROOT?.replace(/^~/, homedir());
      if (!root) {
        return {
          content: [{ type: "text" as const, text: "Error: PORTUNI_WORKSPACE_ROOT env variable is not set" }],
          isError: true,
        };
      }

      let localPath: string;
      if (args.custom_path) {
        localPath = args.custom_path;
      } else if (node.type === "organization") {
        localPath = join(root, slug);
      } else {
        // Resolve org-aware path: {root}/{org-slug}/{type-plural}/{node-slug}
        const orgRow = await db.execute({
          sql: `SELECT n.name FROM edges e JOIN nodes n ON n.id = e.target_id
                WHERE e.source_id = ? AND e.relation = 'belongs_to' AND n.type = 'organization'
                LIMIT 1`,
          args: [args.node_id],
        });
        const TYPE_PLURAL: Record<string, string> = {
          project: "projects",
          process: "processes",
          area: "areas",
          principle: "principles",
        };
        const typePlural = TYPE_PLURAL[node.type] ?? node.type;
        if (orgRow.rows.length > 0) {
          const orgSlug = slugify(orgRow.rows[0].name as string);
          localPath = join(root, orgSlug, typePlural, slug);
        } else {
          localPath = join(root, typePlural, slug);
        }
      }

      // 3. Create directory structure
      const subdirs = ["outputs", "wip", "resources"];
      for (const subdir of subdirs) {
        await mkdir(join(localPath, subdir), { recursive: true });
      }

      // 4. Upsert into local_mirrors
      await db.execute({
        sql: `INSERT INTO local_mirrors (user_id, node_id, local_path, registered_at)
              VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(user_id, node_id) DO UPDATE SET local_path = ?, registered_at = datetime('now')`,
        args: [SOLO_USER, args.node_id, localPath, localPath],
      });

      // 5. Log audit
      await logAudit(SOLO_USER, "mirror_local", "node", args.node_id, {
        local_path: localPath,
      });

      // 6. Return result
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              node_id: args.node_id,
              local_path: localPath,
              subdirs: ["outputs/", "wip/", "resources/"],
            }),
          },
        ],
      };
    },
  );
}
