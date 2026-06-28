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

import { stat as fsStat } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "./mirror-registry.js";
import { resolveNodeInfo } from "./node-info.js";
import { buildRemotePath, subpathFromMirror, type NodeInfo } from "./remote-path.js";
import { loadMirrorIgnore } from "./mirror-ignore.js";
import { registerLocalFile, localHashFor } from "./engine.js";
import { getFileState, upsertFileState } from "./local-db.js";

export type ReconcileAction =
  | "ignored"
  | "noop"
  | "registered"
  | "rehashed"
  | "deleted";

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

  // Deleted on disk: drop the cached hash (preserving the synced baseline) so
  // fast-mode reports deleted_local instead of a stale clean.
  const existing = await getFileState(fileId);
  await upsertFileState({
    file_id: fileId,
    last_synced_hash: existing?.last_synced_hash ?? null,
    last_synced_at: existing?.last_synced_at ?? null,
    cached_local_hash: null,
    cached_mtime: null,
    cached_size: null,
  });
  return { action: "deleted", file_id: fileId };
}
