import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@libsql/client";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb } from "../../infra/db.js";
import { SOLO_USER } from "../../infra/schema.js";
import { storeFile } from "../../domain/sync/engine.js";

export interface SnapshotArgs {
  userId: string;
  nodeId: string;
  docUrl: string;
  format?: "pdf" | "markdown" | "docx";
  filename?: string;
  subpath?: string | null;
}

export interface SnapshotResult {
  file_id: string;
  filename: string;
  remote_path: string;
}

async function defaultExport(
  db: Client,
  nodeId: string,
  docUrl: string,
  format: "pdf" | "markdown" | "docx",
): Promise<Buffer> {
  const { resolveNodeInfo } = await import("../../domain/sync/engine.js");
  const info = await resolveNodeInfo(db, nodeId);
  const { resolveRemote } = await import("../../domain/sync/routing.js");
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) throw new Error(`No remote for node ${nodeId}`);
  const { getAdapter } = await import("../../domain/sync/adapter-cache.js");
  const adapter = await getAdapter(db, remoteName);
  if (!adapter.export) throw new Error(`Remote ${remoteName} does not support export`);
  const m = docUrl.match(/\/d\/([A-Za-z0-9_-]+)/);
  const idOrPath = m ? m[1] : docUrl;
  return adapter.export(idOrPath, format);
}

type ExporterFn = (
  db: Client,
  nodeId: string,
  docUrl: string,
  format: "pdf" | "markdown" | "docx",
) => Promise<Buffer>;

let exporter: ExporterFn = defaultExport;
export function __setSnapshotExporterForTests(f: ExporterFn): void {
  exporter = f;
}
export function __resetSnapshotExporterForTests(): void {
  exporter = defaultExport;
}

export async function snapshotService(db: Client, a: SnapshotArgs): Promise<SnapshotResult> {
  const format = a.format ?? "pdf";
  const buf = await exporter(db, a.nodeId, a.docUrl, format);
  const fn =
    a.filename ??
    `snapshot-${Date.now()}.${format === "markdown" ? "md" : format === "docx" ? "docx" : "pdf"}`;
  const dir = await mkdtemp(join(tmpdir(), "portuni-snapshot-"));
  const tmp = join(dir, fn);
  await writeFile(tmp, buf);
  try {
    const r = await storeFile(db, {
      userId: a.userId,
      nodeId: a.nodeId,
      localPath: tmp,
      subpath: a.subpath ?? null,
    });
    return { file_id: r.file_id, filename: fn, remote_path: r.remote_path };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function registerSyncSnapshotTools(server: McpServer): void {
  server.tool(
    "portuni_snapshot",
    "Export a Google Docs/Sheets/Slides URL to PDF/Markdown/DOCX and store it as a tracked file on the node. Uses Drive file ID extracted from the URL (/d/<id>).",
    {
      node_id: z.string(),
      doc_url: z.string().describe("URL of a Google Doc/Sheet/Slide (must contain /d/<id>/)"),
      format: z.enum(["pdf", "markdown", "docx"]).optional(),
      filename: z.string().optional(),
      subpath: z.string().nullable().optional(),
    },
    async (args) => {
      const db = getDb();
      const r = await snapshotService(db, {
        userId: SOLO_USER,
        nodeId: args.node_id,
        docUrl: args.doc_url,
        format: args.format,
        filename: args.filename,
        subpath: args.subpath,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    },
  );
}
