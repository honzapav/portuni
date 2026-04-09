import { z } from "zod";
import { ulid } from "ulid";
import { copyFile, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { getDb } from "../db.js";
import { logAudit } from "../audit.js";
import { SOLO_USER, FILE_STATUSES } from "../schema.js";
import type { InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MIME_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

async function getNodeLocalPath(nodeId: string): Promise<string | null> {
  const db = getDb();
  const result = await db.execute({
    sql: "SELECT local_path FROM local_mirrors WHERE user_id = ? AND node_id = ?",
    args: [SOLO_USER, nodeId],
  });
  return result.rows.length > 0 ? (result.rows[0].local_path as string) : null;
}

export function registerFileTools(server: McpServer): void {
  server.tool(
    "portuni_store",
    "Store a file in a node's local folder. Copies the file from source path into the node's mirror folder (wip/ or outputs/ based on status) and registers it in Portuni.",
    {
      node_id: z.string().describe("Node ID (ULID)"),
      local_path: z.string().describe("Absolute path to the source file"),
      description: z.string().optional().describe("Description of the file"),
      status: z
        .enum(FILE_STATUSES)
        .default("wip")
        .describe("File status: wip (work in progress) or output (final)"),
    },
    async (args) => {
      // 1. Get node's mirror path
      const mirrorPath = await getNodeLocalPath(args.node_id);
      if (!mirrorPath) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Node has no local mirror. Run portuni_mirror first.",
            },
          ],
          isError: true,
        };
      }

      // 2. Verify source file exists
      try {
        await stat(args.local_path);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Source file not found at ${args.local_path}`,
            },
          ],
          isError: true,
        };
      }

      // 3. Determine target directory
      const targetDir = args.status === "output" ? "outputs" : "wip";
      const filename = basename(args.local_path);
      const targetPath = join(mirrorPath, targetDir, filename);

      // 4. Copy file
      await copyFile(args.local_path, targetPath);

      // 5. Insert into files table
      const db = getDb();
      const id = ulid();
      const now = new Date().toISOString();
      const mimeType = MIME_TYPES[extname(filename).toLowerCase()] ?? null;

      await db.execute({
        sql: `INSERT INTO files (id, node_id, filename, local_path, status, description, mime_type, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          args.node_id,
          filename,
          targetPath,
          args.status,
          args.description ?? null,
          mimeType,
          SOLO_USER,
          now,
          now,
        ],
      });

      // 6. Audit
      await logAudit(SOLO_USER, "store_file", "file", id, {
        node_id: args.node_id,
        filename,
        status: args.status,
      });

      // 7. Return result
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, filename, local_path: targetPath, status: args.status }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_pull",
    "List files attached to a node with their local paths and statuses. In Phase 1 (local-only), this returns file metadata and paths.",
    {
      node_id: z.string().describe("Node ID (ULID)"),
    },
    async (args) => {
      const db = getDb();

      // 1. Query files for this node
      const result = await db.execute({
        sql: `SELECT id, filename, local_path, status, description, updated_at
              FROM files WHERE node_id = ? ORDER BY updated_at DESC`,
        args: [args.node_id],
      });

      // 2. Get node's mirror path
      const mirrorPath = await getNodeLocalPath(args.node_id);

      // 3. Return result
      const files = result.rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        local_path: row.local_path,
        status: row.status,
        description: row.description,
        updated_at: row.updated_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { node_id: args.node_id, mirror_path: mirrorPath, files },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_list_files",
    "List files across all nodes, optionally filtered by node and/or status.",
    {
      node_id: z.string().optional().describe("Filter by node ID"),
      status: z
        .enum(FILE_STATUSES)
        .optional()
        .describe("Filter by file status"),
    },
    async (args) => {
      const db = getDb();

      // 1. Build dynamic WHERE
      const conditions: string[] = [];
      const values: InValue[] = [];

      if (args.node_id !== undefined) {
        conditions.push("f.node_id = ?");
        values.push(args.node_id);
      }
      if (args.status !== undefined) {
        conditions.push("f.status = ?");
        values.push(args.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // 2. JOIN with nodes for node_name
      const result = await db.execute({
        sql: `SELECT f.id, f.node_id, n.name AS node_name, f.filename, f.local_path,
                     f.status, f.description, f.updated_at
              FROM files f
              JOIN nodes n ON f.node_id = n.id
              ${where}
              ORDER BY f.updated_at DESC`,
        args: values,
      });

      // 3. Return results
      const files = result.rows.map((row) => ({
        id: row.id,
        node_id: row.node_id,
        node_name: row.node_name,
        filename: row.filename,
        local_path: row.local_path,
        status: row.status,
        description: row.description,
        updated_at: row.updated_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(files, null, 2),
          },
        ],
      };
    },
  );
}
