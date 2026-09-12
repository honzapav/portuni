// The actual work of a deliberate sync run for one node: sweep the remote,
// scan, push/pull, adopt untracked files. Split out of api/nodes.ts's
// handleSyncRun (#273) so the same logic can run:
//   - synchronously, from that REST handler (unchanged contract, still used
//     directly by the MCP tool path via the REST call the desktop makes);
//   - as one node's unit of work inside a background sync job (sync-jobs.ts)
//     fanning out across many nodes with bounded concurrency, so
//     "Synchronizovat vše" is no longer a client-side blocking loop.
// Authorization (node visibility, the headless write gate) stays in the
// REST handler -- this function assumes the caller already checked it.
import type { Client } from "@libsql/client";
import {
  statusScan,
  storeFile,
  pullFile,
  matchDeleteTombstones,
  cleanupDeletedRemote,
} from "./engine.js";
import { listUntrackedLocal } from "./discover-local.js";
import { remoteSweep } from "./remote-sweep.js";
import { assertRemoteCapable } from "./types.js";
import type { SyncRunResponse } from "../../shared/api-types.js";

export async function runNodeSync(
  db: Client,
  a: { userId: string; nodeId: string },
): Promise<SyncRunResponse> {
  // A local workspace never has a remote (#310) -- there is nothing for a
  // sync run to sweep, push or pull. Fail fast, before touching the remote
  // sweep or a scan, rather than discovering it deep inside storeFile.
  assertRemoteCapable();
  // Sweep the remote before scanning: records whose remote object is
  // confirmed gone are dropped (their local copy is untracked afterward
  // and picked up by the tombstone cleanup below), and files that appeared
  // on the remote out of band are adopted so the scan classifies them as
  // pull candidates in this same run.
  const sweep = await remoteSweep(db, { userId: a.userId, nodeId: a.nodeId });
  const scan = await statusScan(db, {
    userId: a.userId,
    nodeId: a.nodeId,
    includeDiscovery: false,
  });
  const result: SyncRunResponse = {
    pushed: [],
    pulled: [],
    adopted: [],
    adopted_remote: [],
    conflicts: [],
    deleted_local: [],
    deleted_remote: [],
    deleted_on_remote: [],
    sweep_errors: [],
    repaired: [],
    pending_repairs: [],
    errors: [],
    skipped: [],
  };
  for (const f of sweep.adopted) {
    result.adopted_remote.push({ file_id: f.file_id, filename: f.filename });
  }
  for (const f of sweep.deleted_on_remote) {
    result.deleted_on_remote.push({ file_id: f.file_id, filename: f.filename });
  }
  result.sweep_errors.push(...sweep.errors);
  for (const r of sweep.repaired) {
    result.repaired.push({ file_id: r.file_id, filename: r.filename });
  }
  result.pending_repairs.push(...sweep.pending_repairs);
  for (const e of scan.push_candidates) {
    if (!e.local_path) {
      result.errors.push({
        file_id: e.file_id,
        filename: e.filename,
        error: "no local path -- node has no mirror on this device",
      });
      continue;
    }
    try {
      await storeFile(db, {
        userId: a.userId,
        nodeId: e.node_id,
        localPath: e.local_path,
      });
      result.pushed.push({ file_id: e.file_id, filename: e.filename });
    } catch (err) {
      result.errors.push({
        file_id: e.file_id,
        filename: e.filename,
        error: String(err),
      });
    }
  }
  // pull_candidates: remote moved forward, local at last-synced -- safe to
  // download. deleted_local is NOT pulled: the local deletion may be
  // intentional, and auto-restoring made it impossible to ever remove a
  // file from the mirror. It is reported for an explicit decision
  // (portuni_pull restores, portuni_delete_file removes everywhere).
  for (const e of scan.pull_candidates) {
    try {
      await pullFile(db, { userId: a.userId, fileId: e.file_id });
      result.pulled.push({ file_id: e.file_id, filename: e.filename });
    } catch (err) {
      result.errors.push({
        file_id: e.file_id,
        filename: e.filename,
        error: String(err),
      });
    }
  }
  for (const e of scan.deleted_local) {
    result.deleted_local.push({ file_id: e.file_id, filename: e.filename });
  }
  for (const e of scan.conflicts) {
    result.conflicts.push({ file_id: e.file_id, filename: e.filename });
  }
  for (const e of [...scan.clean, ...scan.remote_missing, ...scan.remote_error, ...scan.native]) {
    result.skipped.push({
      file_id: e.file_id,
      filename: e.filename,
      sync_class: e.class,
    });
  }
  // Deterministic registration: adopt any file the agent wrote to the
  // mirror but never registered. Each storeFile registers + pushes.
  // Tombstoned copies (deliberately deleted elsewhere, byte-identical to
  // the last synced state) are cleaned up instead of adopted -- adopting
  // them would resurrect the deletion (GH #79).
  const allUntracked = await listUntrackedLocal(db, { userId: a.userId, nodeId: a.nodeId });
  const tombMatch = await matchDeleteTombstones(db, a.userId, allUntracked);
  const cleanup = await cleanupDeletedRemote(tombMatch.deleted_remote);
  for (const c of cleanup.cleaned) {
    result.deleted_remote.push({ file_id: c.file_id, filename: c.filename });
  }
  result.errors.push(...cleanup.errors);
  const untracked = tombMatch.remaining;
  for (const u of untracked) {
    try {
      const sr = await storeFile(db, {
        userId: a.userId,
        nodeId: u.node_id,
        localPath: u.local_path,
      });
      result.adopted.push({ file_id: sr.file_id, filename: u.filename });
    } catch (err) {
      result.errors.push({ file_id: "", filename: u.filename, error: String(err) });
    }
  }
  return result;
}
