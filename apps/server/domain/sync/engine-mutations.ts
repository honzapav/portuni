// File-level mutations: moveFile, renameFolder, adoptFiles, deleteFile.
//
// All four are confirm-first or dry-run-first because they touch
// remote + local + DB and the failure modes are subtle. They return
// "repair_needed" results rather than throwing when partial state is left
// behind, so callers can surface useful guidance.
//
// Split off from engine.ts so the read paths (storeFile, pullFile,
// statusScan) stay in one focused file and the destructive operations
// live in another.

import { mkdir, rename as fsRename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client, InStatement } from "@libsql/client";
import type { FileRef } from "./types.js";
import { ulid } from "ulid";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import { deleteFileState } from "./local-db.js";
import { getMirrorPath } from "./mirror-registry.js";
import { enqueuePendingOp, completePendingOp, failPendingOp } from "./pending-ops.js";
import {
  buildNodeRoot,
  buildRemotePath,
  deriveLocalPath,
  assertSafeRelativePath,
  RemotePathError,
  type Section,
} from "./remote-path.js";
import { resolveNodeInfo } from "./node-info.js";

export type OpStatus = "ok" | "repair_needed";
export interface OpResult {
  status: OpStatus;
  detail: Record<string, unknown>;
  repair_hint?: string;
}

// --- moveFile ---

export interface MoveFileArgs {
  userId: string;
  fileId: string;
  newSubpath?: string | null;
  newSection?: Section;
  newNodeId?: string;
  // Rename as part of the move (one adapter.rename covers both). Used by the
  // watcher's on-disk mv detection, where the new path may carry a new name.
  newFilename?: string;
  confirmed?: boolean;
}

export interface MoveFilePreview {
  requires_confirmation: true;
  preview: {
    file_id: string;
    filename: string;
    old_remote_name: string;
    old_remote_path: string;
    new_remote_name: string;
    new_remote_path: string;
    old_local_path: string | null;
    new_local_path: string | null;
    cross_node: boolean;
    cross_remote: boolean;
  };
  next_call: string;
}

export interface MoveFileSuccess extends OpResult {
  file_id: string;
  new_remote_name: string;
  new_remote_path: string;
  new_local_path: string | null;
  moved_at: string;
}

// Section is the FIRST path segment after the node root
// (org/<type-plural>/<node-key>/<section>/... or org/<section>/... for
// organizations). A substring match would misread wip/sub/outputs/x as
// "outputs". Segment 1 is checked first: for non-org nodes it is the type
// plural (never a section name), so the check falls through to segment 3
// unambiguously.
function inferSectionFromPath(p: string): Section {
  const parts = p.split("/");
  for (const idx of [1, 3]) {
    const seg = parts[idx];
    if (seg === "outputs" || seg === "resources" || seg === "wip") {
      return seg;
    }
  }
  return "wip";
}

export async function moveFile(
  db: Client,
  a: MoveFileArgs,
): Promise<MoveFilePreview | MoveFileSuccess> {
  const row = await db.execute({
    sql: "SELECT id, node_id, filename, remote_name, remote_path FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (row.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const fr = row.rows[0];
  const oldRemoteName = fr.remote_name as string | null;
  const oldRemotePath = fr.remote_path as string | null;
  if (!oldRemoteName || !oldRemotePath) throw new Error(`File ${a.fileId} has no remote binding`);

  const targetNodeId = a.newNodeId ?? (fr.node_id as string);
  const newInfo = await resolveNodeInfo(db, targetNodeId);
  const newRemoteName = await resolveRemote(db, newInfo.nodeType, newInfo.orgSyncKey);
  if (!newRemoteName) throw new Error(`No remote for target node`);
  const filename = (a.newFilename ?? (fr.filename as string)).normalize("NFC");
  const newRemotePath = buildRemotePath({
    ...newInfo,
    section: a.newSection ?? inferSectionFromPath(oldRemotePath),
    subpath: a.newSubpath ?? null,
    filename,
  });

  const oldMirrorRoot = await getMirrorPath(a.userId, fr.node_id as string);
  const oldInfo = await resolveNodeInfo(db, fr.node_id as string);
  const oldLocalPath = oldMirrorRoot
    ? (() => {
        try {
          return deriveLocalPath({
            mirrorRoot: oldMirrorRoot,
            nodeRoot: buildNodeRoot(oldInfo),
            remotePath: oldRemotePath,
          });
        } catch {
          return null;
        }
      })()
    : null;
  const newMirrorRoot = await getMirrorPath(a.userId, targetNodeId);
  const newLocalPath = newMirrorRoot
    ? (() => {
        try {
          return deriveLocalPath({
            mirrorRoot: newMirrorRoot,
            nodeRoot: buildNodeRoot(newInfo),
            remotePath: newRemotePath,
          });
        } catch {
          return null;
        }
      })()
    : null;

  const crossNode = targetNodeId !== (fr.node_id as string);
  const crossRemote = newRemoteName !== oldRemoteName;

  if (!a.confirmed) {
    return {
      requires_confirmation: true,
      preview: {
        file_id: a.fileId,
        filename,
        old_remote_name: oldRemoteName,
        old_remote_path: oldRemotePath,
        new_remote_name: newRemoteName,
        new_remote_path: newRemotePath,
        old_local_path: oldLocalPath,
        new_local_path: newLocalPath,
        cross_node: crossNode,
        cross_remote: crossRemote,
      },
      next_call: "portuni_move_file with confirmed: true",
    };
  }

  // The remote object has already moved once step 1 succeeds, local outcome
  // notwithstanding -- another device (or this one, on retry) must not
  // adopt/push back the copy left at the old local path. Both the
  // local-phase-failure branch and the success branch call this with the
  // same detail shape (matchDeleteTombstones reads node_id/old_remote_path),
  // `extra` only carries the failure-branch's local_error.
  async function writeMoveTombstone(now: string, extra?: Record<string, unknown>): Promise<void> {
    await db.execute({
      sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
            VALUES (?, ?, 'sync_move', 'file', ?, ?, ?)`,
      args: [
        ulid(),
        a.userId,
        a.fileId,
        JSON.stringify({
          node_id: fr.node_id as string,
          old_remote_path: oldRemotePath,
          old: {
            remote_name: oldRemoteName,
            remote_path: oldRemotePath,
            local_path: oldLocalPath,
          },
          new: {
            remote_name: newRemoteName,
            remote_path: newRemotePath,
            local_path: newLocalPath,
          },
          cross_node: crossNode,
          cross_remote: crossRemote,
          ...extra,
        }),
        now,
      ],
    });
  }

  // Record the intent before the first side effect (Task 6): if the remote
  // step below throws, the op stays pending and the next sync run's retry
  // finishes it idempotently instead of leaving a silent half-move.
  const pendingOpId = await enqueuePendingOp(db, {
    userId: a.userId,
    nodeId: fr.node_id as string,
    fileId: a.fileId,
    payload: {
      op: "move",
      from_remote_name: oldRemoteName,
      from_remote_path: oldRemotePath,
      to_remote_name: newRemoteName,
      to_remote_path: newRemotePath,
      to_node_id: targetNodeId,
      filename,
    },
  });

  // Best-effort ordered execution.
  // 1. Remote move. Track which sub-step failed: in the cross-remote copy
  // the destination put can succeed before the source delete fails, and
  // then "No state changed" would be a lie -- the file exists on BOTH
  // remotes and the user must clean up the source copy.
  let remoteSubStep: "copy" | "delete_source" = "copy";
  try {
    if (!crossRemote) {
      const adapter = await getAdapter(db, oldRemoteName);
      await adapter.rename(oldRemotePath, newRemotePath);
    } else {
      const src = await getAdapter(db, oldRemoteName);
      const dst = await getAdapter(db, newRemoteName);
      const bytes = await src.get(oldRemotePath);
      await dst.put(newRemotePath, bytes);
      remoteSubStep = "delete_source";
      await src.delete(oldRemotePath);
    }
  } catch (e) {
    await failPendingOp(db, pendingOpId, (e as Error).message);
    const copied = remoteSubStep === "delete_source";
    return {
      status: "repair_needed",
      file_id: a.fileId,
      new_remote_name: newRemoteName,
      new_remote_path: newRemotePath,
      new_local_path: newLocalPath,
      moved_at: new Date().toISOString(),
      detail: {
        phase: "remote",
        sub_step: remoteSubStep,
        error: (e as Error).message,
        old_remote_path: oldRemotePath,
        new_remote_path: newRemotePath,
      },
      repair_hint: copied
        ? `The file was copied to ${newRemoteName}:${newRemotePath}, but deleting the source copy at ${oldRemoteName}:${oldRemotePath} failed. The DB still tracks the source. Delete the source copy manually (or retry), then re-run the move.`
        : "Remote move failed. No state changed. Retry the tool; if it still fails, inspect the remote manually.",
    };
  }

  // 2. Local move.
  let localDone = false;
  if (oldLocalPath && newLocalPath && oldLocalPath !== newLocalPath) {
    try {
      await mkdir(dirname(newLocalPath), { recursive: true });
      await fsRename(oldLocalPath, newLocalPath);
      localDone = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        // No local copy to move -- nothing was done locally; report that
        // honestly instead of pretending the move happened.
        localDone = false;
      } else {
        const now = new Date().toISOString();
        await db.execute({
          sql: `UPDATE files SET remote_name = ?, remote_path = ?, node_id = ?, filename = ?, updated_at = ? WHERE id = ?`,
          args: [newRemoteName, newRemotePath, targetNodeId, filename, now, a.fileId],
        });
        await db.execute({
          sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
                VALUES (?, ?, 'sync_move_partial', 'file', ?, ?, ?)`,
          args: [
            ulid(),
            a.userId,
            a.fileId,
            JSON.stringify({
              remote_ok: true,
              local_error: (e as Error).message,
              old_local_path: oldLocalPath,
              new_local_path: newLocalPath,
            }),
            now,
          ],
        });
        // Write the regular sync_move tombstone too, alongside
        // sync_move_partial, so matchDeleteTombstones picks it up.
        await writeMoveTombstone(now, { local_error: (e as Error).message });
        // The remote object and the DB row are both already at the new
        // location -- only the local copy is stale, and that is the
        // tombstone's job to clean up, not the retry's.
        await completePendingOp(db, pendingOpId);
        return {
          status: "repair_needed",
          file_id: a.fileId,
          new_remote_name: newRemoteName,
          new_remote_path: newRemotePath,
          new_local_path: newLocalPath,
          moved_at: now,
          detail: {
            phase: "local",
            remote_already_moved: true,
            error: (e as Error).message,
            old_local_path: oldLocalPath,
            new_local_path: newLocalPath,
          },
          repair_hint:
            "Remote is already at new path; local file could not be moved. Move or copy the local file manually, or run portuni_pull { file_id } to re-download.",
        };
      }
    }
  }

  // 3. DB update.
  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE files SET remote_name = ?, remote_path = ?, node_id = ?, filename = ?, updated_at = ? WHERE id = ?`,
    args: [newRemoteName, newRemotePath, targetNodeId, filename, now, a.fileId],
  });

  await writeMoveTombstone(now);
  await completePendingOp(db, pendingOpId);

  return {
    status: "ok",
    file_id: a.fileId,
    new_remote_name: newRemoteName,
    new_remote_path: newRemotePath,
    new_local_path: newLocalPath,
    moved_at: now,
    detail: { remote_done: true, local_done: localDone },
  };
}

// --- renameFolder ---

export interface RenameFolderArgs {
  userId: string;
  nodeId: string;
  oldPrefix: string;
  newPrefix: string;
  dryRun?: boolean;
}

export type RenameFolderResult =
  | {
      type: "preview";
      files: Array<{
        file_id: string;
        filename: string;
        old_remote_path: string;
        new_remote_path: string;
        old_local_path: string | null;
        new_local_path: string | null;
      }>;
    }
  | {
      type: "applied";
      renamed: number;
      failed: number;
      files: Array<{
        file_id: string;
        status: "ok" | "repair_needed";
        old_remote_path: string;
        new_remote_path: string;
        error?: string;
      }>;
    };

export async function renameFolder(
  db: Client,
  a: RenameFolderArgs,
): Promise<RenameFolderResult> {
  const info = await resolveNodeInfo(db, a.nodeId);
  const nodeRoot = buildNodeRoot(info);
  // Both prefixes are caller-supplied and end up concatenated into LIKE
  // queries plus path replacements — reject "../"/absolute segments here
  // so a malicious rename can't reach files outside this node subtree.
  assertSafeRelativePath(a.oldPrefix, "renameFolder.oldPrefix");
  assertSafeRelativePath(a.newPrefix, "renameFolder.newPrefix");
  const oldAbs = `${nodeRoot}/${a.oldPrefix}`;
  const newAbs = `${nodeRoot}/${a.newPrefix}`;
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);

  // Escape LIKE metacharacters in the prefix: "_" (common in folder names)
  // matches any single character, so wip/my_notes would also select
  // wip/myXnotes/... and "rename" those rows to themselves.
  const likePrefix = oldAbs.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const rows = await db.execute({
    sql: "SELECT id, filename, remote_name, remote_path FROM files WHERE node_id = ? AND remote_path LIKE ? ESCAPE '\\'",
    args: [a.nodeId, `${likePrefix}/%`],
  });
  const affected = rows.rows.map((r) => {
    const oldRemote = r.remote_path as string;
    const newRemote = `${newAbs}${oldRemote.slice(oldAbs.length)}`;
    return {
      file_id: r.id as string,
      filename: r.filename as string,
      remote_name: r.remote_name as string,
      old_remote_path: oldRemote,
      new_remote_path: newRemote,
      old_local_path: mirrorRoot
        ? (() => {
            try {
              return deriveLocalPath({ mirrorRoot, nodeRoot, remotePath: oldRemote });
            } catch {
              return null;
            }
          })()
        : null,
      new_local_path: mirrorRoot
        ? (() => {
            try {
              return deriveLocalPath({ mirrorRoot, nodeRoot, remotePath: newRemote });
            } catch {
              return null;
            }
          })()
        : null,
    };
  });

  if (a.dryRun !== false) {
    return {
      type: "preview",
      files: affected.map(
        ({ file_id, filename, old_remote_path, new_remote_path, old_local_path, new_local_path }) => ({
          file_id,
          filename,
          old_remote_path,
          new_remote_path,
          old_local_path,
          new_local_path,
        }),
      ),
    };
  }

  const results: Array<{
    file_id: string;
    status: "ok" | "repair_needed";
    old_remote_path: string;
    new_remote_path: string;
    error?: string;
  }> = [];
  const now = new Date().toISOString();

  // The remote object has already moved once adapter.rename succeeds, local
  // outcome notwithstanding -- another device (or this one, on a missed
  // watcher event) must not adopt/push back the copy left at the old local
  // path. One sync_rename tombstone per successfully-renamed file, matched
  // by matchDeleteTombstones same as sync_move.
  async function writeRenameTombstone(f: (typeof affected)[number]): Promise<void> {
    await db.execute({
      sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
            VALUES (?, ?, 'sync_rename', 'file', ?, ?, ?)`,
      args: [
        ulid(),
        a.userId,
        f.file_id,
        JSON.stringify({
          node_id: a.nodeId,
          old_remote_path: f.old_remote_path,
          new_remote_path: f.new_remote_path,
          via: "rename_folder",
        }),
        now,
      ],
    });
  }

  for (const f of affected) {
    const pendingOpId = await enqueuePendingOp(db, {
      userId: a.userId,
      nodeId: a.nodeId,
      fileId: f.file_id,
      payload: {
        op: "move",
        from_remote_name: f.remote_name,
        from_remote_path: f.old_remote_path,
        to_remote_name: f.remote_name,
        to_remote_path: f.new_remote_path,
        to_node_id: a.nodeId,
        filename: f.filename,
      },
    });
    try {
      const adapter = await getAdapter(db, f.remote_name);
      await adapter.rename(f.old_remote_path, f.new_remote_path);
      if (f.old_local_path && f.new_local_path) {
        try {
          await mkdir(dirname(f.new_local_path), { recursive: true });
          await fsRename(f.old_local_path, f.new_local_path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            await db.execute({
              sql: "UPDATE files SET remote_path = ?, updated_at = ? WHERE id = ?",
              args: [f.new_remote_path, now, f.file_id],
            });
            await writeRenameTombstone(f);
            await completePendingOp(db, pendingOpId);
            results.push({
              file_id: f.file_id,
              status: "repair_needed",
              old_remote_path: f.old_remote_path,
              new_remote_path: f.new_remote_path,
              error: `local: ${(e as Error).message}`,
            });
            continue;
          }
        }
      }
      await db.execute({
        sql: "UPDATE files SET remote_path = ?, updated_at = ? WHERE id = ?",
        args: [f.new_remote_path, now, f.file_id],
      });
      await writeRenameTombstone(f);
      await completePendingOp(db, pendingOpId);
      results.push({
        file_id: f.file_id,
        status: "ok",
        old_remote_path: f.old_remote_path,
        new_remote_path: f.new_remote_path,
      });
    } catch (e) {
      await failPendingOp(db, pendingOpId, (e as Error).message);
      results.push({
        file_id: f.file_id,
        status: "repair_needed",
        old_remote_path: f.old_remote_path,
        new_remote_path: f.new_remote_path,
        error: `remote: ${(e as Error).message}`,
      });
    }
  }

  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_rename_folder', 'node', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      a.nodeId,
      JSON.stringify({ old_prefix: a.oldPrefix, new_prefix: a.newPrefix, results }),
      now,
    ],
  });

  return {
    type: "applied",
    renamed: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "repair_needed").length,
    files: results,
  };
}

// --- adoptFiles (remote-only: register untracked remote paths) ---

export interface AdoptFilesArgs {
  userId: string;
  nodeId: string;
  paths: string[];
  status?: "wip" | "output";
  // Remote metadata the caller already has, keyed by remote path. remoteSweep
  // holds a full FileRef for every path it passes here -- it just came out of
  // the listing -- and without this adoptFiles re-fetched the same hash and
  // native flag with one adapter.stat() per file. On Drive that is an HTTPS
  // round trip each. A path absent from the map still gets stat()ed, so
  // callers with only paths (portuni_adopt_files) are unaffected.
  refs?: ReadonlyMap<string, FileRef>;
}

export interface AdoptFilesResult {
  adopted: Array<{
    file_id: string;
    remote_path: string;
    filename: string;
    hash: string | null;
  }>;
  skipped: Array<{ remote_path: string; reason: string }>;
}

export async function adoptFiles(
  db: Client,
  a: AdoptFilesArgs,
): Promise<AdoptFilesResult> {
  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) throw new Error(`No remote for node ${a.nodeId}`);
  const adapter = await getAdapter(db, remoteName);
  const nodeRoot = buildNodeRoot(info);
  const nodeRootPrefix = `${nodeRoot}/`;
  const adopted: AdoptFilesResult["adopted"] = [];
  const skipped: AdoptFilesResult["skipped"] = [];
  const auditRows: InStatement[] = [];
  for (const p of a.paths) {
    // Reject paths that would point outside the node's own subtree, or
    // that contain "../" / absolute / control segments. Without this an
    // adopted "remote_path" could later resolve to a local file outside
    // the mirror via deriveLocalPath.
    if (!p.startsWith(nodeRootPrefix)) {
      skipped.push({ remote_path: p, reason: `path is outside node root ${nodeRoot}` });
      continue;
    }
    try {
      assertSafeRelativePath(p.slice(nodeRootPrefix.length), "adoptFiles.path");
    } catch (e) {
      skipped.push({
        remote_path: p,
        reason: e instanceof RemotePathError ? e.message : "invalid path",
      });
      continue;
    }
    // No pre-check SELECT: the INSERT below is ON CONFLICT DO NOTHING
    // RETURNING, so an already-tracked path comes back with zero rows and
    // takes the same "already tracked" skip. The pre-check was one query per
    // file that could only ever agree with the insert -- and it keyed on
    // (node_id, remote_name, remote_path) while the unique index is on
    // (node_id, remote_path), so it actually missed a same-path row adopted
    // under a different remote and let the insert catch it anyway.
    const stat = a.refs?.get(p) ?? (await adapter.stat(p));
    if (!stat) {
      skipped.push({ remote_path: p, reason: "remote file not found" });
      continue;
    }
    const id = ulid();
    const now = new Date().toISOString();
    const filename = p.split("/").pop() ?? p;
    // DO NOTHING + RETURNING: a concurrent adopt/store of the same path
    // between the pre-check above and this INSERT degrades to a skip
    // instead of a duplicate row (idx_files_unique_remote).
    const inserted = await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, status, remote_name, remote_path, current_remote_hash, is_native_format, last_pushed_by, last_pushed_at, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(node_id, remote_path) WHERE remote_path IS NOT NULL
            DO NOTHING
            RETURNING id`,
      args: [
        id,
        a.nodeId,
        filename,
        a.status ?? "wip",
        remoteName,
        p,
        stat.hash,
        stat.is_native_format ? 1 : 0,
        a.userId,
        now,
        a.userId,
        now,
        now,
      ],
    });
    if (inserted.rows.length === 0) {
      skipped.push({ remote_path: p, reason: "already tracked" });
      continue;
    }
    auditRows.push({
      sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
            VALUES (?, ?, 'sync_adopt', 'file', ?, ?, ?)`,
      args: [
        ulid(),
        a.userId,
        id,
        JSON.stringify({ remote_name: remoteName, remote_path: p, hash: stat.hash }),
        now,
      ],
    });
    adopted.push({ file_id: id, remote_path: p, filename, hash: stat.hash });
  }
  // One batch instead of one round trip per adopted file. Written after the
  // inserts, so an audit row can only exist for a file row that landed.
  if (auditRows.length > 0) {
    for (let i = 0; i < auditRows.length; i += 100) {
      await db.batch(auditRows.slice(i, i + 100), "write");
    }
  }
  return { adopted, skipped };
}

// --- deleteFile (confirm-first; modes: complete | unregister_only) ---

export interface DeleteFileArgs {
  userId: string;
  fileId: string;
  mode?: "complete" | "unregister_only";
  confirmed?: boolean;
}

export interface DeleteFilePreview {
  requires_confirmation: true;
  preview: {
    file_id: string;
    filename: string;
    mode: "complete" | "unregister_only";
    remote_name: string | null;
    remote_path: string | null;
    local_path: string | null;
    will_remove_from: string[];
  };
  next_call: string;
}

export interface DeleteFileSuccess {
  file_id: string;
  mode: "complete" | "unregister_only";
  deleted_at: string;
  status: "ok";
}

export interface DeleteFileRepairNeeded {
  file_id: string;
  mode: "complete";
  status: "repair_needed";
  detail: {
    phase: "remote";
    remote_name: string;
    remote_path: string;
    error: string;
  };
  repair_hint: string;
}

export async function deleteFile(
  db: Client,
  a: DeleteFileArgs,
): Promise<DeleteFilePreview | DeleteFileSuccess | DeleteFileRepairNeeded> {
  const r = await db.execute({
    sql: "SELECT id, node_id, filename, remote_name, remote_path, current_remote_hash, is_native_format FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (r.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = r.rows[0];
  const mode = a.mode ?? "complete";
  const nodeId = f.node_id as string;
  const remoteName = f.remote_name as string | null;
  const remotePath = f.remote_path as string | null;
  const filename = f.filename as string;
  // Identity of the object being deleted, so a retry of a half-finished
  // delete can tell it apart from a different file that has since taken
  // the same remote path (see runDelete in pending-ops.ts).
  const expectedHash = (f.current_remote_hash as string | null) ?? null;
  const expectedRemoteObject = expectedHash !== null || Number(f.is_native_format) === 1;

  let localPath: string | null = null;
  const mirror = await getMirrorPath(a.userId, nodeId);
  if (mirror && remotePath) {
    try {
      const info = await resolveNodeInfo(db, nodeId);
      localPath = deriveLocalPath({
        mirrorRoot: mirror,
        nodeRoot: buildNodeRoot(info),
        remotePath,
      });
    } catch {
      localPath = null;
    }
  }

  if (!a.confirmed) {
    const willRemove: string[] = [];
    if (mode === "complete") {
      if (remoteName && remotePath) willRemove.push("remote");
      if (localPath) willRemove.push("local");
    }
    willRemove.push("portuni");
    return {
      requires_confirmation: true,
      preview: {
        file_id: a.fileId,
        filename,
        mode,
        remote_name: remoteName,
        remote_path: remotePath,
        local_path: localPath,
        will_remove_from: willRemove,
      },
      next_call: "portuni_delete_file with confirmed: true",
    };
  }

  const now = new Date().toISOString();

  let pendingOpId: string | null = null;
  if (mode === "complete" && remoteName && remotePath) {
    pendingOpId = await enqueuePendingOp(db, {
      userId: a.userId,
      nodeId,
      fileId: a.fileId,
      payload: {
        op: "delete",
        remote_name: remoteName,
        remote_path: remotePath,
        filename,
        expected_hash: expectedHash,
        expected_remote_object: expectedRemoteObject,
      },
    });
    try {
      const adapter = await getAdapter(db, remoteName);
      // A registered-but-never-pushed record has a routed remote_path with
      // no object behind it -- deleting the nonexistent object would raise a
      // bogus repair_needed. stat first; skip when nothing is there.
      if ((await adapter.stat(remotePath)) !== null) {
        await adapter.delete(remotePath);
      }
    } catch (e) {
      // Remote delete failed. Do NOT delete the DB row or the local file —
      // that would silently desync state and leave an orphan on the remote
      // with no Portuni record. Surface a repair_needed result instead.
      await failPendingOp(db, pendingOpId, (e as Error).message);
      await db.execute({
        sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
              VALUES (?, ?, 'sync_delete_repair_needed', 'file', ?, ?, ?)`,
        args: [
          ulid(),
          a.userId,
          a.fileId,
          JSON.stringify({
            mode,
            remote_name: remoteName,
            remote_path: remotePath,
            error: (e as Error).message,
          }),
          now,
        ],
      });
      return {
        file_id: a.fileId,
        mode,
        status: "repair_needed",
        detail: {
          phase: "remote",
          remote_name: remoteName,
          remote_path: remotePath,
          error: (e as Error).message,
        },
        repair_hint:
          "Remote delete failed; DB row and local file kept intact. Verify the remote is reachable / authorized, then retry portuni_delete_file.",
      };
    }
    if (localPath) {
      const { rm } = await import("node:fs/promises");
      // Local rm is best-effort: the file is just a cached copy. If this
      // fails after the remote already accepted the delete, the DB row is
      // still removed below (the source of truth is the remote, which is
      // gone). The user can manually rm the orphan local file.
      await rm(localPath, { force: true }).catch(() => undefined);
    }
  }

  await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [a.fileId] });
  await deleteFileState(a.fileId).catch(() => undefined);

  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_delete', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      a.fileId,
      JSON.stringify({
        mode,
        node_id: nodeId,
        remote_name: remoteName,
        remote_path: remotePath,
        local_path: localPath,
        filename,
      }),
      now,
    ],
  });
  // Complete the op only after the tombstone is written -- if the audit
  // insert fails, the op must stay pending so a retry writes the tombstone
  // instead of the delete going unrecorded forever.
  if (pendingOpId) await completePendingOp(db, pendingOpId);

  return { file_id: a.fileId, mode, deleted_at: now, status: "ok" };
}

// --- renameFile ---

export interface RenameFileArgs {
  userId: string;
  fileId: string;
  newFilename: string;
}

export interface RenameFileResult {
  file_id: string;
  new_filename: string;
  new_remote_path: string;
  new_local_path: string | null;
  renamed_at: string;
  // "repair_needed": the remote object and the DB row are at the new path,
  // but the local mirror copy could not be renamed -- see repair_hint.
  status: "ok" | "repair_needed";
  repair_hint?: string;
}

// Rename just the filename, keeping the file in its current section/subpath
// and node. Computed by swapping the basename of remote_path so the location
// is preserved exactly (unlike moveFile, which is about relocation).
export async function renameFile(
  db: Client,
  a: RenameFileArgs,
): Promise<RenameFileResult> {
  const fn = a.newFilename;
  if (
    !fn ||
    fn.includes("/") ||
    fn.includes("\\") ||
    fn.includes("\0") ||
    fn === "." ||
    fn === ".."
  ) {
    throw new Error(`Invalid filename: ${a.newFilename}`);
  }

  const r = await db.execute({
    sql: "SELECT id, node_id, filename, remote_name, remote_path FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (r.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = r.rows[0];
  const nodeId = f.node_id as string;
  const oldFilename = f.filename as string;
  const remoteName = f.remote_name as string | null;
  const oldRemotePath = f.remote_path as string | null;
  if (!remoteName || !oldRemotePath) throw new Error(`File ${a.fileId} has no remote binding`);
  if (!oldRemotePath.endsWith("/" + oldFilename) && oldRemotePath !== oldFilename) {
    throw new Error(`Remote path ${oldRemotePath} does not end with /${oldFilename}`);
  }
  const newRemotePath = oldRemotePath.slice(0, oldRemotePath.length - oldFilename.length) + fn;

  let oldLocalPath: string | null = null;
  let newLocalPath: string | null = null;
  const mirrorRoot = await getMirrorPath(a.userId, nodeId);
  if (mirrorRoot) {
    try {
      const nodeRoot = buildNodeRoot(await resolveNodeInfo(db, nodeId));
      oldLocalPath = deriveLocalPath({ mirrorRoot, nodeRoot, remotePath: oldRemotePath });
      newLocalPath = deriveLocalPath({ mirrorRoot, nodeRoot, remotePath: newRemotePath });
    } catch {
      oldLocalPath = null;
      newLocalPath = null;
    }
  }

  const pendingOpId = await enqueuePendingOp(db, {
    userId: a.userId,
    nodeId,
    fileId: a.fileId,
    payload: {
      op: "move",
      from_remote_name: remoteName,
      from_remote_path: oldRemotePath,
      to_remote_name: remoteName,
      to_remote_path: newRemotePath,
      to_node_id: nodeId,
      filename: fn,
    },
  });
  try {
    const adapter = await getAdapter(db, remoteName);
    await adapter.rename(oldRemotePath, newRemotePath);
  } catch (e) {
    await failPendingOp(db, pendingOpId, (e as Error).message);
    throw e;
  }

  // From here on the remote object lives at the new path. A local failure
  // must NOT abort before the DB UPDATE below -- that would leave the row
  // pointing at the old remote path (every scan classifies it remote_missing).
  // Record the failure and report repair_needed instead, like moveFile.
  let localError: string | null = null;
  if (oldLocalPath && newLocalPath && oldLocalPath !== newLocalPath) {
    try {
      await mkdir(dirname(newLocalPath), { recursive: true });
      await fsRename(oldLocalPath, newLocalPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        localError = (e as Error).message;
      }
    }
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: `UPDATE files SET filename = ?, remote_path = ?, updated_at = ? WHERE id = ?`,
    args: [fn, newRemotePath, now, a.fileId],
  });
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_rename', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      a.fileId,
      JSON.stringify({
        node_id: nodeId,
        old_filename: oldFilename,
        new_filename: fn,
        old_remote_path: oldRemotePath,
        new_remote_path: newRemotePath,
      }),
      now,
    ],
  });
  await completePendingOp(db, pendingOpId);

  return {
    file_id: a.fileId,
    new_filename: fn,
    new_remote_path: newRemotePath,
    new_local_path: newLocalPath,
    renamed_at: now,
    status: localError === null ? "ok" : "repair_needed",
    ...(localError !== null
      ? {
          repair_hint: `Remote and DB renamed, but the local mirror copy could not be moved (${localError}). Rename ${oldLocalPath} to ${newLocalPath} manually, or delete the local copy and pull.`,
        }
      : {}),
  };
}
