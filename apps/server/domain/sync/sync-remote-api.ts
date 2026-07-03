// Graph-plane surface for the central-mode sync agent (teammate mirrors).
//
// A teammate's sidecar keeps all disk/watcher/sync.db work local but has no
// Turso access, so the two graph-plane primitives the sync engine needs are
// exposed over REST by the central server:
//
//   getNodeSyncInfo        -> node identity + routed remote + file records
//                             (GET /nodes/:id/sync-info)
//   registerFileRecordRemote -> record-only registration of a local file
//                             (POST /nodes/:id/files/register); the files row
//                             keeps current_remote_hash NULL so statusScan
//                             classifies it `push` until a deliberate sync
//                             uploads the bytes (same contract as
//                             engine.ts registerLocalFile, minus the disk).
//
// Byte transfer itself goes through file-content-remote.ts (GET/PUT
// /nodes/:id/file with base64 for binary), so this module is metadata-only.

import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { resolveNodeInfo } from "./node-info.js";
import { resolveRemote } from "./routing.js";
import { mimeFor } from "./engine.js";
import { FileContentError } from "./file-content.js";
import { parseRelPath, buildRemotePathOrThrow } from "./file-content-remote.js";

export interface SyncInfoFile {
  id: string;
  filename: string;
  status: string;
  remote_path: string | null;
  current_remote_hash: string | null;
  is_native_format: boolean;
  mime_type: string | null;
}

export interface NodeSyncInfo {
  node: {
    id: string;
    type: string;
    sync_key: string;
    org_sync_key: string | null;
  };
  remote_name: string | null;
  files: SyncInfoFile[];
}

export async function getNodeSyncInfo(db: Client, nodeId: string): Promise<NodeSyncInfo> {
  // resolveNodeInfo throws on a missing node -- callers map that to 404.
  const info = await resolveNodeInfo(db, nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  const filesRes = await db.execute({
    sql: `SELECT id, filename, status, remote_path, current_remote_hash, is_native_format, mime_type
          FROM files WHERE node_id = ?`,
    args: [nodeId],
  });
  return {
    node: {
      id: nodeId,
      type: info.nodeType,
      sync_key: info.nodeSyncKey,
      org_sync_key: info.orgSyncKey,
    },
    remote_name: remoteName,
    files: filesRes.rows.map((r) => ({
      id: r.id as string,
      filename: r.filename as string,
      status: r.status as string,
      remote_path: (r.remote_path as string | null) ?? null,
      current_remote_hash: (r.current_remote_hash as string | null) ?? null,
      is_native_format: Number(r.is_native_format) === 1,
      mime_type: (r.mime_type as string | null) ?? null,
    })),
  };
}

export interface RegisterFileRecordResult {
  id: string;
  filename: string;
  remote_name: string;
  remote_path: string;
}

// Record-only registration: the agent found a new file in a local mirror and
// wants it tracked before any upload. Mirrors registerLocalFile's upsert
// exactly: current_remote_hash + last_pushed_* stay NULL (pending upload);
// on conflict (already registered) the synced state is left untouched so a
// synced file is never demoted.
export async function registerFileRecordRemote(
  db: Client,
  a: { userId: string; nodeId: string; relPath: string },
): Promise<RegisterFileRecordResult> {
  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) {
    throw new FileContentError(
      `no remote routed for node ${a.nodeId} (type=${info.nodeType}, org=${info.orgSyncKey ?? "null"})`,
      "NO_REMOTE",
    );
  }
  const { section, subpath, filename } = parseRelPath(a.relPath);
  const remotePath = buildRemotePathOrThrow(info, section, subpath, filename);

  const mt = mimeFor(filename);
  const status = section === "outputs" ? "output" : "wip";
  const now = new Date().toISOString();
  const upsert = await db.execute({
    sql: `INSERT INTO files (id, node_id, filename, status, description, mime_type,
                              remote_name, remote_path, current_remote_hash, last_pushed_by, last_pushed_at,
                              is_native_format, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)
          ON CONFLICT(node_id, remote_name, remote_path) WHERE remote_path IS NOT NULL
          DO UPDATE SET
            filename = excluded.filename,
            mime_type = excluded.mime_type,
            updated_at = excluded.updated_at
          RETURNING id`,
    args: [ulid(), a.nodeId, filename, status, null, mt, remoteName, remotePath, a.userId, now, now],
  });
  const fileId = upsert.rows[0].id as string;

  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_register_remote', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      fileId,
      JSON.stringify({ remote_name: remoteName, remote_path: remotePath }),
      now,
    ],
  });

  return { id: fileId, filename, remote_name: remoteName, remote_path: remotePath };
}
