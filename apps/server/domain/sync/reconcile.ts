// reconcilePath: bring the sync DB in line with a single path on disk. The
// mirror watcher calls this (debounced) for every filesystem event under a
// registered mirror, so file state stays correct without an agent calling
// portuni_store / portuni_status.
//
//   created   (no files row, file present, tracked section) -> registerLocalFile
//   modified  (files row, file present)                     -> re-hash cache
//   deleted   (files row, file gone)                        -> clear cache
//   ignored   (mirror-ignore match, or outside sections)    -> no-op
//
// Modify re-hashes via localHashFor, which refreshes
// file_state.cached_local_hash (preserving the synced baseline) so fast-mode
// statusScan -- what the UI reads -- classifies the file push. Delete clears
// the cached hash so the file no longer reports its stale last-known class.
//
// Scope matches discover-local.ts: only files inside the wip / outputs /
// resources sections, minus mirror-ignore, are eligible.

import { stat as fsStat, readFile } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "./mirror-registry.js";
import { resolveNodeInfo } from "./node-info.js";
import {
  buildNodeRoot,
  buildRemotePath,
  deriveLocalPath,
  subpathFromMirror,
  type NodeInfo,
  type Section,
} from "./remote-path.js";
import { loadMirrorIgnore } from "./mirror-ignore.js";
import { ulid } from "ulid";
import { registerLocalFile, localHashFor } from "./engine.js";
import { moveFile } from "./engine-mutations.js";
import { md5Buffer, sha256Buffer } from "./hash.js";
import {
  deleteFileState,
  findFileStateByInode,
  getFileState,
  upsertFileState,
} from "./local-db.js";

export type ReconcileAction =
  | "ignored"
  | "noop"
  | "registered"
  | "rehashed"
  | "deleted"
  | "unregistered"
  | "moved";

export interface ReconcileResult {
  action: ReconcileAction;
  file_id?: string;
}

async function statKind(path: string): Promise<{ exists: boolean; isFile: boolean }> {
  try {
    const st = await fsStat(path);
    return { exists: true, isFile: st.isFile() };
  } catch {
    return { exists: false, isFile: false };
  }
}

export async function reconcilePath(
  db: Client,
  a: { userId: string; nodeId: string; absPath: string },
): Promise<ReconcileResult> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) return { action: "noop" };

  const isIgnored = await loadMirrorIgnore(mirrorRoot);
  if (isIgnored(a.absPath)) return { action: "ignored" };

  // Only files inside a tracked section participate (matches discovery).
  const sub = subpathFromMirror(mirrorRoot, a.absPath);
  if (!sub) return { action: "ignored" };

  let info: NodeInfo;
  try {
    info = await resolveNodeInfo(db, a.nodeId);
  } catch {
    return { action: "noop" };
  }
  const remotePath = buildRemotePath({
    ...info,
    section: sub.section,
    subpath: sub.subpath?.normalize("NFC") ?? null,
    filename: sub.filename.normalize("NFC"),
  });

  const rowRes = await db.execute({
    sql: "SELECT id, current_remote_hash FROM files WHERE node_id = ? AND remote_path = ? LIMIT 1",
    args: [a.nodeId, remotePath],
  });
  const row = rowRes.rows.length > 0 ? rowRes.rows[0] : null;
  const fileId = row ? (row.id as string) : null;
  const { exists, isFile } = await statKind(a.absPath);

  if (!fileId) {
    // Register only an actual file that is present. A directory event (fs.watch
    // fires for new subdirs) or a create whose temp file already vanished is a
    // no-op. Upload is left to a deliberate sync.
    if (!exists || !isFile) return { action: "noop" };
    // On-disk mv detection MUST run here, at registration time: rename(2)
    // keeps the inode on the same volume, and the watcher registers the new
    // path immediately -- so pairing after the fact (the old
    // moveDetectionPhase) never saw an unregistered new path while the
    // watcher was running.
    const moved = await tryApplyDiskMove(db, a, sub);
    if (moved) return moved;
    const r = await registerLocalFile(db, {
      userId: a.userId,
      nodeId: a.nodeId,
      localPath: a.absPath,
    });
    return { action: "registered", file_id: r.file_id };
  }

  if (exists && isFile) {
    await localHashFor(
      a.absPath,
      fileId,
      (row!.current_remote_hash as string | null) ?? null,
    );
    return { action: "rehashed", file_id: fileId };
  }

  // Deleted on disk. Two cases, unified around one rule -- one user action,
  // one outcome:
  //   - never pushed (no remote copy, no synced baseline): the record was
  //     metadata-only, so deleting the file removes it from Portuni entirely
  //     (unregister). Leaving it produced the confusing "orphan" state, and
  //     for an mv it blocked the create-side pairing (no hash to verify).
  //   - pushed: keep the record, drop the cached hash so fast-mode reports
  //     deleted_local; the remote copy is intentionally preserved.
  const existing = await getFileState(fileId);
  const neverPushed =
    ((row!.current_remote_hash as string | null) ?? null) === null &&
    (existing?.last_synced_hash ?? null) === null;
  if (neverPushed) {
    await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [fileId] });
    await deleteFileState(fileId).catch(() => undefined);
    await db.execute({
      sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
            VALUES (?, ?, 'sync_unregister', 'file', ?, ?, ?)`,
      args: [
        ulid(),
        a.userId,
        fileId,
        JSON.stringify({ node_id: a.nodeId, remote_path: remotePath }),
        new Date().toISOString(),
      ],
    });
    return { action: "unregistered", file_id: fileId };
  }
  await upsertFileState({
    file_id: fileId,
    last_synced_hash: existing?.last_synced_hash ?? null,
    last_synced_at: existing?.last_synced_at ?? null,
    cached_local_hash: null,
    cached_mtime: null,
    cached_size: null,
    cached_ino: existing?.cached_ino ?? null,
    cached_dev: existing?.cached_dev ?? null,
  });
  return { action: "deleted", file_id: fileId };
}

// Pair a to-be-registered path with a tracked record whose local copy has the
// same inode identity -- an on-disk mv. Conditions (all required): a
// file_state row matches (ino, dev) and still has a files row; the record's
// derived local path differs from the new path and is gone from disk; the new
// path's content hash equals the record's last known local hash (guards
// against inode reuse after a delete and against pairing a copy). On a match
// the record is retargeted -- via moveFile (real adapter.rename, Drive file
// ID preserved) when the file was pushed, or a plain record update when it
// was never pushed (no remote object to move). Cross-volume mv changes the
// inode and falls through to plain registration by construction.
async function tryApplyDiskMove(
  db: Client,
  a: { userId: string; nodeId: string; absPath: string },
  sub: { section: Section; subpath: string | null; filename: string },
): Promise<ReconcileResult | null> {
  let st: { ino: number; dev: number };
  try {
    st = await fsStat(a.absPath);
  } catch {
    return null;
  }
  const candidates = await findFileStateByInode(st.ino, st.dev);
  for (const c of candidates) {
    const refHash = c.cached_local_hash ?? c.last_synced_hash;
    if (!refHash) continue;
    const rowRes = await db.execute({
      sql: "SELECT node_id, remote_path, current_remote_hash FROM files WHERE id = ?",
      args: [c.file_id],
    });
    if (rowRes.rows.length === 0) continue;
    const row = rowRes.rows[0];
    const oldNodeId = row.node_id as string;
    const remotePath = row.remote_path as string | null;
    if (!remotePath) continue;
    const oldMirror = await getMirrorPath(a.userId, oldNodeId);
    if (!oldMirror) continue;
    let oldLocal: string;
    try {
      oldLocal = deriveLocalPath({
        mirrorRoot: oldMirror,
        nodeRoot: buildNodeRoot(await resolveNodeInfo(db, oldNodeId)),
        remotePath,
      });
    } catch {
      continue;
    }
    if (oldLocal.normalize("NFC") === a.absPath.normalize("NFC")) continue;
    const oldStillThere = await fsStat(oldLocal).then(
      () => true,
      () => false,
    );
    if (oldStillThere) continue; // both paths exist: a copy, not a move
    const content = await readFile(a.absPath).catch(() => null);
    if (content === null) continue;
    const diskHash = refHash.length === 32 ? md5Buffer(content) : sha256Buffer(content);
    if (diskHash !== refHash) continue;

    const newSubpath = sub.subpath?.normalize("NFC") ?? null;
    const newFilename = sub.filename.normalize("NFC");
    if (((row.current_remote_hash as string | null) ?? null) === null) {
      // Never pushed: no remote object to move. Retarget the record only.
      const info = await resolveNodeInfo(db, a.nodeId);
      const newRemotePath = buildRemotePath({
        ...info,
        section: sub.section,
        subpath: newSubpath,
        filename: newFilename,
      });
      await db.execute({
        sql: "UPDATE files SET node_id = ?, remote_path = ?, filename = ?, updated_at = ? WHERE id = ?",
        args: [a.nodeId, newRemotePath, newFilename, new Date().toISOString(), c.file_id],
      });
      await localHashFor(a.absPath, c.file_id, null);
      return { action: "moved", file_id: c.file_id };
    }

    const r = await moveFile(db, {
      userId: a.userId,
      fileId: c.file_id,
      newNodeId: a.nodeId,
      newSection: sub.section,
      newSubpath,
      newFilename,
      confirmed: true,
    });
    if ("status" in r && r.status === "ok") {
      await localHashFor(a.absPath, c.file_id, null);
      return { action: "moved", file_id: c.file_id };
    }
    // repair_needed: moveFile already audited the partial state. Do NOT
    // register the new path as a duplicate record on top of it.
    return { action: "noop", file_id: c.file_id };
  }
  return null;
}
