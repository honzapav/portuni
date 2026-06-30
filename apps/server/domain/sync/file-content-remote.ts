// Mirror-less, Drive-direct file content + lifecycle (Phase B, B1+B2+B3).
//
// The local readFileContent/writeFileContent (file-content.ts) and the
// engine-mutations lifecycle (createFile/renameFile/deleteFile) resolve a
// mirror folder on disk. A central-mode teammate -- and the VPS that brokers
// for them -- has no mirror, so this module talks to the routed remote
// adapter directly: resolve node -> remote + remote path -> adapter
// get/put/rename/delete.
//
// Optimistic concurrency is kept identical to the local path: `version` is the
// sha256 of the bytes, and a stale `baseVersion` raises FileContentError
// CONFLICT with `currentVersion`. The conflict check compares against the
// CURRENT REMOTE bytes (there is no per-device sync.db here). After a write
// the Turso file record's canonical hash is refreshed so the graph plane stays
// consistent with the bytes on the remote.
//
// Lifecycle (B3) mirrors the local contracts adapter-direct: create registers
// + uploads, rename swaps the basename on the remote + DB, delete is
// confirm-first and removes the remote object then the DB row (repair_needed
// on a remote-delete failure, never a silent desync).
//
// Native formats (gdoc/gsheet/gslide) are not plain-text round-trippable:
// PUT is rejected with NOT_EDITABLE and reads are short-circuited the same way.

import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import { resolveNodeInfo } from "./node-info.js";
import { sha256Buffer } from "./hash.js";
import { mimeFor } from "./engine.js";
import {
  assertSafeRelativePath,
  buildRemotePath,
  RemotePathError,
  type Section,
} from "./remote-path.js";
import { FileContentError } from "./file-content.js";

const SECTIONS = ["wip", "outputs", "resources"] as const;

// Editable = text-ish. Unknown extension (null mime) is treated as text so
// .mdx/.yaml/.toml open; known binary types are rejected. Mirrors the
// isEditableMime in file-content.ts (kept in sync deliberately).
function isEditableMime(mime: string | null): boolean {
  if (mime === null) return true;
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json") return true;
  return false;
}

interface ParsedRelPath {
  section: Section;
  subpath: string | null;
  filename: string;
}

// A mirror-relative path is "<section>/<...subpath>/<filename>". Validate it
// the same way the remote-path builder does, then split it into the pieces
// buildRemotePath needs.
function parseRelPath(relPath: string): ParsedRelPath {
  try {
    assertSafeRelativePath(relPath, "file-content-remote.relPath");
  } catch (e) {
    if (e instanceof RemotePathError) {
      throw new FileContentError(`invalid path: ${relPath}`, "INVALID_PATH");
    }
    throw e;
  }
  const segments = relPath.split("/");
  const section = segments[0] as Section;
  if (!SECTIONS.includes(section)) {
    throw new FileContentError(`invalid section in path: ${relPath}`, "INVALID_PATH");
  }
  if (segments.length < 2) {
    throw new FileContentError(`path has no filename: ${relPath}`, "INVALID_PATH");
  }
  const filename = segments[segments.length - 1];
  const middle = segments.slice(1, -1);
  return { section, subpath: middle.length === 0 ? null : middle.join("/"), filename };
}

interface RemoteTarget {
  remoteName: string;
  remotePath: string;
  filename: string;
}

async function resolveRemoteTarget(
  db: Client,
  nodeId: string,
  relPath: string,
): Promise<RemoteTarget> {
  const info = await resolveNodeInfo(db, nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) {
    throw new FileContentError(
      `no remote routed for node ${nodeId} (type=${info.nodeType}, org=${info.orgSyncKey ?? "null"})`,
      "NO_REMOTE",
    );
  }
  const { section, subpath, filename } = parseRelPath(relPath);
  let remotePath: string;
  try {
    remotePath = buildRemotePath({ ...info, section, subpath, filename });
  } catch (e) {
    if (e instanceof RemotePathError) {
      throw new FileContentError(`invalid path: ${relPath}`, "INVALID_PATH");
    }
    throw e;
  }
  return { remoteName, remotePath, filename };
}

// Look up the tracked file record (graph plane) for a remote object, if any.
// Read works without a record (any remote object can be fetched), but the
// record carries the native-format flag and is what a write refreshes.
async function getFileRecord(
  db: Client,
  nodeId: string,
  remoteName: string,
  remotePath: string,
): Promise<{ id: string; isNative: boolean } | null> {
  const r = await db.execute({
    sql: `SELECT id, is_native_format FROM files
          WHERE node_id = ? AND remote_name = ? AND remote_path = ?`,
    args: [nodeId, remoteName, remotePath],
  });
  if (r.rows.length === 0) return null;
  return { id: r.rows[0].id as string, isNative: Number(r.rows[0].is_native_format) === 1 };
}

export async function readFileContentRemote(
  db: Client,
  a: { userId: string; nodeId: string; relPath: string },
): Promise<{
  content: string;
  version: string;
  filename: string;
  mime_type: string | null;
  local_path: string | null;
}> {
  const { remoteName, remotePath, filename } = await resolveRemoteTarget(db, a.nodeId, a.relPath);
  const mime = mimeFor(filename);

  const record = await getFileRecord(db, a.nodeId, remoteName, remotePath);
  if (record?.isNative) {
    throw new FileContentError(`file is a native format, not editable text: ${a.relPath}`, "NOT_EDITABLE");
  }
  if (!isEditableMime(mime)) {
    throw new FileContentError(`file is not editable text: ${a.relPath}`, "NOT_EDITABLE");
  }

  const adapter = await getAdapter(db, remoteName);
  // stat first: distinguishes "file absent" (NOT_FOUND) from adapter errors
  // and short-circuits a native object even when no DB record exists.
  const stat = await adapter.stat(remotePath);
  if (!stat) {
    throw new FileContentError(`file not found: ${a.relPath}`, "NOT_FOUND");
  }
  if (stat.is_native_format) {
    throw new FileContentError(`file is a native format, not editable text: ${a.relPath}`, "NOT_EDITABLE");
  }

  const buf = await adapter.get(remotePath);
  if (buf.includes(0)) {
    throw new FileContentError(`file is not editable text: ${a.relPath}`, "NOT_EDITABLE");
  }
  return {
    content: buf.toString("utf8"),
    version: sha256Buffer(buf),
    filename,
    mime_type: mime,
    local_path: null,
  };
}

export async function writeFileContentRemote(
  db: Client,
  a: {
    userId: string;
    nodeId: string;
    relPath: string;
    content: string;
    baseVersion?: string;
    force?: boolean;
  },
): Promise<{ version: string }> {
  const { remoteName, remotePath, filename } = await resolveRemoteTarget(db, a.nodeId, a.relPath);
  const mime = mimeFor(filename);

  const record = await getFileRecord(db, a.nodeId, remoteName, remotePath);
  if (record?.isNative) {
    throw new FileContentError(`file is a native format, not editable text: ${a.relPath}`, "NOT_EDITABLE");
  }
  if (!isEditableMime(mime)) {
    throw new FileContentError(`file is not editable text: ${a.relPath}`, "NOT_EDITABLE");
  }

  const adapter = await getAdapter(db, remoteName);

  // Conflict check against the current REMOTE bytes. stat-gated so a genuine
  // adapter.get() failure is never silently treated as "no current bytes".
  if (a.baseVersion && !a.force) {
    const stat = await adapter.stat(remotePath);
    if (stat) {
      if (stat.is_native_format) {
        throw new FileContentError(`file is a native format, not editable text: ${a.relPath}`, "NOT_EDITABLE");
      }
      const current = await adapter.get(remotePath);
      const currentVersion = sha256Buffer(current);
      if (currentVersion !== a.baseVersion) {
        throw new FileContentError(
          "file changed on the remote since it was opened",
          "CONFLICT",
          currentVersion,
        );
      }
    }
  }

  const bytes = Buffer.from(a.content, "utf8");
  const ref = await adapter.put(remotePath, bytes, mime ? { mimeType: mime } : undefined);

  // Refresh the canonical hash on the file record so the graph plane matches
  // the bytes now on the remote. Use whatever the backend reports as its
  // canonical hash (Drive: md5, fs: sha256), falling back to sha256 of the
  // bytes -- the same selection storeFile makes.
  if (record) {
    const canonicalHash = ref.hash ? ref.hash.toLowerCase() : sha256Buffer(bytes);
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE files
            SET current_remote_hash = ?, last_pushed_by = ?, last_pushed_at = ?, updated_at = ?
            WHERE id = ?`,
      args: [canonicalHash, a.userId, now, now, record.id],
    });
  }

  return { version: sha256Buffer(bytes) };
}

// ---------------------------------------------------------------------------
// B3 -- adapter-direct lifecycle (create / rename / delete) over the server.
// ---------------------------------------------------------------------------

function assertSafeFilename(fn: string): void {
  if (!fn || fn.includes("/") || fn.includes("\\") || fn.includes("\0") || fn === "." || fn === "..") {
    throw new FileContentError(`invalid filename: ${fn}`, "INVALID_PATH");
  }
}

async function auditFile(
  db: Client,
  userId: string,
  action: string,
  fileId: string,
  detail: Record<string, unknown>,
  at: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, ?, 'file', ?, ?, ?)`,
    args: [ulid(), userId, action, fileId, JSON.stringify(detail), at],
  });
}

export interface CreateFileRemoteResult {
  id: string;
  filename: string;
  status: string;
  description: string | null;
  local_path: string | null;
  relative_path: string;
  remote_path: string;
  mime_type: string | null;
}

export async function createFileRemote(
  db: Client,
  a: {
    userId: string;
    nodeId: string;
    filename: string;
    section?: Section;
    subpath?: string | null;
    content?: string;
  },
): Promise<CreateFileRemoteResult> {
  assertSafeFilename(a.filename);
  const section: Section = a.section ?? "wip";
  if (!SECTIONS.includes(section)) {
    throw new FileContentError(`invalid section: ${section}`, "INVALID_PATH");
  }
  const subpath = a.subpath ? a.subpath : null;

  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) {
    throw new FileContentError(
      `no remote routed for node ${a.nodeId} (type=${info.nodeType}, org=${info.orgSyncKey ?? "null"})`,
      "NO_REMOTE",
    );
  }
  let remotePath: string;
  try {
    remotePath = buildRemotePath({ ...info, section, subpath, filename: a.filename });
  } catch (e) {
    if (e instanceof RemotePathError) {
      throw new FileContentError(`invalid path: ${a.filename}`, "INVALID_PATH");
    }
    throw e;
  }

  const adapter = await getAdapter(db, remoteName);
  // Refuse to clobber: an existing tracked record OR an object already on the
  // remote at this path means EXISTS (mirrors the local createFile guard).
  const existingRow = await db.execute({
    sql: "SELECT id FROM files WHERE node_id = ? AND remote_name = ? AND remote_path = ? LIMIT 1",
    args: [a.nodeId, remoteName, remotePath],
  });
  if (existingRow.rows.length > 0) {
    throw new FileContentError(`file already exists: ${a.filename}`, "EXISTS");
  }
  if (await adapter.stat(remotePath)) {
    throw new FileContentError(`file already exists: ${a.filename}`, "EXISTS");
  }

  const mt = mimeFor(a.filename);
  const bytes = Buffer.from(a.content ?? "", "utf8");
  const ref = await adapter.put(remotePath, bytes, mt ? { mimeType: mt } : undefined);
  const canonicalHash = ref.hash ? ref.hash.toLowerCase() : sha256Buffer(bytes);

  const id = ulid();
  const now = new Date().toISOString();
  const status = section === "outputs" ? "output" : "wip";
  // DO NOTHING + RETURNING: a concurrent create/store of the same path between
  // the pre-check and this INSERT degrades to EXISTS instead of a duplicate
  // row (idx_files_unique_remote).
  const inserted = await db.execute({
    sql: `INSERT INTO files (id, node_id, filename, status, description, mime_type,
                             remote_name, remote_path, current_remote_hash, is_native_format,
                             last_pushed_by, last_pushed_at, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(node_id, remote_name, remote_path) WHERE remote_path IS NOT NULL
          DO NOTHING
          RETURNING id`,
    args: [
      id,
      a.nodeId,
      a.filename,
      status,
      null,
      mt,
      remoteName,
      remotePath,
      canonicalHash,
      ref.is_native_format ? 1 : 0,
      a.userId,
      now,
      a.userId,
      now,
      now,
    ],
  });
  if (inserted.rows.length === 0) {
    throw new FileContentError(`file already exists: ${a.filename}`, "EXISTS");
  }

  await auditFile(db, a.userId, "sync_create_remote", id, { remote_name: remoteName, remote_path: remotePath, hash: canonicalHash }, now);

  const relative_path = subpath ? `${section}/${subpath}/${a.filename}` : `${section}/${a.filename}`;
  return {
    id,
    filename: a.filename,
    status,
    description: null,
    local_path: null,
    relative_path,
    remote_path: remotePath,
    mime_type: mt,
  };
}

export interface RenameFileRemoteResult {
  file_id: string;
  new_filename: string;
  new_remote_path: string;
  new_local_path: string | null;
  renamed_at: string;
  status: "ok";
}

export async function renameFileRemote(
  db: Client,
  a: { userId: string; nodeId?: string; fileId: string; newFilename: string },
): Promise<RenameFileRemoteResult> {
  const fn = a.newFilename;
  if (!fn || fn.includes("/") || fn.includes("\\") || fn.includes("\0") || fn === "." || fn === "..") {
    throw new Error(`Invalid filename: ${a.newFilename}`);
  }
  const r = await db.execute({
    sql: "SELECT id, filename, remote_name, remote_path FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (r.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = r.rows[0];
  const oldFilename = f.filename as string;
  const remoteName = f.remote_name as string | null;
  const oldRemotePath = f.remote_path as string | null;
  if (!remoteName || !oldRemotePath) throw new Error(`File ${a.fileId} has no remote binding`);
  if (!oldRemotePath.endsWith("/" + oldFilename) && oldRemotePath !== oldFilename) {
    throw new Error(`Remote path ${oldRemotePath} does not end with /${oldFilename}`);
  }
  const newRemotePath = oldRemotePath.slice(0, oldRemotePath.length - oldFilename.length) + fn;

  const adapter = await getAdapter(db, remoteName);
  await adapter.rename(oldRemotePath, newRemotePath);

  const now = new Date().toISOString();
  await db.execute({
    sql: "UPDATE files SET filename = ?, remote_path = ?, updated_at = ? WHERE id = ?",
    args: [fn, newRemotePath, now, a.fileId],
  });
  await auditFile(db, a.userId, "sync_rename_remote", a.fileId, {
    old_filename: oldFilename,
    new_filename: fn,
    old_remote_path: oldRemotePath,
    new_remote_path: newRemotePath,
  }, now);

  return {
    file_id: a.fileId,
    new_filename: fn,
    new_remote_path: newRemotePath,
    new_local_path: null,
    renamed_at: now,
    status: "ok",
  };
}

export interface DeleteFileRemotePreview {
  requires_confirmation: true;
  preview: {
    file_id: string;
    filename: string;
    mode: "complete";
    remote_name: string | null;
    remote_path: string | null;
    local_path: null;
    will_remove_from: string[];
  };
  next_call: string;
}

export interface DeleteFileRemoteSuccess {
  file_id: string;
  mode: "complete";
  deleted_at: string;
  status: "ok";
}

export interface DeleteFileRemoteRepairNeeded {
  file_id: string;
  mode: "complete";
  status: "repair_needed";
  detail: { phase: "remote"; remote_name: string; remote_path: string; error: string };
  repair_hint: string;
}

export async function deleteFileRemote(
  db: Client,
  a: { userId: string; nodeId?: string; fileId: string; mode?: "complete"; confirmed?: boolean },
): Promise<DeleteFileRemotePreview | DeleteFileRemoteSuccess | DeleteFileRemoteRepairNeeded> {
  const r = await db.execute({
    sql: "SELECT id, filename, remote_name, remote_path FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (r.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = r.rows[0];
  const filename = f.filename as string;
  const remoteName = f.remote_name as string | null;
  const remotePath = f.remote_path as string | null;

  if (!a.confirmed) {
    const willRemove: string[] = [];
    if (remoteName && remotePath) willRemove.push("remote");
    willRemove.push("portuni");
    return {
      requires_confirmation: true,
      preview: {
        file_id: a.fileId,
        filename,
        mode: "complete",
        remote_name: remoteName,
        remote_path: remotePath,
        local_path: null,
        will_remove_from: willRemove,
      },
      next_call: "DELETE /nodes/:id/files/:fileId?confirmed=true",
    };
  }

  const now = new Date().toISOString();
  if (remoteName && remotePath) {
    try {
      const adapter = await getAdapter(db, remoteName);
      await adapter.delete(remotePath);
    } catch (e) {
      // Remote delete failed: do NOT drop the DB row -- that would strand an
      // orphan on the remote with no Portuni record. Surface repair_needed.
      await auditFile(db, a.userId, "sync_delete_remote_repair_needed", a.fileId, {
        remote_name: remoteName,
        remote_path: remotePath,
        error: (e as Error).message,
      }, now);
      return {
        file_id: a.fileId,
        mode: "complete",
        status: "repair_needed",
        detail: { phase: "remote", remote_name: remoteName, remote_path: remotePath, error: (e as Error).message },
        repair_hint:
          "Remote delete failed; the Portuni record was kept intact. Verify the remote is reachable / authorized, then retry the delete.",
      };
    }
  }

  await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [a.fileId] });
  await auditFile(db, a.userId, "sync_delete_remote", a.fileId, {
    remote_name: remoteName,
    remote_path: remotePath,
    filename,
  }, now);

  return { file_id: a.fileId, mode: "complete", deleted_at: now, status: "ok" };
}
