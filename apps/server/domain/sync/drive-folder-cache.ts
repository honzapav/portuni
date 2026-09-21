// The Drive adapter's ancestor cache (#419), the persistent half of what
// #337 built in-process only.
//
// Resolving the path of a changed file means walking its `parents` chain up
// to the remote root, one files.get per ancestor. Two tiers keep that at
// zero-or-one round trips:
//
//   1. an in-process LRU memo (folder id -> path relative to the remote
//      root, or null for "its ancestry does not reach the root"), bounded by
//      PORTUNI_DRIVE_FOLDER_MEMO_MAX so Drive's folder history cannot grow
//      it without limit;
//   2. `remote_folder_cache` (migration 037), so the first tick after a
//      restart resolves from the DB instead of re-walking every ancestor
//      over the network.
//
// Only positive entries are persisted -- a null is this process's own
// "don't re-fetch that one for now" note, not a fact worth surviving a
// restart. Invalidation is by PATH, which is what the table stores: a
// folder rename/move or a delete drops the folder's own entry and every
// entry under its old path in both tiers, and the misses refill lazily
// (the spec's "rows are dropped when a folder is renamed/moved" --
// descendants are never recomputed eagerly).
import type { DbClient } from "../../infra/db.js";
import { nowExpr } from "../../infra/sql.js";

export const DEFAULT_FOLDER_MEMO_MAX = 5_000;

// PORTUNI_DRIVE_FOLDER_MEMO_MAX, same validation shape as the watcher's own
// interval vars: anything that is not a positive integer is ignored with one
// warning rather than silently disabling the memo.
export function folderMemoMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORTUNI_DRIVE_FOLDER_MEMO_MAX;
  if (raw === undefined) return DEFAULT_FOLDER_MEMO_MAX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(
      `[portuni:drive] ignoring PORTUNI_DRIVE_FOLDER_MEMO_MAX=${raw} (expected a positive integer)`,
    );
    return DEFAULT_FOLDER_MEMO_MAX;
  }
  return n;
}

// The persistent tier. One instance per remote; every method is scoped to
// that remote's own rows.
export interface FolderPathStore {
  get(folderId: string): Promise<string | null>;
  put(folderId: string, path: string): Promise<void>;
  // `path` itself and everything below it.
  deleteSubtree(path: string): Promise<void>;
  clear(): Promise<void>;
}

// A folder name may contain LIKE wildcards, and over-deleting would silently
// drop unrelated rows; escape them so the prefix match is exact.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createDbFolderPathStore(db: DbClient, remoteName: string): FolderPathStore {
  return {
    async get(folderId) {
      const r = await db.execute({
        sql: "SELECT path FROM remote_folder_cache WHERE remote_name = ? AND folder_id = ?",
        args: [remoteName, folderId],
      });
      if (r.rows.length === 0) return null;
      return String(r.rows[0].path);
    },
    async put(folderId, path) {
      const now = nowExpr(db.dialect);
      await db.execute({
        sql: `INSERT INTO remote_folder_cache (remote_name, folder_id, path, updated_at)
              VALUES (?, ?, ?, ${now})
              ON CONFLICT(remote_name, folder_id) DO UPDATE SET
                path = excluded.path,
                updated_at = ${now}`,
        args: [remoteName, folderId, path],
      });
    },
    async deleteSubtree(path) {
      if (path === "") {
        await this.clear();
        return;
      }
      await db.execute({
        sql: `DELETE FROM remote_folder_cache
              WHERE remote_name = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`,
        args: [remoteName, path, `${escapeLike(path)}/%`],
      });
    },
    async clear() {
      await db.execute({
        sql: "DELETE FROM remote_folder_cache WHERE remote_name = ?",
        args: [remoteName],
      });
    },
  };
}

export interface FolderPathCache {
  // A path, null for "ancestry does not reach the remote root", undefined
  // for "neither tier knows" -- the caller then asks Drive.
  get(folderId: string): Promise<string | null | undefined>;
  set(folderId: string, path: string | null): Promise<void>;
  // Drop this folder's own entry and everything under it, both tiers.
  invalidateSubtree(path: string): Promise<void>;
  // Drop one id from the memo only (a negative entry has no row to drop).
  forgetMemo(folderId: string): void;
  clear(): Promise<void>;
  memoSize(): number;
}

export function createFolderPathCache(
  store: FolderPathStore | null,
  max: number = folderMemoMax(),
): FolderPathCache {
  // Insertion-ordered Map as the LRU: a hit re-inserts the key at the end,
  // an overflowing set evicts the oldest one. The DB is the tier below, so
  // an eviction costs a query, not a Drive call.
  const memo = new Map<string, string | null>();

  function touch(folderId: string, path: string | null): void {
    memo.delete(folderId);
    memo.set(folderId, path);
    while (memo.size > max) {
      const oldest = memo.keys().next();
      if (oldest.done) break;
      memo.delete(oldest.value);
    }
  }

  return {
    async get(folderId) {
      if (memo.has(folderId)) {
        const hit = memo.get(folderId)!;
        touch(folderId, hit);
        return hit;
      }
      if (!store) return undefined;
      const row = await store.get(folderId);
      if (row === null) return undefined;
      touch(folderId, row);
      return row;
    },
    async set(folderId, path) {
      touch(folderId, path);
      if (store && path !== null) await store.put(folderId, path);
    },
    async invalidateSubtree(path) {
      if (path === "") {
        await this.clear();
        return;
      }
      const prefix = `${path}/`;
      for (const [id, cached] of Array.from(memo.entries())) {
        // Negative entries carry no path to compare, and re-resolving one
        // costs a single files.get -- drop them too rather than keep a note
        // taken before the tree moved.
        if (cached === null || cached === path || cached.startsWith(prefix)) memo.delete(id);
      }
      if (store) await store.deleteSubtree(path);
    },
    forgetMemo(folderId) {
      memo.delete(folderId);
    },
    async clear() {
      memo.clear();
      if (store) await store.clear();
    },
    memoSize() {
      return memo.size;
    },
  };
}
