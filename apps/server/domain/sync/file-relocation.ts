// Shared building blocks for the file-relocation family (moveFile,
// renameFolder in engine-mutations.ts; runMove in pending-ops.ts): moving
// or renaming an object on a remote, and writing the resulting path onto
// the `files` row without either raising a raw UNIQUE-constraint error or
// re-doing a remote step that already landed on a previous, interrupted
// attempt.

import type { Client, InArgs, InStatement } from "@libsql/client";
import { getAdapter } from "./adapter-cache.js";
import { getFileState, upsertFileState, deleteFileState } from "./local-db.js";

export interface RelocateParams {
  fromRemoteName: string;
  fromRemotePath: string;
  toRemoteName: string;
  toRemotePath: string;
}

export type RelocateStatus = "moved" | "already_at_target";

// Stat both sides before touching anything, so a retry after a partial
// failure (or a concurrent mover) never blindly repeats a step that
// already landed. Both present is refused as ambiguous -- the caller must
// surface that for a human, never guess which one is stale. Neither
// present is refused the same way (nothing to move, and NOT the same as
// "already done"). `onPhase` lets a cross-remote copy report which
// sub-step it reached before failing (copy vs. delete-source), same
// distinction moveFile's repair_hint already makes.
export async function relocateRemoteObject(
  db: Client,
  p: RelocateParams,
  onPhase?: (phase: "copy" | "delete_source") => void,
): Promise<{ status: RelocateStatus }> {
  // A no-op target (retrying a call whose desired end state already equals
  // its start state -- e.g. a rename retry landing after the row's own
  // remote_path already reads as the target) must never reach the stat
  // check below: source and destination would resolve to the SAME object,
  // so "both present" would fire as a false ambiguity error instead of the
  // trivially-safe no-op it actually is (#279 finding 9 follow-up).
  if (p.fromRemoteName === p.toRemoteName && p.fromRemotePath === p.toRemotePath) {
    return { status: "already_at_target" };
  }
  const src = await getAdapter(db, p.fromRemoteName);
  const dst = p.toRemoteName === p.fromRemoteName ? src : await getAdapter(db, p.toRemoteName);
  const [atFrom, atTo] = await Promise.all([src.stat(p.fromRemotePath), dst.stat(p.toRemotePath)]);
  if (atFrom && atTo) {
    throw new Error(`both ${p.fromRemotePath} and ${p.toRemotePath} exist on the remote`);
  }
  if (!atFrom && !atTo) {
    throw new Error(`neither ${p.fromRemotePath} nor ${p.toRemotePath} exists on the remote`);
  }
  if (!atFrom && atTo) {
    // Nothing left to do -- a previous attempt (or another device) already
    // got the object to the destination.
    return { status: "already_at_target" };
  }
  onPhase?.("copy");
  if (src === dst) {
    await src.rename(p.fromRemotePath, p.toRemotePath);
  } else {
    await dst.put(p.toRemotePath, await src.get(p.fromRemotePath));
    onPhase?.("delete_source");
    await src.delete(p.fromRemotePath);
  }
  return { status: "moved" };
}

// The watcher (or a concurrent register/adopt) can claim (node_id,
// remote_path) at the destination before a move/rename gets there --
// idx_files_unique_remote then rejects a plain UPDATE with a raw
// SQLITE_CONSTRAINT error. Merge instead of colliding: the row being
// relocated keeps its id (every caller already references it), the
// colliding "shadow" row is folded in and removed. Both statements run in
// one batch so the delete and the update land atomically.
async function mergeShadowFileState(shadowFileId: string, survivorFileId: string): Promise<void> {
  const [shadowState, survivorState] = await Promise.all([
    getFileState(shadowFileId),
    getFileState(survivorFileId),
  ]);
  if (shadowState) {
    // Keep the survivor's own sync baseline (it has real sync history the
    // shadow row -- typically a fresh watcher registration -- never had);
    // take the shadow's cache fields, since it was registered AFTER the
    // on-disk change and therefore describes the file as it is now.
    await upsertFileState({
      file_id: survivorFileId,
      last_synced_hash: survivorState?.last_synced_hash ?? null,
      last_synced_at: survivorState?.last_synced_at ?? null,
      cached_local_hash: shadowState.cached_local_hash,
      cached_mtime: shadowState.cached_mtime,
      cached_size: shadowState.cached_size,
      cached_ino: shadowState.cached_ino,
      cached_dev: shadowState.cached_dev,
    }).catch(() => undefined);
  }
  await deleteFileState(shadowFileId).catch(() => undefined);
}

export interface WriteRelocatedRecordArgs {
  fileId: string;
  // The destination identity to check for a collision -- the target
  // node_id and the new remote_path idx_files_unique_remote is keyed on.
  nodeId: string;
  newRemotePath: string;
  // Fully-formed "UPDATE files SET ... WHERE id = ?" text, with the `id`
  // placeholder last; callers keep authoring their own column list since
  // moveFile/runMove touch remote_name+node_id+filename while renameFolder
  // only ever touches remote_path.
  updateSql: string;
  updateArgs: unknown[];
}

// Returns the shadow row's id when a merge happened, else null.
export async function writeRelocatedRecord(
  db: Client,
  a: WriteRelocatedRecordArgs,
): Promise<{ mergedShadowFileId: string | null }> {
  const existing = await db.execute({
    sql: "SELECT id FROM files WHERE node_id = ? AND remote_path = ? AND id != ?",
    args: [a.nodeId, a.newRemotePath, a.fileId],
  });
  const shadowFileId = existing.rows.length > 0 ? (existing.rows[0].id as string) : null;
  const updateStmt: InStatement = {
    sql: a.updateSql,
    args: [...a.updateArgs, a.fileId] as InArgs,
  };
  if (shadowFileId) {
    await db.batch(
      [{ sql: "DELETE FROM files WHERE id = ?", args: [shadowFileId] }, updateStmt],
      "write",
    );
    await mergeShadowFileState(shadowFileId, a.fileId);
  } else {
    await db.execute(updateStmt);
  }
  return { mergedShadowFileId: shadowFileId };
}
