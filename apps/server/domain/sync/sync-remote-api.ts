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

export interface DeletedTombstone {
  file_id: string;
  remote_path: string;
}

export interface NodeSyncInfo {
  node: {
    id: string;
    name: string;
    type: string;
    sync_key: string;
    org_sync_key: string | null;
  };
  remote_name: string | null;
  files: SyncInfoFile[];
  // Recent deliberate deletions on this node. Devices match untracked disk
  // files against these during discovery (deleted_remote classification), so
  // a copy left behind on another device cannot resurrect the file. Only the
  // exact actions sync_delete / sync_delete_remote qualify — *_repair_needed
  // rows mean the remote copy still exists and must never trigger cleanup.
  deleted: DeletedTombstone[];
}

export async function getNodeSyncInfo(db: Client, nodeId: string): Promise<NodeSyncInfo> {
  // One JOIN gets the node row AND its belongs_to organization sync_key --
  // the same answer resolveNodeInfo assembles from two round-trips. The
  // agent hits this endpoint constantly (status polls, watcher, pending
  // aggregate), and the server has no embedded replica: every saved query
  // is a saved Turso network round-trip.
  const nodeRes = await db.execute({
    sql: `SELECT n.id, n.name, n.type, n.sync_key,
                 (SELECT o.sync_key FROM edges e
                  JOIN nodes o ON o.id = e.target_id AND o.type = 'organization'
                  WHERE e.source_id = n.id AND e.relation = 'belongs_to'
                  LIMIT 1) AS org_sync_key
          FROM nodes n WHERE n.id = ?`,
    args: [nodeId],
  });
  if (nodeRes.rows.length === 0) throw new Error(`Node ${nodeId} not found`);
  const row = nodeRes.rows[0];
  const nodeType = row.type as string;
  const nodeSyncKey = row.sync_key as string;
  const orgSyncKey =
    nodeType === "organization"
      ? nodeSyncKey
      : ((row.org_sync_key as string | null) ?? null);

  const remoteName = await resolveRemote(db, nodeType, orgSyncKey);
  const filesRes = await db.execute({
    sql: `SELECT id, filename, status, remote_path, current_remote_hash, is_native_format, mime_type
          FROM files WHERE node_id = ?`,
    args: [nodeId],
  });
  // Tombstones written before node_id landed in the audit detail never match
  // the filter — the mechanism only works for deletions from here on, which
  // is fine: old leftovers still surface as new_local for a human decision.
  const tombRes = await db.execute({
    sql: `SELECT target_id, json_extract(detail, '$.remote_path') AS remote_path
          FROM audit_log
          WHERE target_type = 'file'
            AND action IN ('sync_delete', 'sync_delete_remote')
            AND json_extract(detail, '$.node_id') = ?
          ORDER BY timestamp DESC LIMIT 200`,
    args: [nodeId],
  });
  return {
    node: {
      id: nodeId,
      name: (row.name as string | null) ?? nodeId,
      type: nodeType,
      sync_key: nodeSyncKey,
      org_sync_key: orgSyncKey,
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
    deleted: tombRes.rows
      .filter((r) => r.remote_path != null)
      .map((r) => ({
        file_id: r.target_id as string,
        remote_path: r.remote_path as string,
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
    sql: `INSERT INTO files (id, node_id, filename, status, mime_type,
                              remote_name, remote_path, current_remote_hash, last_pushed_by, last_pushed_at,
                              is_native_format, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)
          ON CONFLICT(node_id, remote_name, remote_path) WHERE remote_path IS NOT NULL
          DO UPDATE SET
            filename = excluded.filename,
            mime_type = excluded.mime_type,
            updated_at = excluded.updated_at
          RETURNING id`,
    args: [ulid(), a.nodeId, filename, status, mt, remoteName, remotePath, a.userId, now, now],
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

// Batch registration: one request + one db.batch for N files instead of N
// requests x ~5 queries. Used by the agent's boot backfill and sync-run
// adopt, where bulk imports (unzip, git checkout into a mirror) register
// dozens-to-hundreds of files at once. Same NULL-hash upsert semantics per
// file as registerFileRecordRemote; one audit row for the whole batch.
export async function registerFileRecordsRemote(
  db: Client,
  a: { userId: string; nodeId: string; relPaths: string[] },
): Promise<RegisterFileRecordResult[]> {
  if (a.relPaths.length === 0) return [];
  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) {
    throw new FileContentError(
      `no remote routed for node ${a.nodeId} (type=${info.nodeType}, org=${info.orgSyncKey ?? "null"})`,
      "NO_REMOTE",
    );
  }
  const now = new Date().toISOString();
  const parsed = a.relPaths.map((relPath) => {
    const { section, subpath, filename } = parseRelPath(relPath);
    return {
      filename,
      remotePath: buildRemotePathOrThrow(info, section, subpath, filename),
      status: section === "outputs" ? "output" : "wip",
      mt: mimeFor(filename),
    };
  });

  const upserts = await db.batch(
    parsed.map((p) => ({
      sql: `INSERT INTO files (id, node_id, filename, status, mime_type,
                                remote_name, remote_path, current_remote_hash, last_pushed_by, last_pushed_at,
                                is_native_format, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)
            ON CONFLICT(node_id, remote_name, remote_path) WHERE remote_path IS NOT NULL
            DO UPDATE SET
              filename = excluded.filename,
              mime_type = excluded.mime_type,
              updated_at = excluded.updated_at
            RETURNING id`,
      args: [ulid(), a.nodeId, p.filename, p.status, p.mt, remoteName, p.remotePath, a.userId, now, now],
    })),
  );

  const results: RegisterFileRecordResult[] = parsed.map((p, i) => ({
    id: upserts[i].rows[0].id as string,
    filename: p.filename,
    remote_name: remoteName,
    remote_path: p.remotePath,
  }));

  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_register_remote_batch', 'node', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      a.nodeId,
      JSON.stringify({ remote_name: remoteName, count: results.length, remote_paths: results.map((r) => r.remote_path).slice(0, 50) }),
      now,
    ],
  });

  return results;
}
