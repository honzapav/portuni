import { copyFile, mkdir, readFile, stat as fsStat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { sha256File, statForCache } from "./hash.js";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import { upsertFileState } from "./local-db.js";
import { getMirrorPath } from "./mirror-registry.js";
import {
  buildRemotePath,
  subpathFromMirror,
  type Section,
  type NodeInfo,
} from "./remote-path.js";

const WARN_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

function mimeFor(n: string): string | null {
  const d = n.lastIndexOf(".");
  return d < 0 ? null : (MIME[n.slice(d).toLowerCase()] ?? null);
}

export async function resolveNodeInfo(db: Client, nodeId: string): Promise<NodeInfo> {
  const r = await db.execute({
    sql: "SELECT type, sync_key FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (r.rows.length === 0) throw new Error(`Node ${nodeId} not found`);
  const type = r.rows[0].type as string;
  const syncKey = r.rows[0].sync_key as string;
  if (type === "organization") {
    return { orgSyncKey: syncKey, nodeType: type, nodeSyncKey: syncKey };
  }
  const org = await db.execute({
    sql: `SELECT n.sync_key FROM edges e JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? AND e.relation = 'belongs_to' AND n.type = 'organization' LIMIT 1`,
    args: [nodeId],
  });
  const orgSyncKey = org.rows.length > 0 ? (org.rows[0].sync_key as string) : null;
  return { orgSyncKey, nodeType: type, nodeSyncKey: syncKey };
}

export interface StoreFileArgs {
  userId: string;
  nodeId: string;
  localPath: string;
  description?: string | null;
  status?: "wip" | "output";
  subpath?: string | null;
}

export interface StoreFileResult {
  file_id: string;
  remote_name: string;
  remote_path: string;
  local_path: string;
  hash: string;
}

export async function storeFile(db: Client, a: StoreFileArgs): Promise<StoreFileResult> {
  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) {
    throw new Error(
      `No remote routing configured for node ${a.nodeId} (type=${info.nodeType}, org=${info.orgSyncKey ?? "null"})`,
    );
  }

  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) {
    throw new Error(
      `Node ${a.nodeId} has no local mirror. Register via portuni_mirror first.`,
    );
  }

  // Detect section + subpath + filename.
  let section: Section;
  let subpath: string | null = null;
  let filename: string;
  const inside = subpathFromMirror(mirrorRoot, a.localPath);
  if (inside !== null) {
    section = inside.section;
    subpath = inside.subpath;
    filename = inside.filename;
  } else {
    section = a.status === "output" ? "outputs" : "wip";
    subpath = a.subpath ?? null;
    filename = basename(a.localPath);
  }

  // Compute mirror destination.
  const mirroredAbs = join(mirrorRoot, section, ...(subpath ? [subpath] : []), filename);

  // If source file is not already at the mirror path, copy it in.
  const sourceStat = await fsStat(a.localPath);
  if (sourceStat.size > WARN_SIZE_BYTES) {
    console.warn(
      `[portuni:sync] file ${a.localPath} is ${(sourceStat.size / (1024 * 1024)).toFixed(1)}MB - large upload`,
    );
  }
  if (mirroredAbs !== a.localPath) {
    await mkdir(dirname(mirroredAbs), { recursive: true });
    await copyFile(a.localPath, mirroredAbs);
  }

  // Compute hash from the mirror copy (which is the canonical path).
  const hash = await sha256File(mirroredAbs);
  const content = await readFile(mirroredAbs);

  // Remote path.
  const remotePath = buildRemotePath({ ...info, section, subpath, filename });

  // Upload.
  const adapter = await getAdapter(db, remoteName);
  const mt = mimeFor(filename);
  await adapter.put(remotePath, content, mt ? { mimeType: mt } : undefined);

  // Post-upload verification.
  try {
    const stat = await adapter.stat(remotePath);
    if (stat && stat.hash && stat.hash !== hash) {
      throw new Error(
        `Post-upload hash verification failed: expected ${hash}, adapter reported ${stat.hash}`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Post-upload hash")) throw e;
    // Adapter may not support stat or may have transient failure - treat as soft warning.
  }

  // Upsert files row.
  const now = new Date().toISOString();
  const existing = await db.execute({
    sql: "SELECT id FROM files WHERE node_id = ? AND remote_name = ? AND remote_path = ? LIMIT 1",
    args: [a.nodeId, remoteName, remotePath],
  });
  let fileId: string;
  if (existing.rows.length > 0) {
    fileId = existing.rows[0].id as string;
    await db.execute({
      sql: `UPDATE files SET filename = ?, status = COALESCE(?, status), description = COALESCE(?, description),
                               remote_name = ?, remote_path = ?, current_remote_hash = ?,
                               last_pushed_by = ?, last_pushed_at = ?, mime_type = ?, local_path = ?,
                               updated_at = ?
                               WHERE id = ?`,
      args: [
        filename,
        a.status ?? null,
        a.description ?? null,
        remoteName,
        remotePath,
        hash,
        a.userId,
        now,
        mt,
        mirroredAbs,
        now,
        fileId,
      ],
    });
  } else {
    fileId = ulid();
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, local_path, status, description, mime_type,
                                remote_name, remote_path, current_remote_hash, last_pushed_by, last_pushed_at,
                                is_native_format, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      args: [
        fileId,
        a.nodeId,
        filename,
        mirroredAbs,
        a.status ?? "wip",
        a.description ?? null,
        mt,
        remoteName,
        remotePath,
        hash,
        a.userId,
        now,
        a.userId,
        now,
        now,
      ],
    });
  }

  // Audit.
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_store', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      fileId,
      JSON.stringify({ remote_name: remoteName, remote_path: remotePath, hash }),
      now,
    ],
  });

  // Local sync.db file_state.
  const fsInfo = await statForCache(mirroredAbs);
  await upsertFileState({
    file_id: fileId,
    last_synced_hash: hash,
    cached_local_hash: hash,
    cached_mtime: fsInfo.mtime,
    cached_size: fsInfo.size,
  });

  return {
    file_id: fileId,
    remote_name: remoteName,
    remote_path: remotePath,
    local_path: mirroredAbs,
    hash,
  };
}
