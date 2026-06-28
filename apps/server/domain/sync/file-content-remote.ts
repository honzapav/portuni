// Mirror-less, Drive-direct file content (Phase B, B1+B2).
//
// The local readFileContent/writeFileContent (file-content.ts) resolve a
// mirror folder on disk. A central-mode teammate -- and the VPS that brokers
// for them -- has no mirror, so this module talks to the routed remote
// adapter directly: resolve node -> remote + remote path -> adapter.get/put.
//
// Optimistic concurrency is kept identical to the local path: `version` is the
// sha256 of the bytes, and a stale `baseVersion` raises FileContentError
// CONFLICT with `currentVersion`. The conflict check compares against the
// CURRENT REMOTE bytes (there is no per-device sync.db here). After a write
// the Turso file record's canonical hash is refreshed so the graph plane stays
// consistent with the bytes on the remote.
//
// Native formats (gdoc/gsheet/gslide) are not plain-text round-trippable:
// PUT is rejected with NOT_EDITABLE and reads are short-circuited the same way.

import type { Client } from "@libsql/client";
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
): Promise<{ content: string; version: string; filename: string; mime_type: string | null }> {
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
