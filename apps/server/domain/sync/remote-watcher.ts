// Remote watcher (#338): the remote side of file state becomes maintained
// state. The mirror watcher keeps the LOCAL side of `files`/`file_state`
// current on every disk event; this is its counterpart on central, where the
// remote credentials live -- it observes the backend's own change feed
// (FileAdapter.changes, Drive only today) and applies exactly what a full
// remoteSweep would apply for the same file. Spec:
// docs/superpowers/specs/2026-09-12-remote-watcher-design.md.
//
// Rule 4 is the load-bearing one: there is no second classification path.
// Every write below goes through remote-sweep.ts's own extracted steps
// (adoptRemoteFiles / refreshRemoteHashes / deleteRemovedRecords), so one
// changed file and a whole-node sweep cannot disagree.
//
// Rule 2: registration only. The watcher never sends bytes anywhere -- a
// device with a mirror reads `pull` on its next status read (its scan
// classifies off files.current_remote_hash, which is exactly what this
// updates) and the bytes arrive through a deliberate sync, as today.

import type { DbClient } from "../../infra/db.js";
import { nowExpr } from "../../infra/sql.js";
import type { FileAdapter, RemoteChange } from "./types.js";
import { buildNodeRoot } from "./remote-path.js";
import { listRules, resolveRemoteFromRules } from "./routing.js";
import { withPathLock } from "./path-lock.js";
import { writeRelocatedRecord } from "./file-relocation.js";
import { ulid } from "ulid";
import {
  adoptRemoteFiles,
  adoptableSection,
  deleteRemovedRecords,
  findRecordByRemoteFileId,
  findRemoteRecord,
  needsHashRefresh,
  persistRemoteFileId,
  refreshRemoteHashes,
  remoteSweep,
  type RemoteRecordRow,
} from "./remote-sweep.js";
import type { SyncRunResponse } from "../../shared/api-types.js";

// --- Cursor storage (remote_cursors, migration 037) ----------------------

export interface RemoteCursorRow {
  cursor: string;
  updated_at: string;
}

export async function getRemoteCursor(db: DbClient, remoteName: string): Promise<RemoteCursorRow | null> {
  const r = await db.execute({
    sql: "SELECT cursor, updated_at FROM remote_cursors WHERE remote_name = ?",
    args: [remoteName],
  });
  if (r.rows.length === 0) return null;
  return { cursor: r.rows[0].cursor as string, updated_at: String(r.rows[0].updated_at) };
}

export async function setRemoteCursor(db: DbClient, remoteName: string, cursor: string): Promise<void> {
  const now = nowExpr(db.dialect);
  await db.execute({
    sql: `INSERT INTO remote_cursors (remote_name, cursor, updated_at)
          VALUES (?, ?, ${now})
          ON CONFLICT(remote_name) DO UPDATE SET
            cursor = excluded.cursor,
            updated_at = ${now}`,
    args: [remoteName, cursor],
  });
}

// --- Which nodes this remote holds ---------------------------------------

export interface WatchedNode {
  nodeId: string;
  nodeRoot: string;
}

// Every node routed to `remoteName`, with the remote path prefix its files
// live under. One query plus the in-memory routing rules, so a tick that
// finds changes costs one read, not one resolveRemote per node.
export async function watchedNodesForRemote(db: DbClient, remoteName: string): Promise<WatchedNode[]> {
  const rules = await listRules(db);
  const r = await db.execute(`
    SELECT n.id AS id, n.type AS type, n.sync_key AS sync_key, o.sync_key AS org_sync_key
    FROM nodes n
    LEFT JOIN edges e ON e.source_id = n.id AND e.relation = 'belongs_to'
    LEFT JOIN nodes o ON o.id = e.target_id AND o.type = 'organization'
  `);
  const out: WatchedNode[] = [];
  const seen = new Set<string>();
  for (const row of r.rows) {
    const nodeId = row.id as string;
    if (seen.has(nodeId)) continue; // a node with several belongs_to edges
    seen.add(nodeId);
    const nodeType = row.type as string;
    const nodeSyncKey = row.sync_key as string;
    const orgSyncKey =
      nodeType === "organization" ? nodeSyncKey : ((row.org_sync_key as string | null) ?? null);
    if (resolveRemoteFromRules(rules, nodeType, orgSyncKey) !== remoteName) continue;
    try {
      out.push({ nodeId, nodeRoot: buildNodeRoot({ orgSyncKey, nodeType, nodeSyncKey }) });
    } catch {
      // A node whose sync_key cannot form a safe path is not watchable;
      // buildNodeRoot is the same guard every other remote path goes
      // through, so skipping here matches what a sweep would do.
    }
  }
  return out;
}

// --- The reducer ----------------------------------------------------------

export type DropReason = "folder" | "no_path" | "out_of_root" | "out_of_section";

export type PlannedChange =
  | {
      kind: "upsert";
      nodeId: string;
      nodeRoot: string;
      path: string;
      hash: string | null;
      fileId: string | null;
    }
  | { kind: "remove"; nodeId: string; nodeRoot: string; path: string; fileId: string | null }
  // A hard delete: the backend forgot where the object was and reports only
  // its own id (#418). The record is found by files.remote_file_id, which is
  // also where its node and path come from.
  | { kind: "remove_by_id"; fileId: string };

export interface RemoteChangePlan {
  planned: PlannedChange[];
  dropped: Array<{ path: string | null; reason: DropReason }>;
  // Nodes whose subtree a folder change (rename/move) invalidated. Drive
  // reports one change for the folder and none for its children, whose
  // recorded paths are now stale -- so instead of dropping the change and
  // waiting out the 6 h sweep, the tick asks for a catch-up sweep of exactly
  // those nodes (#418).
  sweepNodeIds: string[];
}

// Pure: RemoteChange[] + the watched node roots -> the per-file operations
// to apply. Drops everything that is not a tracked file of a watched node:
// a folder (nothing to adopt -- its children arrive as their own changes), a
// hard delete Drive could not name a path for, a path outside every node
// root, and a path inside a node root but outside wip/outputs/resources.
//
// The last change for a path wins: a Drive changes page reports them
// chronologically, so replaying an earlier state over a later one would
// write a hash the remote no longer has.
export function planRemoteChanges(changes: RemoteChange[], nodes: WatchedNode[]): RemoteChangePlan {
  // Longest root first: an organization's root is a prefix of its children's
  // roots, and the child node owns its own files.
  const byDepth = [...nodes].sort((a, b) => b.nodeRoot.length - a.nodeRoot.length);
  const planned = new Map<string, PlannedChange>();
  const dropped: RemoteChangePlan["dropped"] = [];
  const sweepNodeIds = new Set<string>();
  const nodeFor = (path: string): WatchedNode | undefined =>
    byDepth.find((n) => path.startsWith(`${n.nodeRoot}/`));
  for (const c of changes) {
    if (c.kind === "upsert" && c.is_folder) {
      // A folder rename/move moves every file under it, and the feed
      // reports nothing for those children. The bounded catch-up sweep of
      // the owning node is what re-establishes their paths; a folder
      // outside any tracked section (or outside every node root) still has
      // nothing to do.
      const node = nodeFor(c.path);
      const section = node ? c.path.slice(node.nodeRoot.length + 1).split("/")[0] : null;
      if (node && (section === "wip" || section === "outputs" || section === "resources")) {
        sweepNodeIds.add(node.nodeId);
      } else {
        dropped.push({ path: c.path, reason: "folder" });
      }
      continue;
    }
    if (c.path === null) {
      // A hard delete: no path, but the backend's own file id is enough to
      // find the record (#418). Only a change carrying NEITHER is dropped.
      if (c.kind === "remove" && c.file_id) {
        planned.set(`id:${c.file_id}`, { kind: "remove_by_id", fileId: c.file_id });
      } else {
        dropped.push({ path: null, reason: "no_path" });
      }
      continue;
    }
    const path = c.path;
    const node = nodeFor(path);
    if (!node) {
      dropped.push({ path, reason: "out_of_root" });
      continue;
    }
    if (adoptableSection(node.nodeRoot, path) === null) {
      dropped.push({ path, reason: "out_of_section" });
      continue;
    }
    planned.set(
      path,
      c.kind === "upsert"
        ? {
            kind: "upsert",
            nodeId: node.nodeId,
            nodeRoot: node.nodeRoot,
            path,
            hash: c.hash,
            fileId: c.file_id ?? null,
          }
        : {
            kind: "remove",
            nodeId: node.nodeId,
            nodeRoot: node.nodeRoot,
            path,
            fileId: c.file_id ?? null,
          },
    );
  }
  return { planned: Array.from(planned.values()), dropped, sweepNodeIds: [...sweepNodeIds] };
}

export interface ApplyChangesResult {
  adopted: Array<{ file_id: string; remote_path: string }>;
  refreshed: Array<{ file_id: string; remote_path: string }>;
  deleted: Array<{ file_id: string; remote_path: string }>;
  // A record the feed proved had moved: same backend object id, new path
  // (#418). The row keeps its id, so a device that tracks it follows the
  // file instead of seeing a delete and an unrelated add.
  relocated: Array<{ file_id: string; from_remote_path: string; remote_path: string }>;
  errors: Array<{ remote_path: string; error: string }>;
}

// Apply a plan. Every write is serialized on the same key the adapter-direct
// central write path uses (`<remote>:<remote_path>`), so a watcher tick and a
// push of the same object cannot interleave their check-then-write.
//
// Idempotent by construction: an adopt of an already-tracked path is a
// no-op, a hash refresh writes the value the remote already reports, and a
// delete re-confirms with its own stat. That is what makes replaying a batch
// whose cursor was not persisted safe.
export async function applyRemoteChanges(
  db: DbClient,
  a: { userId: string; remoteName: string; adapter: FileAdapter; plan: PlannedChange[] },
): Promise<ApplyChangesResult> {
  const out: ApplyChangesResult = {
    adopted: [],
    refreshed: [],
    deleted: [],
    relocated: [],
    errors: [],
  };
  for (const change of a.plan) {
    if (change.kind === "remove_by_id") {
      await applyRemoveById(db, a, change.fileId, out);
      continue;
    }
    await withPathLock(`${a.remoteName}:${change.path}`, async () => {
      try {
        const record = await findRemoteRecord(db, {
          nodeId: change.nodeId,
          remoteName: a.remoteName,
          remotePath: change.path,
        });
        if (change.kind === "remove") {
          // No record at this path: the same object may already sit
          // somewhere else (a relocation this batch, or an earlier one
          // applied), and its id still finds it (#418).
          const target =
            record ??
            (change.fileId
              ? await findRecordByRemoteFileId(db, {
                  remoteName: a.remoteName,
                  remoteFileId: change.fileId,
                })
              : null);
          // No record, or a record that never had a remote object: nothing
          // to tombstone.
          if (!target) return;
          const hadObject = target.current_remote_hash !== null || target.is_native_format === 1;
          if (!hadObject) return;
          const res = await deleteRemovedRecords(db, {
            userId: a.userId,
            // The record found by id may sit under a different node than the
            // path suggested; the tombstone has to name the node that
            // actually holds it, or no device will match it.
            nodeId: ("node_id" in target ? (target.node_id as string) : change.nodeId),
            remoteName: a.remoteName,
            adapter: a.adapter,
            candidates: [target],
          });
          out.deleted.push(...res.deleted.map((f) => ({ file_id: f.file_id, remote_path: f.remote_path })));
          out.errors.push(...res.errors);
          return;
        }
        if (!record) {
          // Same backend object, different path: a rename or a move, not a
          // new file (#418). Relocate the record the way moveFile does --
          // the row keeps its id, so every device follows the file instead
          // of seeing a delete here and an unrelated add there, hours apart.
          const moved = change.fileId
            ? await findRecordByRemoteFileId(db, {
                remoteName: a.remoteName,
                remoteFileId: change.fileId,
              })
            : null;
          if (moved && moved.remote_path !== change.path) {
            await relocateWatchedRecord(db, {
              userId: a.userId,
              remoteName: a.remoteName,
              nodeId: change.nodeId,
              newRemotePath: change.path,
              record: moved,
            });
            out.relocated.push({
              file_id: moved.id,
              from_remote_path: moved.remote_path,
              remote_path: change.path,
            });
            // The relocated row's recorded hash belongs to the object at its
            // old path -- which is the same object, so it is still correct
            // unless the change also reports a new one.
            if (needsHashRefresh({ ...moved, current_remote_hash: moved.current_remote_hash }, change.hash)) {
              const res = await refreshOne(db, a.adapter, moved.id, change.path, change.hash);
              if (res.error) out.errors.push({ remote_path: change.path, error: res.error });
              else if (res.hash) out.refreshed.push({ file_id: moved.id, remote_path: change.path });
            }
            return;
          }
          // Rule 4 again, and the one place it is not free: a full sweep
          // classifies an adopt off the backend's own listing entry, where
          // Drive derives is_native_format from the mime type. RemoteChange
          // carries no mime field, so a ref synthesised from the change
          // alone would read every Drive-native Doc/Sheet/Slide as an
          // ordinary binary -- a native object has no md5Checksum, so the
          // adopt's hash backfill fetches bytes Drive refuses to serve
          // (403 Only files with binary content can be downloaded), the
          // batch reports an error and the cursor is never persisted again
          // (#416). One stat per genuinely new file buys the sweep's own
          // answer; a hash refresh and a remove are untouched.
          const ref = await a.adapter.stat(change.path);
          // Created and gone again before this tick could look: nothing to
          // adopt, exactly as a listing that no longer shows it. Its own
          // remove change, if the feed reports one, finds no record and is
          // a no-op too.
          if (!ref) return;
          const res = await adoptRemoteFiles(db, {
            userId: a.userId,
            nodeId: change.nodeId,
            nodeRoot: change.nodeRoot,
            adapter: a.adapter,
            refs: [{ ...ref, remote_file_id: ref.remote_file_id ?? change.fileId }],
          });
          out.adopted.push(...res.adopted.map((f) => ({ file_id: f.file_id, remote_path: f.remote_path })));
          out.errors.push(...res.errors);
          return;
        }
        // The change proves which backend object this record is, even when
        // its hash needs nothing done (#418).
        await persistRemoteFileId(db, record.id, change.fileId);
        if (!needsHashRefresh(record, change.hash)) return;
        const res = await refreshOne(db, a.adapter, record.id, record.remote_path, change.hash);
        if (res.error) out.errors.push({ remote_path: record.remote_path, error: res.error });
        else if (res.hash) out.refreshed.push({ file_id: record.id, remote_path: record.remote_path });
      } catch (e) {
        out.errors.push({ remote_path: change.path, error: (e as Error).message });
      }
    });
  }
  return out;
}

// A hard delete carries the backend's file id and nothing else, so the
// record is found by id and confirmed at whatever path it currently records
// -- the same confirmed delete + tombstone a full sweep would apply (#418).
async function applyRemoveById(
  db: DbClient,
  a: { userId: string; remoteName: string; adapter: FileAdapter },
  remoteFileId: string,
  out: ApplyChangesResult,
): Promise<void> {
  let record: (RemoteRecordRow & { node_id: string }) | null = null;
  try {
    record = await findRecordByRemoteFileId(db, { remoteName: a.remoteName, remoteFileId });
  } catch (e) {
    out.errors.push({ remote_path: `id:${remoteFileId}`, error: (e as Error).message });
    return;
  }
  // Nothing tracks this object (never adopted, or already gone).
  if (!record) return;
  const target = record;
  await withPathLock(`${a.remoteName}:${target.remote_path}`, async () => {
    try {
      const hadObject = target.current_remote_hash !== null || target.is_native_format === 1;
      if (!hadObject) return;
      const res = await deleteRemovedRecords(db, {
        userId: a.userId,
        nodeId: target.node_id,
        remoteName: a.remoteName,
        adapter: a.adapter,
        candidates: [target],
      });
      out.deleted.push(...res.deleted.map((f) => ({ file_id: f.file_id, remote_path: f.remote_path })));
      out.errors.push(...res.errors);
    } catch (e) {
      out.errors.push({ remote_path: target.remote_path, error: (e as Error).message });
    }
  });
}

// Move the record to the path the feed reports, the same way moveFile does:
// writeRelocatedRecord (which folds a colliding shadow row instead of
// raising a raw UNIQUE error) plus a `sync_move` tombstone, which is what
// tells a device to drop its stale local copy at the old path instead of
// re-adopting and pushing it back (#418).
async function relocateWatchedRecord(
  db: DbClient,
  a: {
    userId: string;
    remoteName: string;
    nodeId: string;
    newRemotePath: string;
    record: RemoteRecordRow & { node_id: string };
  },
): Promise<void> {
  const now = new Date().toISOString();
  const filename = a.newRemotePath.split("/").pop() ?? a.record.filename;
  await writeRelocatedRecord(db, {
    fileId: a.record.id,
    nodeId: a.nodeId,
    newRemotePath: a.newRemotePath,
    updateSql:
      "UPDATE files SET remote_name = ?, remote_path = ?, node_id = ?, filename = ?, updated_at = ? WHERE id = ?",
    updateArgs: [a.remoteName, a.newRemotePath, a.nodeId, filename, now],
  });
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_move', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      a.record.id,
      JSON.stringify({
        // Same detail shape moveFile writes: matchDeleteTombstones reads
        // node_id + old_remote_path, and keeps the record alive (a move, not
        // a delete) when it matches a local copy at the old path.
        node_id: a.record.node_id,
        old_remote_path: a.record.remote_path,
        old: { remote_name: a.remoteName, remote_path: a.record.remote_path, local_path: null },
        new: { remote_name: a.remoteName, remote_path: a.newRemotePath, local_path: null },
        cross_node: a.record.node_id !== a.nodeId,
        cross_remote: false,
        reason: "remote_watcher",
      }),
      now,
    ],
  });
}

async function refreshOne(
  db: DbClient,
  adapter: FileAdapter,
  id: string,
  remotePath: string,
  listedHash: string | null,
): Promise<{ hash: string | null; error: string | null }> {
  const res = await refreshRemoteHashes(db, {
    adapter,
    candidates: [{ id, remote_path: remotePath, listed_hash: listedHash }],
  });
  if (res.errors.length > 0) return { hash: null, error: res.errors[0].error };
  return { hash: res.refreshed[0]?.hash ?? null, error: null };
}

// --- One tick -------------------------------------------------------------

export interface RemoteWatchTickResult {
  // Nodes a folder change asked a bounded catch-up sweep for (#418).
  swept_nodes?: string[];
  // The feed had no cursor yet: a start token was taken and a baseline full
  // sweep was requested. No changes were applied.
  baseline: boolean;
  // The cursor was rejected by the backend; a full sweep was requested and
  // the fresh token stored.
  reset: boolean;
  applied: ApplyChangesResult;
  // How many changes the reducer dropped as not-ours.
  dropped: number;
  cursor_persisted: boolean;
}

export interface RemoteWatchTickArgs {
  remoteName: string;
  userId: string;
  adapter: FileAdapter;
  // Runs the full catch-up sweep for the given nodes. Injected so the loop
  // can route it through sync-jobs.ts's worker pool (which is what keeps it
  // from overlapping a user-triggered job on the same node).
  fullSweep: (nodeIds: string[]) => Promise<void> | void;
  // Sweeps exactly the nodes a folder rename/move invalidated (#418). Same
  // worker pool, but it is NOT the periodic whole-workspace sweep, so the
  // loop must not record it as one. Defaults to fullSweep for a caller that
  // does not care about the distinction.
  sweepNodes?: (nodeIds: string[]) => Promise<void> | void;
}

export async function runRemoteWatchTick(
  db: DbClient,
  a: RemoteWatchTickArgs,
): Promise<RemoteWatchTickResult> {
  const empty: ApplyChangesResult = {
    adopted: [],
    refreshed: [],
    deleted: [],
    relocated: [],
    errors: [],
  };
  const stored = await getRemoteCursor(db, a.remoteName);
  if (stored === null) {
    const first = await a.adapter.changes!(null);
    await setRemoteCursor(db, a.remoteName, first.cursor);
    await a.fullSweep((await watchedNodesForRemote(db, a.remoteName)).map((n) => n.nodeId));
    return { baseline: true, reset: false, applied: empty, dropped: 0, cursor_persisted: true };
  }
  const res = await a.adapter.changes!(stored.cursor);
  if (res.reset) {
    // Nothing in `changes` is a complete account of what happened; the full
    // sweep is the only thing that can be trusted here.
    await setRemoteCursor(db, a.remoteName, res.cursor);
    await a.fullSweep((await watchedNodesForRemote(db, a.remoteName)).map((n) => n.nodeId));
    return { baseline: false, reset: true, applied: empty, dropped: 0, cursor_persisted: true };
  }
  if (res.changes.length === 0) {
    // An idle tick writes nothing at all -- not even the cursor, which the
    // backend hands back unchanged when there was nothing to report.
    const persisted = res.cursor !== stored.cursor;
    if (persisted) await setRemoteCursor(db, a.remoteName, res.cursor);
    return { baseline: false, reset: false, applied: empty, dropped: 0, cursor_persisted: persisted };
  }
  const nodes = await watchedNodesForRemote(db, a.remoteName);
  const plan = planRemoteChanges(res.changes, nodes);
  // A folder rename/move: the feed reports nothing for the children whose
  // recorded paths just went stale, so sweep exactly those nodes (#418).
  // Requested before the per-file work so an error in one does not swallow
  // the other; the sweep itself is serialized per node by the worker pool.
  if (plan.sweepNodeIds.length > 0) {
    await (a.sweepNodes ?? a.fullSweep)(plan.sweepNodeIds);
  }
  const applied = await applyRemoteChanges(db, {
    userId: a.userId,
    remoteName: a.remoteName,
    adapter: a.adapter,
    plan: plan.planned,
  });
  // Persist the cursor only once every change in the batch applied. A crash
  // or a failure mid-batch replays the whole batch on the next tick, and
  // every operation above is idempotent.
  const cursor_persisted = applied.errors.length === 0;
  if (cursor_persisted) await setRemoteCursor(db, a.remoteName, res.cursor);
  return {
    baseline: false,
    reset: false,
    applied,
    dropped: plan.dropped.length,
    cursor_persisted,
    swept_nodes: plan.sweepNodeIds,
  };
}

// --- Catch-up -------------------------------------------------------------

const EMPTY_RUN: Omit<SyncRunResponse, "adopted_remote" | "deleted_on_remote" | "sweep_errors"> = {
  pushed: [],
  pulled: [],
  adopted: [],
  conflicts: [],
  deleted_local: [],
  deleted_remote: [],
  repaired: [],
  pending_repairs: [],
  errors: [],
  skipped: [],
};

// One node of the catch-up sweep, shaped as a SyncRunResponse so it can run
// through sync-jobs.ts's worker pool unchanged. The watcher never pushes or
// pulls bytes (rule 2), so only the sweep's own buckets are ever non-empty.
export async function catchUpSweepNode(
  db: DbClient,
  a: { userId: string; nodeId: string },
): Promise<SyncRunResponse> {
  const sweep = await remoteSweep(db, a);
  return {
    ...EMPTY_RUN,
    repaired: sweep.repaired,
    pending_repairs: sweep.pending_repairs,
    adopted_remote: sweep.adopted.map((f) => ({ file_id: f.file_id, filename: f.filename })),
    deleted_on_remote: sweep.deleted_on_remote.map((f) => ({
      file_id: f.file_id,
      filename: f.filename,
    })),
    sweep_errors: sweep.errors,
  };
}
