// REST handlers for file content + lifecycle within a node mirror.
//   GET    /nodes/:nodeId/file?path=<rel>        -> read content
//   PUT    /nodes/:nodeId/file?path=<rel>        -> save (local-only, conflict-checked)
//   POST   /nodes/:nodeId/files                  -> create (registers + pushes)
//   POST   /nodes/:nodeId/files/:fileId/rename   -> rename (tracked)
//   DELETE /nodes/:nodeId/files/:fileId          -> delete (two-phase via deleteFile)

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import { parseJsonBody, respondJson, respondError, type RequestIdentity } from "../http/middleware.js";
import {
  readFileContent,
  writeFileContent,
  createFile,
  FileContentError,
  type FileContentErrorCode,
} from "../domain/sync/file-content.js";
import { renameFile, deleteFile } from "../domain/sync/engine-mutations.js";
import type { FileContentResponse } from "../shared/api-types.js";

const CODE_STATUS: Record<FileContentErrorCode, number> = {
  NO_MIRROR: 409,
  NOT_FOUND: 404,
  NOT_EDITABLE: 415,
  CONFLICT: 409,
  EXISTS: 409,
  INVALID_PATH: 400,
};

function handleFileContentError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof FileContentError) {
    const status = CODE_STATUS[err.code];
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.code === "CONFLICT" && err.currentVersion) {
      body.currentVersion = err.currentVersion;
    }
    respondJson(res, status, body);
    return true;
  }
  return false;
}

export async function handleGetFileContent(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
  url: URL,
): Promise<void> {
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    respondJson(res, 400, { error: "path query param required" });
    return;
  }
  try {
    const r = await readFileContent(getDb(), { userId: identity.userId, nodeId, relPath });
    const payload: FileContentResponse = {
      content: r.content,
      version: r.version,
      filename: r.filename,
      mime_type: r.mime_type,
    };
    respondJson(res, 200, payload);
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    respondError(res, `GET /nodes/${nodeId}/file`, err);
  }
}

const putSchema = z.object({
  content: z.string(),
  baseVersion: z.string().optional(),
  force: z.boolean().optional(),
});

export async function handlePutFileContent(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
  url: URL,
): Promise<void> {
  const relPath = url.searchParams.get("path");
  if (!relPath) {
    respondJson(res, 400, { error: "path query param required" });
    return;
  }
  const body = await parseJsonBody(req, res, putSchema);
  if (!body) return;
  try {
    const r = await writeFileContent(getDb(), {
      userId: identity.userId,
      nodeId,
      relPath,
      content: body.content,
      baseVersion: body.baseVersion,
      force: body.force,
    });
    respondJson(res, 200, { version: r.version });
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    respondError(res, `PUT /nodes/${nodeId}/file`, err);
  }
}

const createSchema = z.object({
  filename: z.string().min(1),
  section: z.enum(["wip", "outputs", "resources"]).optional(),
  subpath: z.string().nullish(),
  content: z.string().optional(),
});

export async function handleCreateFile(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  const body = await parseJsonBody(req, res, createSchema);
  if (!body) return;
  try {
    const f = await createFile(getDb(), {
      userId: identity.userId,
      nodeId,
      filename: body.filename,
      section: body.section,
      subpath: body.subpath ?? null,
      content: body.content,
    });
    respondJson(res, 201, f);
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    respondError(res, `POST /nodes/${nodeId}/files`, err);
  }
}

const renameSchema = z.object({ new_filename: z.string().min(1) });

export async function handleRenameFile(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
  fileId: string,
): Promise<void> {
  const body = await parseJsonBody(req, res, renameSchema);
  if (!body) return;
  try {
    const r = await renameFile(getDb(), {
      userId: identity.userId,
      fileId,
      newFilename: body.new_filename,
    });
    respondJson(res, 200, r);
  } catch (err) {
    respondError(res, `POST /nodes/${nodeId}/files/${fileId}/rename`, err);
  }
}

export async function handleDeleteFile(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
  fileId: string,
  url: URL,
): Promise<void> {
  const confirmed = url.searchParams.get("confirmed") === "true";
  try {
    const r = await deleteFile(getDb(), {
      userId: identity.userId,
      fileId,
      mode: "complete",
      confirmed,
    });
    respondJson(res, 200, r);
  } catch (err) {
    respondError(res, `DELETE /nodes/${nodeId}/files/${fileId}`, err);
  }
}
