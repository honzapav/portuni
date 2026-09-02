// Mirror-less, Drive-direct file content + lifecycle for central mode.
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
import { md5Buffer, sha256Buffer } from "./hash.js";
import { mimeFor } from "./engine.js";
import {
  assertSafeRelativePath,
  buildRemotePath,
  RemotePathError,
  type Section,
} from "./remote-path.js";
import { FileContentError } from "./file-content.js";
import { enqueuePendingOp, completePendingOp, failPendingOp } from "./pending-ops.js";

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

export interface ParsedRelPath {
  section: Section;
  subpath: string | null;
  filename: string;
}

// buildRemotePath with RemotePathError mapped to the FileContentError the
// HTTP layer knows how to render. Exported for sync-remote-api.ts.
export function buildRemotePathOrThrow(
  info: { orgSyncKey: string | null; nodeType: string; nodeSyncKey: string },
  section: Section,
  subpath: string | null,
  filename: string,
): string {
  try {
    return buildRemotePath({ ...info, section, subpath, filename });
  } catch (e) {
    if (e instanceof RemotePathError) {
      throw new FileContentError(`invalid path: ${section}/${filename}`, "INVALID_PATH");
    }
    throw e;
  }
}

// A mirror-relative path is "<section>/<...subpath>/<filename>". Validate it
// the same way the remote-path builder does, then split it into the pieces
// buildRemotePath needs. Exported for sync-remote-api.ts (agent-facing
// registration shares the exact same path contract).
export function parseRelPath(relPath: string): ParsedRelPath {
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
  remotePath: string,
): Promise<{ id: string; isNative: boolean; currentRemoteHash: string | null } | null> {
  // remote_name is not part of the lookup (#201): remote_path alone already
  // identifies "the same file" regardless of routing, so this also finds a
  // row registered locally (remote_name NULL) before this remote existed --
  // callers backfill remote_name onto it instead of missing it and risking
  // a second, colliding row.
  const r = await db.execute({
    sql: `SELECT id, is_native_format, current_remote_hash FROM files
          WHERE node_id = ? AND remote_path = ?`,
    args: [nodeId, remotePath],
  });
  if (r.rows.length === 0) return null;
  return {
    id: r.rows[0].id as string,
    isNative: Number(r.rows[0].is_native_format) === 1,
    currentRemoteHash: (r.rows[0].current_remote_hash as string | null) ?? null,
  };
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

  const record = await getFileRecord(db, a.nodeId, remotePath);
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

  const record = await getFileRecord(db, a.nodeId, remotePath);
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
  // bytes -- the same selection storeFile makes. remote_name is also
  // (re)written here (#201): getFileRecord's lookup no longer filters on it,
  // so `record` may be a row registered locally before this remote existed
  // (remote_name NULL) -- this backfills it, same as storeFile's upsert.
  if (record) {
    const canonicalHash = ref.hash ? ref.hash.toLowerCase() : sha256Buffer(bytes);
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE files
            SET remote_name = ?, current_remote_hash = ?, last_pushed_by = ?, last_pushed_at = ?, updated_at = ?
            WHERE id = ?`,
      args: [remoteName, canonicalHash, a.userId, now, now, record.id],
    });
  }

  return { version: sha256Buffer(bytes) };
}

// ---------------------------------------------------------------------------
// Byte-plane transfer for the central-mode sync agent (teammate mirrors).
//
// The text read/write above are editor-facing: utf8 only, NUL-guarded. A sync
// agent moves arbitrary mirror files (images, PDFs, archives), so these
// variants skip the text-editability checks and speak Buffers. Native
// formats stay NOT_EDITABLE -- they have no byte-level round-trip. Alongside
// `version` (sha256 of the bytes, the optimistic-concurrency token) they
// return `canonical_hash` -- whatever the backend reports as its identity
// hash (Drive: md5, fs: sha256). The agent stores canonical_hash as its
// synced baseline so fast statusScan (which compares against
// files.current_remote_hash) sees the file as clean.
// ---------------------------------------------------------------------------

export async function readFileBytesRemote(
  db: Client,
  a: { nodeId: string; relPath: string },
): Promise<{ bytes: Buffer; version: string; canonical_hash: string; filename: string; mime_type: string | null }> {
  const { remoteName, remotePath, filename } = await resolveRemoteTarget(db, a.nodeId, a.relPath);
  const record = await getFileRecord(db, a.nodeId, remotePath);
  if (record?.isNative) {
    throw new FileContentError(`file is a native format, no byte round-trip: ${a.relPath}`, "NOT_EDITABLE");
  }
  const adapter = await getAdapter(db, remoteName);

  // Fast path for tracked records (the sync agent's pull materialization):
  // the record already carries the native flag and the canonical-hash
  // algorithm, so skip the pre-flight adapter.stat and go straight to the
  // download -- one remote round-trip instead of two. The canonical hash is
  // recomputed from the DOWNLOADED bytes (never trusted from the record,
  // which may be stale), using the algorithm the record's hash length
  // implies (32 = md5 on Drive, else sha256).
  if (record?.currentRemoteHash) {
    let buf: Buffer;
    try {
      buf = await adapter.get(remotePath);
    } catch (e) {
      // Disambiguate a genuinely missing object from a transient adapter
      // failure with a single follow-up stat (error path only).
      const stat = await adapter.stat(remotePath).catch(() => null);
      if (!stat) {
        throw new FileContentError(`file not found: ${a.relPath}`, "NOT_FOUND");
      }
      throw e;
    }
    const canonical =
      record.currentRemoteHash.length === 32 ? md5Buffer(buf) : sha256Buffer(buf);
    return {
      bytes: buf,
      version: sha256Buffer(buf),
      canonical_hash: canonical,
      filename,
      mime_type: mimeFor(filename),
    };
  }

  const stat = await adapter.stat(remotePath);
  if (!stat) {
    throw new FileContentError(`file not found: ${a.relPath}`, "NOT_FOUND");
  }
  if (stat.is_native_format) {
    throw new FileContentError(`file is a native format, no byte round-trip: ${a.relPath}`, "NOT_EDITABLE");
  }
  const buf = await adapter.get(remotePath);
  return {
    bytes: buf,
    version: sha256Buffer(buf),
    canonical_hash: stat.hash ? stat.hash.toLowerCase() : sha256Buffer(buf),
    filename,
    mime_type: mimeFor(filename),
  };
}

export async function writeFileBytesRemote(
  db: Client,
  a: {
    userId: string;
    nodeId: string;
    relPath: string;
    bytes: Buffer;
    baseVersion?: string;
    // Canonical-hash precondition: the write proceeds only when the remote's
    // CURRENT canonical hash (adapter.stat -- metadata only, no download)
    // equals this value, or the remote object is absent. This is the sync
    // agent's conflict check: one stat instead of a full download.
    baseCanonicalHash?: string;
    // Create-only: refuse when the remote object already exists (EXISTS).
    // Lets the agent adopt/push brand-new files without a guaranteed-404
    // pre-flight GET while keeping clobber protection.
    ifAbsent?: boolean;
    force?: boolean;
  },
): Promise<{ version: string; canonical_hash: string }> {
  const { remoteName, remotePath, filename } = await resolveRemoteTarget(db, a.nodeId, a.relPath);
  const record = await getFileRecord(db, a.nodeId, remotePath);
  if (record?.isNative) {
    throw new FileContentError(`file is a native format, no byte round-trip: ${a.relPath}`, "NOT_EDITABLE");
  }
  const adapter = await getAdapter(db, remoteName);

  // Stat-only preconditions (sync agent path): no byte download needed.
  if ((a.ifAbsent || a.baseCanonicalHash) && !a.force) {
    const stat = await adapter.stat(remotePath);
    if (stat?.is_native_format) {
      throw new FileContentError(`file is a native format, no byte round-trip: ${a.relPath}`, "NOT_EDITABLE");
    }
    if (a.ifAbsent && stat) {
      throw new FileContentError(`file already exists on the remote: ${a.relPath}`, "EXISTS");
    }
    if (a.baseCanonicalHash && stat) {
      let current = stat.hash?.toLowerCase() ?? null;
      if (current === null) {
        // Backend reports no hash on stat (e.g. the fs adapter): fall back
        // to hashing the current bytes with the algorithm the base hash
        // implies. Drive reports md5 on stat, so its hot path stays
        // metadata-only.
        const bytes = await adapter.get(remotePath);
        current =
          a.baseCanonicalHash.length === 32 ? md5Buffer(bytes) : sha256Buffer(bytes);
      }
      if (current !== a.baseCanonicalHash.toLowerCase()) {
        throw new FileContentError(
          "file changed on the remote since the last sync",
          "CONFLICT",
          current,
        );
      }
    }
  }

  // Same conflict contract as the text write: baseVersion is the sha256 of
  // the remote bytes the writer last saw; stat-gated so an adapter failure
  // is never treated as "no current bytes".
  if (a.baseVersion && !a.force) {
    const stat = await adapter.stat(remotePath);
    if (stat) {
      if (stat.is_native_format) {
        throw new FileContentError(`file is a native format, no byte round-trip: ${a.relPath}`, "NOT_EDITABLE");
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

  const mime = mimeFor(filename);
  const ref = await adapter.put(remotePath, a.bytes, mime ? { mimeType: mime } : undefined);
  const canonicalHash = ref.hash ? ref.hash.toLowerCase() : sha256Buffer(a.bytes);

  if (record) {
    const now = new Date().toISOString();
    // remote_name backfill: see writeFileContentRemote's identical comment.
    await db.execute({
      sql: `UPDATE files
            SET remote_name = ?, current_remote_hash = ?, last_pushed_by = ?, last_pushed_at = ?, updated_at = ?
            WHERE id = ?`,
      args: [remoteName, canonicalHash, a.userId, now, now, record.id],
    });
  }

  return { version: sha256Buffer(a.bytes), canonical_hash: canonicalHash };
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
    // Text body (utf8). Mutually exclusive with `bytes`.
    content?: string;
    // Raw body for binary exports (snapshot PDF/DOCX). Mutually exclusive
    // with `content`.
    bytes?: Buffer;
    // Overrides the extension-derived MIME type (null = unknown).
    mimeType?: string | null;
  },
): Promise<CreateFileRemoteResult> {
  assertSafeFilename(a.filename);
  if (a.content !== undefined && a.bytes !== undefined) {
    throw new Error("createFileRemote: pass either content or bytes, not both");
  }
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
  // remote_name is not part of the lookup (#201): remote_path alone already
  // identifies "the same file" regardless of routing, so this also catches
  // a row registered locally before any remote was configured.
  const existingRow = await db.execute({
    sql: "SELECT id FROM files WHERE node_id = ? AND remote_path = ? LIMIT 1",
    args: [a.nodeId, remotePath],
  });
  if (existingRow.rows.length > 0) {
    throw new FileContentError(`file already exists: ${a.filename}`, "EXISTS");
  }
  if (await adapter.stat(remotePath)) {
    throw new FileContentError(`file already exists: ${a.filename}`, "EXISTS");
  }

  const mt = a.mimeType !== undefined ? a.mimeType : mimeFor(a.filename);
  const bytes = a.bytes ?? Buffer.from(a.content ?? "", "utf8");
  const ref = await adapter.put(remotePath, bytes, mt ? { mimeType: mt } : undefined);
  const canonicalHash = ref.hash ? ref.hash.toLowerCase() : sha256Buffer(bytes);

  const id = ulid();
  const now = new Date().toISOString();
  const status = section === "outputs" ? "output" : "wip";
  // DO NOTHING + RETURNING: a concurrent create/store of the same path between
  // the pre-check and this INSERT degrades to EXISTS instead of a duplicate
  // row (idx_files_unique_remote).
  const inserted = await db.execute({
    sql: `INSERT INTO files (id, node_id, filename, status, mime_type,
                             remote_name, remote_path, current_remote_hash, is_native_format,
                             last_pushed_by, last_pushed_at, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(node_id, remote_path) WHERE remote_path IS NOT NULL
          DO NOTHING
          RETURNING id`,
    args: [
      id,
      a.nodeId,
      a.filename,
      status,
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
    sql: "SELECT id, node_id, filename, remote_name, remote_path, current_remote_hash, is_native_format FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (r.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = r.rows[0];
  const nodeId = a.nodeId ?? (f.node_id as string);
  const filename = f.filename as string;
  const remoteName = f.remote_name as string | null;
  const remotePath = f.remote_path as string | null;
  // See deleteFile in engine-mutations.ts: the retry needs the target
  // object's identity to avoid deleting a different file that has since
  // taken this remote path.
  const expectedHash = (f.current_remote_hash as string | null) ?? null;
  const expectedRemoteObject = expectedHash !== null || Number(f.is_native_format) === 1;

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
  let pendingOpId: string | null = null;
  if (remoteName && remotePath) {
    pendingOpId = await enqueuePendingOp(db, {
      userId: a.userId,
      nodeId,
      fileId: a.fileId,
      payload: {
        op: "delete",
        remote_name: remoteName,
        remote_path: remotePath,
        filename,
        expected_hash: expectedHash,
        expected_remote_object: expectedRemoteObject,
      },
    });
    try {
      const adapter = await getAdapter(db, remoteName);
      // A registered-but-never-pushed record has a routed remote_path with
      // no object behind it -- deleting the nonexistent object would raise a
      // bogus repair_needed. stat first; skip when nothing is there.
      if ((await adapter.stat(remotePath)) !== null) {
        await adapter.delete(remotePath);
      }
    } catch (e) {
      // Remote delete failed: do NOT drop the DB row -- that would strand an
      // orphan on the remote with no Portuni record. Surface repair_needed.
      await failPendingOp(db, pendingOpId, (e as Error).message);
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
    node_id: nodeId,
    remote_name: remoteName,
    remote_path: remotePath,
    filename,
  }, now);
  if (pendingOpId) await completePendingOp(db, pendingOpId);

  return { file_id: a.fileId, mode: "complete", deleted_at: now, status: "ok" };
}
