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
import {
  readFileContentRemote,
  writeFileContentRemote,
  readFileBytesRemote,
  writeFileBytesRemote,
  createFileRemote,
  renameFileRemote,
  deleteFileRemote,
} from "../domain/sync/file-content-remote.js";
import {
  getNodeSyncInfo,
  registerFileRecordRemote,
} from "../domain/sync/sync-remote-api.js";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import { renameFile, deleteFile } from "../domain/sync/engine-mutations.js";
import { nodeVisibleTo } from "../auth/node-access.js";
import type { FileContentResponse } from "../shared/api-types.js";

const CODE_STATUS: Record<FileContentErrorCode, number> = {
  NO_MIRROR: 409,
  NO_REMOTE: 409,
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
    const db = getDb();
    // Same node-access enforcement as graph routes: a hidden node looks
    // not-found so its file content never leaks.
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    // Binary-safe byte read for the central-mode sync agent. Remote-only:
    // the central server has no mirrors, and the agent never talks to a
    // mirror-holding server.
    if (url.searchParams.get("encoding") === "base64") {
      const r = await readFileBytesRemote(db, { nodeId, relPath });
      respondJson(res, 200, {
        content_base64: r.bytes.toString("base64"),
        version: r.version,
        canonical_hash: r.canonical_hash,
        filename: r.filename,
        mime_type: r.mime_type,
      });
      return;
    }
    // Mirror present -> local read (unchanged). No mirror (central / VPS)
    // -> Drive-direct read against the routed remote.
    const mirrorRoot = await getMirrorPath(identity.userId, nodeId);
    const r = mirrorRoot
      ? await readFileContent(db, { userId: identity.userId, nodeId, relPath })
      : await readFileContentRemote(db, { userId: identity.userId, nodeId, relPath });
    const payload: FileContentResponse = {
      content: r.content,
      version: r.version,
      filename: r.filename,
      mime_type: r.mime_type,
      local_path: r.local_path,
    };
    respondJson(res, 200, payload);
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    respondError(res, `GET /nodes/${nodeId}/file`, err);
  }
}

const putSchema = z.object({
  content: z.string().optional(),
  // Binary-safe alternative used by the central-mode sync agent. Exactly one
  // of content / content_base64 must be present.
  content_base64: z.string().optional(),
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
  if ((body.content === undefined) === (body.content_base64 === undefined)) {
    respondJson(res, 400, { error: "exactly one of content / content_base64 required" });
    return;
  }
  try {
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    // Binary-safe byte write for the central-mode sync agent (remote-only,
    // see the GET handler). Response carries canonical_hash so the agent can
    // record its synced baseline in files.current_remote_hash terms.
    if (body.content_base64 !== undefined) {
      const r = await writeFileBytesRemote(db, {
        userId: identity.userId,
        nodeId,
        relPath,
        bytes: Buffer.from(body.content_base64, "base64"),
        baseVersion: body.baseVersion,
        force: body.force,
      });
      respondJson(res, 200, { version: r.version, canonical_hash: r.canonical_hash });
      return;
    }
    // Mirror present -> local write (unchanged, push deferred to sync). No
    // mirror (central / VPS) -> Drive-direct write against the routed remote
    // with conflict-on-remote-hash; the Turso canonical hash is refreshed.
    const mirrorRoot = await getMirrorPath(identity.userId, nodeId);
    const r = mirrorRoot
      ? await writeFileContent(db, {
          userId: identity.userId,
          nodeId,
          relPath,
          content: body.content as string,
          baseVersion: body.baseVersion,
          force: body.force,
        })
      : await writeFileContentRemote(db, {
          userId: identity.userId,
          nodeId,
          relPath,
          content: body.content as string,
          baseVersion: body.baseVersion,
          force: body.force,
        });
    respondJson(res, 200, { version: r.version });
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    respondError(res, `PUT /nodes/${nodeId}/file`, err);
  }
}

// GET /nodes/:id/sync-info -- node identity + routed remote + file records,
// the one-round-trip graph-plane snapshot the central-mode sync agent builds
// its status scan on.
export async function handleGetSyncInfo(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  try {
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const info = await getNodeSyncInfo(db, nodeId);
    respondJson(res, 200, info);
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    respondError(res, `GET /nodes/${nodeId}/sync-info`, err);
  }
}

const registerSchema = z.object({ relPath: z.string().min(1) });

// POST /nodes/:id/files/register -- record-only registration (no upload) for
// a file the agent found in a local mirror. See sync-remote-api.ts.
export async function handleRegisterFile(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  nodeId: string,
): Promise<void> {
  const body = await parseJsonBody(req, res, registerSchema);
  if (!body) return;
  try {
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const r = await registerFileRecordRemote(db, {
      userId: identity.userId,
      nodeId,
      relPath: body.relPath,
    });
    respondJson(res, 201, r);
  } catch (err) {
    if (handleFileContentError(res, err)) return;
    if (err instanceof Error && /not found/i.test(err.message)) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    respondError(res, `POST /nodes/${nodeId}/files/register`, err);
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
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    // Mirror present -> local create (registers + pushes). No mirror
    // (central / VPS) -> adapter-direct create against the routed remote.
    const mirrorRoot = await getMirrorPath(identity.userId, nodeId);
    const f = mirrorRoot
      ? await createFile(db, {
          userId: identity.userId,
          nodeId,
          filename: body.filename,
          section: body.section,
          subpath: body.subpath ?? null,
          content: body.content,
        })
      : await createFileRemote(db, {
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
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const mirrorRoot = await getMirrorPath(identity.userId, nodeId);
    const r = mirrorRoot
      ? await renameFile(db, {
          userId: identity.userId,
          fileId,
          newFilename: body.new_filename,
        })
      : await renameFileRemote(db, {
          userId: identity.userId,
          nodeId,
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
    const db = getDb();
    if (!(await nodeVisibleTo(db, identity, nodeId))) {
      respondJson(res, 404, { error: "node not found" });
      return;
    }
    const mirrorRoot = await getMirrorPath(identity.userId, nodeId);
    const r = mirrorRoot
      ? await deleteFile(db, {
          userId: identity.userId,
          fileId,
          mode: "complete",
          confirmed,
        })
      : await deleteFileRemote(db, {
          userId: identity.userId,
          nodeId,
          fileId,
          mode: "complete",
          confirmed,
        });
    respondJson(res, 200, r);
  } catch (err) {
    respondError(res, `DELETE /nodes/${nodeId}/files/${fileId}`, err);
  }
}
