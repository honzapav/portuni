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
import type { FileAdapter, FileRef, RemoteChange } from "./types.js";
import { buildNodeRoot } from "./remote-path.js";
import { listRules, resolveRemoteFromRules } from "./routing.js";
import { withPathLock } from "./path-lock.js";
import {
  adoptRemoteFiles,
  adoptableSection,
  deleteRemovedRecords,
  findRemoteRecord,
  needsHashRefresh,
  refreshRemoteHashes,
  remoteSweep,
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
  | { kind: "upsert"; nodeId: string; nodeRoot: string; path: string; hash: string | null }
  | { kind: "remove"; nodeId: string; nodeRoot: string; path: string };

export interface RemoteChangePlan {
  planned: PlannedChange[];
  dropped: Array<{ path: string | null; reason: DropReason }>;
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
  for (const c of changes) {
    if (c.kind === "upsert" && c.is_folder) {
      dropped.push({ path: c.path, reason: "folder" });
      continue;
    }
    if (c.kind === "remove" && c.path === null) {
      dropped.push({ path: null, reason: "no_path" });
      continue;
    }
    const path = c.path as string;
    const node = byDepth.find((n) => path.startsWith(`${n.nodeRoot}/`));
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
        ? { kind: "upsert", nodeId: node.nodeId, nodeRoot: node.nodeRoot, path, hash: c.hash }
        : { kind: "remove", nodeId: node.nodeId, nodeRoot: node.nodeRoot, path },
    );
  }
  return { planned: Array.from(planned.values()), dropped };
}

export interface ApplyChangesResult {
  adopted: Array<{ file_id: string; remote_path: string }>;
  refreshed: Array<{ file_id: string; remote_path: string }>;
  deleted: Array<{ file_id: string; remote_path: string }>;
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
  const out: ApplyChangesResult = { adopted: [], refreshed: [], deleted: [], errors: [] };
  for (const change of a.plan) {
    await withPathLock(`${a.remoteName}:${change.path}`, async () => {
      try {
        const record = await findRemoteRecord(db, {
          nodeId: change.nodeId,
          remoteName: a.remoteName,
          remotePath: change.path,
        });
        if (change.kind === "remove") {
          // No record, or a record that never had a remote object: nothing
          // to tombstone.
          if (!record) return;
          const hadObject = record.current_remote_hash !== null || record.is_native_format === 1;
          if (!hadObject) return;
          const res = await deleteRemovedRecords(db, {
            userId: a.userId,
            nodeId: change.nodeId,
            remoteName: a.remoteName,
            adapter: a.adapter,
            candidates: [record],
          });
          out.deleted.push(...res.deleted.map((f) => ({ file_id: f.file_id, remote_path: f.remote_path })));
          out.errors.push(...res.errors);
          return;
        }
        if (!record) {
          // The change feed does not report a size, and nothing in the
          // adopt path reads one -- the hash and the native flag are what
          // adoptFiles takes from a ref.
          const ref: FileRef = {
            path: change.path,
            hash: change.hash,
            size: 0,
            modified_at: new Date(),
            is_native_format: false,
          };
          const res = await adoptRemoteFiles(db, {
            userId: a.userId,
            nodeId: change.nodeId,
            nodeRoot: change.nodeRoot,
            adapter: a.adapter,
            refs: [ref],
          });
          out.adopted.push(...res.adopted.map((f) => ({ file_id: f.file_id, remote_path: f.remote_path })));
          out.errors.push(...res.errors);
          return;
        }
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
}

export async function runRemoteWatchTick(
  db: DbClient,
  a: RemoteWatchTickArgs,
): Promise<RemoteWatchTickResult> {
  const empty: ApplyChangesResult = { adopted: [], refreshed: [], deleted: [], errors: [] };
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
