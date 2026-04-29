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
import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import { deleteFileState } from "./local-db.js";
import { getMirrorPath } from "./mirror-registry.js";
import {
  buildNodeRoot,
  buildRemotePath,
  deriveLocalPath,
  assertSafeRelativePath,
  RemotePathError,
  type Section,
} from "./remote-path.js";
import { resolveNodeInfo } from "./engine.js";

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

function inferSectionFromPath(p: string): Section {
  if (p.includes("/outputs/")) return "outputs";
  if (p.includes("/resources/")) return "resources";
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
  const filename = fr.filename as string;
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

  // Best-effort ordered execution.
  // 1. Remote move.
  try {
    if (!crossRemote) {
      const adapter = await getAdapter(db, oldRemoteName);
      await adapter.rename(oldRemotePath, newRemotePath);
    } else {
      const src = await getAdapter(db, oldRemoteName);
      const dst = await getAdapter(db, newRemoteName);
      const bytes = await src.get(oldRemotePath);
      await dst.put(newRemotePath, bytes);
      await src.delete(oldRemotePath);
    }
  } catch (e) {
    return {
      status: "repair_needed",
      file_id: a.fileId,
      new_remote_name: newRemoteName,
      new_remote_path: newRemotePath,
      new_local_path: newLocalPath,
      moved_at: new Date().toISOString(),
      detail: {
        phase: "remote",
        error: (e as Error).message,
        old_remote_path: oldRemotePath,
        new_remote_path: newRemotePath,
      },
      repair_hint:
        "Remote move failed. No state changed. Retry the tool; if it still fails, inspect the remote manually.",
    };
  }

  // 2. Local move.
  let localDone = true;
  if (oldLocalPath && newLocalPath && oldLocalPath !== newLocalPath) {
    try {
      await mkdir(dirname(newLocalPath), { recursive: true });
      await fsRename(oldLocalPath, newLocalPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        localDone = true;
      } else {
        const now = new Date().toISOString();
        await db.execute({
          sql: `UPDATE files SET remote_name = ?, remote_path = ?, node_id = ?, updated_at = ? WHERE id = ?`,
          args: [newRemoteName, newRemotePath, targetNodeId, now, a.fileId],
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
    sql: `UPDATE files SET remote_name = ?, remote_path = ?, node_id = ?, updated_at = ? WHERE id = ?`,
    args: [newRemoteName, newRemotePath, targetNodeId, now, a.fileId],
  });

  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_move', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      a.fileId,
      JSON.stringify({
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
      }),
      now,
    ],
  });

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

  const rows = await db.execute({
    sql: "SELECT id, filename, remote_name, remote_path FROM files WHERE node_id = ? AND remote_path LIKE ?",
    args: [a.nodeId, `${oldAbs}/%`],
  });
  const affected = rows.rows.map((r) => {
    const oldRemote = r.remote_path as string;
    const newRemote = oldRemote.replace(oldAbs, newAbs);
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

  for (const f of affected) {
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
      results.push({
        file_id: f.file_id,
        status: "ok",
        old_remote_path: f.old_remote_path,
        new_remote_path: f.new_remote_path,
      });
    } catch (e) {
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
    const existing = await db.execute({
      sql: "SELECT id FROM files WHERE node_id = ? AND remote_name = ? AND remote_path = ? LIMIT 1",
      args: [a.nodeId, remoteName, p],
    });
    if (existing.rows.length > 0) {
      skipped.push({ remote_path: p, reason: "already tracked" });
      continue;
    }
    const stat = await adapter.stat(p);
    if (!stat) {
      skipped.push({ remote_path: p, reason: "remote file not found" });
      continue;
    }
    const id = ulid();
    const now = new Date().toISOString();
    const filename = p.split("/").pop() ?? p;
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, status, remote_name, remote_path, current_remote_hash, is_native_format, last_pushed_by, last_pushed_at, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    await db.execute({
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
    sql: "SELECT id, node_id, filename, remote_name, remote_path FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (r.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = r.rows[0];
  const mode = a.mode ?? "complete";
  const nodeId = f.node_id as string;
  const remoteName = f.remote_name as string | null;
  const remotePath = f.remote_path as string | null;
  const filename = f.filename as string;

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

  if (mode === "complete" && remoteName && remotePath) {
    try {
      const adapter = await getAdapter(db, remoteName);
      await adapter.delete(remotePath);
    } catch (e) {
      // Remote delete failed. Do NOT delete the DB row or the local file —
      // that would silently desync state and leave an orphan on the remote
      // with no Portuni record. Surface a repair_needed result instead.
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
        remote_name: remoteName,
        remote_path: remotePath,
        local_path: localPath,
        filename,
      }),
      now,
    ],
  });

  return { file_id: a.fileId, mode, deleted_at: now, status: "ok" };
}
