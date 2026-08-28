import { copyFile, mkdir, readFile, readdir, rm, stat as fsStat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { md5Buffer, sha256Buffer, sha256File, statForCache } from "./hash.js";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import {
  upsertFileState,
  getFileState,
  deleteFileState,
  getRemoteStat,
  upsertRemoteStat,
} from "./local-db.js";
import { getMirrorPath, listUserMirrors, unregisterMirror } from "./mirror-registry.js";
import {
  buildNodeRoot,
  buildRemotePath,
  deriveLocalPath,
  safeMirrorJoin,
  subpathFromMirror,
  type Section,
  type NodeInfo,
} from "./remote-path.js";
import { resolveNodeInfo } from "./node-info.js";
import { loadMirrorIgnore } from "./mirror-ignore.js";

// Re-export so existing imports `from "./engine.js"` keep working.
export { resolveNodeInfo };

// Appended to "No remote routing configured" errors (and surfaced in the
// portuni_mirror scaffold hint) so the failure is self-explanatory to
// whoever hits it -- a desktop user with the OAuth path, or an agent/admin
// wiring up a service account -- instead of a dead end.
export const ROUTING_GUIDANCE =
  "File sync is not configured. Desktop user: Nastavení → Synchronizace → Propojit Google Drive. " +
  "Agent/admin (service account): call portuni_list_remotes to inspect state, then portuni_setup_remote " +
  "(type gdrive, config {shared_drive_id}, service_account_json) and portuni_set_routing_policy with a " +
  "wildcard rule, or run the setup-drive-remote MCP prompt.";

const WARN_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
};

export function mimeFor(n: string): string | null {
  const d = n.lastIndexOf(".");
  return d < 0 ? null : (MIME[n.slice(d).toLowerCase()] ?? null);
}

export interface StoreFileArgs {
  userId: string;
  nodeId: string;
  localPath: string;
  status?: "wip" | "output";
  subpath?: string | null;
}

export interface StoreFileResult {
  file_id: string;
  remote_name: string;
  remote_path: string;
  local_path: string;
  hash: string;
}

export async function storeFile(db: Client, a: StoreFileArgs): Promise<StoreFileResult> {
  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) {
    throw new Error(
      `No remote routing configured for node ${a.nodeId} (type=${info.nodeType}, org=${info.orgSyncKey ?? "null"})\n${ROUTING_GUIDANCE}`,
    );
  }

  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) {
    throw new Error(
      `Node ${a.nodeId} has no local mirror. Register via portuni_mirror first.`,
    );
  }

  // Detect section + subpath + filename. Identity segments are normalized
  // to NFC: Finder and some pickers hand over NFD ("r" + combining hacek),
  // and a mixed-normalization DB splits one logical file into two -- the
  // walkers and remote paths all compare NFC.
  let section: Section;
  let subpath: string | null = null;
  let filename: string;
  const inside = subpathFromMirror(mirrorRoot, a.localPath);
  if (inside !== null) {
    section = inside.section;
    subpath = inside.subpath?.normalize("NFC") ?? null;
    filename = inside.filename.normalize("NFC");
  } else {
    section = a.status === "output" ? "outputs" : "wip";
    subpath = a.subpath?.normalize("NFC") ?? null;
    filename = basename(a.localPath).normalize("NFC");
  }

  // Compute mirror destination via the safe joiner — the inner segments
  // are individually validated and the result is asserted to live under
  // mirrorRoot. Without this, a caller-supplied subpath like "../.."
  // would silently relocate files outside the mirror after posix.join.
  const mirroredAbs = safeMirrorJoin(
    mirrorRoot,
    section,
    ...(subpath ? [subpath] : []),
    filename,
  );

  // If source file is not already at the mirror path, copy it in.
  const sourceStat = await fsStat(a.localPath);
  if (sourceStat.size > WARN_SIZE_BYTES) {
    console.warn(
      `[portuni:sync] file ${a.localPath} is ${(sourceStat.size / (1024 * 1024)).toFixed(1)}MB - large upload`,
    );
  }
  if (mirroredAbs !== a.localPath) {
    await mkdir(dirname(mirroredAbs), { recursive: true });
    // On APFS (normalization- and case-insensitive) a byte-different path
    // can still be the same physical file -- e.g. the NFD-named source vs
    // its NFC mirror target. copyFile opens the destination with O_TRUNC,
    // so copying a file onto itself zeroes it. Compare inodes first.
    let samePhysicalFile = false;
    try {
      const destStat = await fsStat(mirroredAbs);
      samePhysicalFile =
        destStat.ino === sourceStat.ino && destStat.dev === sourceStat.dev;
    } catch {
      /* destination absent -- normal copy */
    }
    if (!samePhysicalFile) {
      await copyFile(a.localPath, mirroredAbs);
    }
  }

  const content = await readFile(mirroredAbs);

  // Remote path.
  const remotePath = buildRemotePath({ ...info, section, subpath, filename });

  // Upload.
  const adapter = await getAdapter(db, remoteName);
  const mt = mimeFor(filename);
  await adapter.put(remotePath, content, mt ? { mimeType: mt } : undefined);

  // Post-upload verification + canonical hash selection. Backends report
  // different hash algorithms: Drive returns md5Checksum (32 hex), fs returns
  // no hash, future S3/Dropbox vary. We use whichever the backend reports as
  // the canonical "what I last saw" so that statusScan compares like-for-like.
  let hash = sha256Buffer(content);
  try {
    const stat = await adapter.stat(remotePath);
    if (stat?.hash) {
      const expected = stat.hash.length === 32 ? md5Buffer(content) : hash;
      if (stat.hash.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(
          `Post-upload hash verification failed: expected ${expected}, adapter reported ${stat.hash}`,
        );
      }
      hash = stat.hash.toLowerCase();
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Post-upload hash")) throw e;
    // Adapter may not support stat or may have transient failure - treat as soft warning.
  }

  // Upsert files row. Single statement against the idx_files_unique_remote
  // partial index -- a concurrent store of the same path becomes an UPDATE
  // instead of a duplicate row (the old SELECT-then-INSERT could interleave).
  // RETURNING gives us the surviving row id either way. status/description
  // only overwrite when explicitly provided.
  const now = new Date().toISOString();
  const upsert = await db.execute({
    sql: `INSERT INTO files (id, node_id, filename, status, mime_type,
                              remote_name, remote_path, current_remote_hash, last_pushed_by, last_pushed_at,
                              is_native_format, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
          ON CONFLICT(node_id, remote_name, remote_path) WHERE remote_path IS NOT NULL
          DO UPDATE SET
            filename = excluded.filename,
            status = COALESCE(?, files.status),
            current_remote_hash = excluded.current_remote_hash,
            last_pushed_by = excluded.last_pushed_by,
            last_pushed_at = excluded.last_pushed_at,
            mime_type = excluded.mime_type,
            updated_at = excluded.updated_at
          RETURNING id`,
    args: [
      ulid(),
      a.nodeId,
      filename,
      a.status ?? "wip",
      mt,
      remoteName,
      remotePath,
      hash,
      a.userId,
      now,
      a.userId,
      now,
      now,
      a.status ?? null,
    ],
  });
  const fileId = upsert.rows[0].id as string;

  // Audit.
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_store', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      fileId,
      JSON.stringify({ remote_name: remoteName, remote_path: remotePath, hash }),
      now,
    ],
  });

  // Local sync.db file_state.
  const fsInfo = await statForCache(mirroredAbs);
  await upsertFileState({
    file_id: fileId,
    last_synced_hash: hash,
    cached_local_hash: hash,
    cached_mtime: fsInfo.mtime,
    cached_size: fsInfo.size,
    cached_ino: fsInfo.ino,
    cached_dev: fsInfo.dev,
  });

  return {
    file_id: fileId,
    remote_name: remoteName,
    remote_path: remotePath,
    local_path: mirroredAbs,
    hash,
  };
}

export interface RegisterLocalFileArgs {
  userId: string;
  nodeId: string;
  localPath: string;
  status?: "wip" | "output";
  subpath?: string | null;
}

export interface RegisterLocalFileResult {
  file_id: string;
  remote_name: string;
  remote_path: string;
  local_path: string;
  hash: string;
}

// Register a local file WITHOUT uploading it. Mirrors storeFile's path
// resolution (section/subpath/filename, mirror copy-in, remote_path) but
// stops before the adapter: the files row keeps current_remote_hash +
// last_pushed_* NULL and file_state keeps last_synced_hash NULL, so
// statusScan classifies it `push` (pending upload). The next deliberate
// sync (storeFile on the push candidate) uploads it.
//
// This is the deterministic "auto-register on create" path -- the mirror
// watcher and the in-app file-create flow call it so a new file is tracked
// the moment it exists, without an agent calling portuni_store. Idempotent:
// re-registering an already-synced file refreshes the local-hash cache but
// preserves its synced baseline.
export async function registerLocalFile(
  db: Client,
  a: RegisterLocalFileArgs,
): Promise<RegisterLocalFileResult> {
  const info = await resolveNodeInfo(db, a.nodeId);
  const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
  if (!remoteName) {
    throw new Error(
      `No remote routing configured for node ${a.nodeId} (type=${info.nodeType}, org=${info.orgSyncKey ?? "null"})\n${ROUTING_GUIDANCE}`,
    );
  }

  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) {
    throw new Error(
      `Node ${a.nodeId} has no local mirror. Register via portuni_mirror first.`,
    );
  }

  // Detect section + subpath + filename (NFC-normalized), same as storeFile.
  let section: Section;
  let subpath: string | null = null;
  let filename: string;
  const inside = subpathFromMirror(mirrorRoot, a.localPath);
  if (inside !== null) {
    section = inside.section;
    subpath = inside.subpath?.normalize("NFC") ?? null;
    filename = inside.filename.normalize("NFC");
  } else {
    section = a.status === "output" ? "outputs" : "wip";
    subpath = a.subpath?.normalize("NFC") ?? null;
    filename = basename(a.localPath).normalize("NFC");
  }

  const mirroredAbs = safeMirrorJoin(
    mirrorRoot,
    section,
    ...(subpath ? [subpath] : []),
    filename,
  );

  // Copy the source into the mirror if it is not already there (usually a
  // no-op: the file was created in the mirror). Inode compare avoids
  // truncating a file onto itself on case/normalization-insensitive APFS.
  const sourceStat = await fsStat(a.localPath);
  if (mirroredAbs !== a.localPath) {
    await mkdir(dirname(mirroredAbs), { recursive: true });
    let samePhysicalFile = false;
    try {
      const destStat = await fsStat(mirroredAbs);
      samePhysicalFile =
        destStat.ino === sourceStat.ino && destStat.dev === sourceStat.dev;
    } catch {
      /* destination absent -- normal copy */
    }
    if (!samePhysicalFile) {
      await copyFile(a.localPath, mirroredAbs);
    }
  }

  const content = await readFile(mirroredAbs);
  const remotePath = buildRemotePath({ ...info, section, subpath, filename });
  const hash = sha256Buffer(content);
  const mt = mimeFor(filename);
  const now = new Date().toISOString();

  // files row: routed (stable destination) but NEVER pushed --
  // current_remote_hash + last_pushed_* stay NULL so the file reads as a
  // pending upload, not a synced or remote-missing file. On conflict
  // (already registered) we leave those columns untouched so a synced file
  // is not demoted.
  const upsert = await db.execute({
    sql: `INSERT INTO files (id, node_id, filename, status, mime_type,
                              remote_name, remote_path, current_remote_hash, last_pushed_by, last_pushed_at,
                              is_native_format, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)
          ON CONFLICT(node_id, remote_name, remote_path) WHERE remote_path IS NOT NULL
          DO UPDATE SET
            filename = excluded.filename,
            status = COALESCE(?, files.status),
            mime_type = excluded.mime_type,
            updated_at = excluded.updated_at
          RETURNING id`,
    args: [
      ulid(),
      a.nodeId,
      filename,
      a.status ?? "wip",
      mt,
      remoteName,
      remotePath,
      a.userId,
      now,
      now,
      a.status ?? null,
    ],
  });
  const fileId = upsert.rows[0].id as string;

  // Local sync.db file_state: refresh the local-hash cache, preserving any
  // existing synced baseline (null for a genuinely new file).
  const existing = await getFileState(fileId);
  const fsInfo = await statForCache(mirroredAbs);
  await upsertFileState({
    file_id: fileId,
    last_synced_hash: existing?.last_synced_hash ?? null,
    last_synced_at: existing?.last_synced_at ?? null,
    cached_local_hash: hash,
    cached_mtime: fsInfo.mtime,
    cached_size: fsInfo.size,
    cached_ino: fsInfo.ino,
    cached_dev: fsInfo.dev,
  });

  // Audit.
  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_register', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      fileId,
      JSON.stringify({ remote_name: remoteName, remote_path: remotePath, hash }),
      now,
    ],
  });

  return {
    file_id: fileId,
    remote_name: remoteName,
    remote_path: remotePath,
    local_path: mirroredAbs,
    hash,
  };
}

export interface PullFileArgs {
  userId: string;
  fileId: string;
  // Overwrite the local file even when it has changes that were never
  // pushed from this device. Without force such a pull is refused.
  force?: boolean;
}

export interface PullFileResult {
  file_id: string;
  local_path: string;
  hash: string;
}

export async function pullFile(db: Client, a: PullFileArgs): Promise<PullFileResult> {
  const row = await db.execute({
    sql: "SELECT id, node_id, filename, remote_name, remote_path, current_remote_hash FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (row.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = row.rows[0];
  const nodeId = f.node_id as string;
  const remoteName = f.remote_name as string | null;
  const remotePath = f.remote_path as string | null;
  const knownRemoteHash = (f.current_remote_hash as string | null) ?? null;
  if (!remoteName || !remotePath) {
    throw new Error(`File ${a.fileId} has no remote binding`);
  }

  const mirrorRoot = await getMirrorPath(a.userId, nodeId);
  if (!mirrorRoot) {
    throw new Error(
      `Node ${nodeId} has no local mirror on this device. Register via portuni_mirror first.`,
    );
  }

  const info = await resolveNodeInfo(db, nodeId);
  const nodeRoot = buildNodeRoot(info);
  const localPath = deriveLocalPath({ mirrorRoot, nodeRoot, remotePath });

  const adapter = await getAdapter(db, remoteName);
  const content = await adapter.get(remotePath);

  // Use the same hash algorithm the backend reports, so file_state stays
  // comparable with adapter.stat() in subsequent statusScans.
  const useMd5 = knownRemoteHash !== null && knownRemoteHash.length === 32;
  const hash = useMd5 ? md5Buffer(content) : sha256Buffer(content);

  // Dirty-local guard: overwriting is only safe when the local copy matches
  // the last state this device synced, or already equals the remote bytes.
  // A local file with unpushed edits (or with no baseline at all) must not
  // be silently destroyed.
  if (!a.force && (await fileExistsAt(localPath))) {
    const state = await getFileState(a.fileId);
    const baseline = state?.last_synced_hash ?? null;
    const localCur = useMd5
      ? md5Buffer(await readFile(localPath))
      : await sha256File(localPath);
    const dirty =
      localCur !== hash && (baseline === null || localCur !== baseline);
    if (dirty) {
      throw new Error(
        `File ${a.fileId} has local changes that were never pushed from this device ` +
          `(${localPath}). Push them with portuni_store, or pass force: true to overwrite.`,
      );
    }
  }

  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, content);
  const fsInfo = await statForCache(localPath);
  const now = new Date().toISOString();
  await upsertFileState({
    file_id: a.fileId,
    last_synced_hash: hash,
    last_synced_at: now,
    cached_local_hash: hash,
    cached_mtime: fsInfo.mtime,
    cached_size: fsInfo.size,
    cached_ino: fsInfo.ino,
    cached_dev: fsInfo.dev,
  });

  await db.execute({
    sql: `INSERT INTO audit_log (id, user_id, action, target_type, target_id, detail, timestamp)
          VALUES (?, ?, 'sync_pull', 'file', ?, ?, ?)`,
    args: [
      ulid(),
      a.userId,
      a.fileId,
      JSON.stringify({ remote_name: remoteName, remote_path: remotePath, hash }),
      now,
    ],
  });

  return { file_id: a.fileId, local_path: localPath, hash };
}

// ---------------------------------------------------------------------------
// statusScan / previewNode
// ---------------------------------------------------------------------------

const REMOTE_STAT_TTL_MS = 30_000;

export interface StatusArgs {
  userId: string;
  nodeId?: string;
  remoteName?: string;
  includeDiscovery?: boolean;
  // Fast mode: classify purely from DB cache (file_state.cached_local_hash
  // + files.current_remote_hash + file_state.last_synced_hash) without
  // touching the filesystem or the remote adapter. Used by the UI sync
  // indicator where "what we last knew" is acceptable; the trigger path
  // still uses the slow scan for ground truth before acting.
  fast?: boolean;
  // Discovery sub-flag: when set, runDiscovery still walks the local mirror
  // for new_local files but SKIPS the per-mirror remote `adapter.list` call
  // that finds new_remote. The cross-mirror unsynced aggregate
  // (computeSyncPending) never counts new_remote, so paying for one Drive
  // round-trip per mirror is pure waste — with dozens of mirrors those
  // serial network calls made /sync/pending take minutes and silently time
  // out, killing the footer indicator. No effect unless includeDiscovery.
  skipRemoteDiscovery?: boolean;
}

export interface StatusFileEntry {
  file_id: string;
  node_id: string;
  filename: string;
  local_path: string | null;
  remote_name: string | null;
  remote_path: string | null;
  local_hash: string | null;
  remote_hash: string | null;
  last_synced_hash: string | null;
  class: "clean" | "push" | "pull" | "conflict" | "remote_missing" | "remote_error" | "native";
}

export interface NewLocalEntry {
  node_id: string;
  local_path: string;
  section: Section;
  subpath: string | null;
  filename: string;
  hash: string;
}

export interface NewRemoteEntry {
  node_id: string;
  remote_name: string;
  remote_path: string;
  filename: string;
  hash: string | null;
}

export interface MoveProposal {
  file_id: string;
  old_local_path: string;
  new_local_path: string;
  hash: string;
}

// An untracked disk file whose record was deliberately deleted elsewhere
// (matched against a delete tombstone -- see matchDeleteTombstones). The
// sync run removes the local copy and the dangling file_state row instead
// of adopting the file back.
export interface DeletedRemoteEntry {
  file_id: string;
  node_id: string;
  filename: string;
  local_path: string;
  remote_path: string;
  hash: string;
  // True when the tombstone came from a move/rename, not a delete: the
  // files row is still alive (at a new path), so cleanup must remove the
  // stale local copy but MUST NOT delete its file_state row.
  record_alive: boolean;
}

export interface StatusResult {
  clean: StatusFileEntry[];
  push_candidates: StatusFileEntry[];
  pull_candidates: StatusFileEntry[];
  conflicts: StatusFileEntry[];
  remote_missing: StatusFileEntry[];
  remote_error: StatusFileEntry[];
  native: StatusFileEntry[];
  new_local: NewLocalEntry[];
  new_remote: NewRemoteEntry[];
  deleted_local: StatusFileEntry[];
  deleted_remote: DeletedRemoteEntry[];
  moved: MoveProposal[];
}

async function fileExistsAt(path: string): Promise<boolean> {
  try {
    await fsStat(path);
    return true;
  } catch {
    return false;
  }
}

// Exported for the mirror watcher's reconcile path: re-hashes a changed
// file (mtime/size guard) and refreshes file_state.cached_local_hash while
// preserving the synced baseline -- exactly what a modify event needs.
export async function localHashFor(
  path: string,
  fileId: string,
  remoteHashRef: string | null = null,
): Promise<string | null> {
  if (!(await fileExistsAt(path))) return null;
  const cached = await getFileState(fileId);
  const now = await statForCache(path);
  if (
    cached &&
    cached.cached_mtime === now.mtime &&
    cached.cached_size === now.size &&
    cached.cached_local_hash
  ) {
    return cached.cached_local_hash;
  }
  // Pick algo based on what the backend reports for this file. If we already
  // have a remote hash (length 32 = md5, 64 = sha256), match it. Otherwise
  // default to sha256.
  const algoRef = remoteHashRef ?? cached?.last_synced_hash ?? null;
  const useMd5 = algoRef !== null && algoRef.length === 32;
  const h = useMd5
    ? md5Buffer(await readFile(path))
    : await sha256File(path);
  // Only refresh the hash cache. Never invent a baseline: a file this
  // device has not synced must keep last_synced_hash NULL so the scan
  // classifies it as conflict instead of silently clean/pull/push.
  await upsertFileState({
    file_id: fileId,
    last_synced_hash: cached?.last_synced_hash ?? null,
    last_synced_at: cached?.last_synced_at ?? null,
    cached_local_hash: h,
    cached_mtime: now.mtime,
    cached_size: now.size,
    cached_ino: now.ino,
    cached_dev: now.dev,
  });
  return h;
}

async function cachedRemoteStat(
  db: Client,
  fileId: string,
  remoteName: string,
  remotePath: string,
): Promise<{ hash: string | null; exists: boolean } | null> {
  const cached = await getRemoteStat(fileId);
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < REMOTE_STAT_TTL_MS) {
    return {
      hash: cached.remote_hash,
      exists: cached.remote_hash !== null || cached.remote_modified_at !== null,
    };
  }
  try {
    const adapter = await getAdapter(db, remoteName);
    const stat = await adapter.stat(remotePath);
    await upsertRemoteStat({
      file_id: fileId,
      remote_hash: stat?.hash ?? null,
      remote_modified_at: stat?.modified_at.toISOString() ?? null,
      fetched_at: new Date().toISOString(),
    });
    return stat === null ? { hash: null, exists: false } : { hash: stat.hash, exists: true };
  } catch (e) {
    // Returning null classifies the file as remote_error -- when the cause
    // is a transient SQLITE_BUSY on the shared sync.db (sidecar + tmux
    // server) or an adapter hiccup, a silent catch makes those flickers
    // undiagnosable. Log once per remote+error to keep scans quiet.
    warnOncePerKey(
      `${remoteName}:${e instanceof Error ? e.message.slice(0, 80) : String(e)}`,
      `[portuni:sync] remote stat failed (files will show as remote_error until it recovers): remote=${remoteName} err=${String(e)}`,
    );
    return null;
  }
}

const warnedKeys = new Set<string>();
function warnOncePerKey(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

type ScanBucket = "clean" | "push_candidates" | "pull_candidates" | "conflicts" | "remote_missing" | "remote_error" | "native" | "deleted_local";

interface ScanRowResult {
  bucket: ScanBucket;
  entry: StatusFileEntry;
}

async function scanRow(
  db: Client,
  a: StatusArgs,
  row: Record<string, unknown>,
  nodeInfoCache: Map<string, NodeInfo | null>,
  mirrorCache: Map<string, string | null>,
): Promise<ScanRowResult> {
  const fileId = row.id as string;
  const nodeId = row.node_id as string;
  const filename = row.filename as string;
  const remoteName = (row.remote_name as string | null) ?? null;
  const remotePath = (row.remote_path as string | null) ?? null;
  const isNative = Number(row.is_native_format) === 1;

  const info = nodeInfoCache.get(nodeId) ?? null;
  if (info === null) {
    return {
      bucket: "remote_error",
      entry: {
        file_id: fileId,
        node_id: nodeId,
        filename,
        local_path: null,
        remote_name: remoteName,
        remote_path: remotePath,
        local_hash: null,
        remote_hash: null,
        last_synced_hash: null,
        class: "remote_error",
      },
    };
  }

  const mirrorRoot = mirrorCache.get(nodeId) ?? null;
  const localPath =
    mirrorRoot && remotePath
      ? (() => {
          try {
            return deriveLocalPath({ mirrorRoot, nodeRoot: buildNodeRoot(info), remotePath });
          } catch {
            return null;
          }
        })()
      : null;

  const base: StatusFileEntry = {
    file_id: fileId,
    node_id: nodeId,
    filename,
    local_path: localPath,
    remote_name: remoteName,
    remote_path: remotePath,
    local_hash: null,
    remote_hash: null,
    last_synced_hash: null,
    class: "clean",
  };

  if (isNative) return { bucket: "native", entry: { ...base, class: "native" } };
  if (!remoteName || !remotePath) return { bucket: "remote_error", entry: { ...base, class: "remote_error" } };

  const state = await getFileState(fileId);
  base.last_synced_hash = state?.last_synced_hash ?? null;
  const currentRemoteHash = (row.current_remote_hash as string | null) ?? null;
  const localHash = a.fast
    ? (state?.cached_local_hash ?? null)
    : localPath
      ? await localHashFor(localPath, fileId, currentRemoteHash)
      : null;
  base.local_hash = localHash;
  const rs = a.fast
    ? { hash: currentRemoteHash, exists: currentRemoteHash !== null }
    : await cachedRemoteStat(db, fileId, remoteName, remotePath);
  if (rs === null) return { bucket: "remote_error", entry: { ...base, class: "remote_error" } };
  base.remote_hash = rs.hash;
  if (!rs.exists) {
    // Registered locally but not on the remote. A brand-new file staged for
    // the next push -- local content present, never synced -- reads as
    // `push` (pending upload). A file whose remote vanished after a sync
    // (baseline present) or one with no local content is `remote_missing`.
    if (localHash !== null && base.last_synced_hash === null) {
      return { bucket: "push_candidates", entry: { ...base, class: "push" } };
    }
    return { bucket: "remote_missing", entry: { ...base, class: "remote_missing" } };
  }

  if (localHash === null) {
    if (base.last_synced_hash) {
      return { bucket: "deleted_local", entry: { ...base, class: "clean" } };
    }
    // Remote content exists but this device never synced it -> fetchable.
    return { bucket: "pull_candidates", entry: { ...base, class: "pull" } };
  }

  const last = base.last_synced_hash;

  // No baseline on this device (fresh sync.db, restored backup, second
  // device): never guess. Identical content is provably clean; anything
  // else needs a human decision (pull force / store) -- classifying it as
  // pull or push here is exactly how local or remote edits get destroyed.
  if (last === null) {
    if (rs.hash !== null && rs.hash === localHash) {
      return { bucket: "clean", entry: { ...base, class: "clean" } };
    }
    return { bucket: "conflicts", entry: { ...base, class: "conflict" } };
  }

  const remoteUnknown = rs.hash === null;
  const remoteMatchesLast = rs.hash !== null ? rs.hash === last : last !== null;
  const localMatchesLast = localHash === last;

  if (remoteUnknown && localMatchesLast) return { bucket: "clean", entry: { ...base, class: "clean" } };
  if (remoteUnknown && !localMatchesLast)
    return { bucket: "push_candidates", entry: { ...base, class: "push" } };

  if (localMatchesLast && remoteMatchesLast)
    return { bucket: "clean", entry: { ...base, class: "clean" } };
  if (!localMatchesLast && remoteMatchesLast)
    return { bucket: "push_candidates", entry: { ...base, class: "push" } };
  if (localMatchesLast && !remoteMatchesLast)
    return { bucket: "pull_candidates", entry: { ...base, class: "pull" } };
  return { bucket: "conflicts", entry: { ...base, class: "conflict" } };
}

// Bounded-concurrency map. Workers pull from a shared index; results land in
// the same positions as the inputs. Used by statusScan to fan out the
// per-file local-hash / remote-stat work without serialising on each row.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

const STATUS_SCAN_CONCURRENCY = Math.max(
  1,
  Number(process.env.PORTUNI_STATUS_SCAN_CONCURRENCY ?? 8),
);

export async function statusScan(db: Client, a: StatusArgs): Promise<StatusResult> {
  const out: StatusResult = {
    clean: [],
    push_candidates: [],
    pull_candidates: [],
    conflicts: [],
    remote_missing: [],
    remote_error: [],
    native: [],
    new_local: [],
    new_remote: [],
    deleted_local: [],
    deleted_remote: [],
    moved: [],
  };

  // Select files to scan.
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (a.nodeId) {
    conditions.push("f.node_id = ?");
    params.push(a.nodeId);
  }
  if (a.remoteName) {
    conditions.push("f.remote_name = ?");
    params.push(a.remoteName);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rowsRes = await db.execute({
    sql: `SELECT f.id, f.node_id, f.filename, f.remote_name, f.remote_path,
                 f.current_remote_hash, f.is_native_format,
                 n.type AS node_type, n.sync_key AS node_sync_key
          FROM files f JOIN nodes n ON n.id = f.node_id
          ${where}`,
    args: params as never[],
  });

  // Pre-resolve node info + mirror root once per unique nodeId. The original
  // loop did this per-row, multiplying DB roundtrips by the file fan-out
  // even though all files for the same node share the same answer.
  const uniqueNodeIds = Array.from(new Set(rowsRes.rows.map((r) => r.node_id as string)));
  const nodeInfoCache = new Map<string, NodeInfo | null>();
  const mirrorCache = new Map<string, string | null>();
  await Promise.all(
    uniqueNodeIds.map(async (nodeId) => {
      try {
        nodeInfoCache.set(nodeId, await resolveNodeInfo(db, nodeId));
      } catch {
        nodeInfoCache.set(nodeId, null);
      }
      mirrorCache.set(nodeId, await getMirrorPath(a.userId, nodeId));
    }),
  );

  const rowResults = await mapWithConcurrency(
    rowsRes.rows as unknown as Record<string, unknown>[],
    STATUS_SCAN_CONCURRENCY,
    (row) => scanRow(db, a, row, nodeInfoCache, mirrorCache),
  );
  for (const r of rowResults) out[r.bucket].push(r.entry);

  if (a.includeDiscovery !== false) {
    await runDiscovery(db, a, out);
    const m = await matchDeleteTombstones(db, a.userId, out.new_local);
    out.new_local = m.remaining;
    out.deleted_remote = m.deleted_remote;
    // NOTE: on-disk move detection lives in reconcile.ts (tryApplyDiskMove),
    // keyed on inode identity at watcher registration time. The old
    // moveDetectionPhase here paired deleted_local x new_local -- but with
    // the watcher running, a moved file's new path is registered before any
    // scan sees it as new_local, so the phase was dead code. The `moved`
    // bucket stays in StatusResult for API compatibility (always empty).
  }

  return out;
}

// Tombstone reconciliation (GH #79): match untracked disk files against the
// node's delete tombstones so a copy left behind on this device cannot
// resurrect a deliberate deletion via adopt/store. Triple match -- the local
// path derived from the tombstone's remote_path, a file_state row for the
// tombstoned id on THIS device, and last_synced_hash equal to the current
// disk hash -- makes the cleanup lossless by construction: any post-delete
// edit fails the hash check and the file stays new_local.
export async function matchDeleteTombstones<
  T extends { node_id: string; local_path: string; filename: string; hash?: string },
>(
  db: Client,
  userId: string,
  entries: T[],
): Promise<{ deleted_remote: DeletedRemoteEntry[]; remaining: T[] }> {
  if (entries.length === 0) return { deleted_remote: [], remaining: entries };
  const deleted: DeletedRemoteEntry[] = [];
  const matchedPaths = new Set<string>();
  const byNode = new Map<string, T[]>();
  for (const e of entries) {
    if (!byNode.has(e.node_id)) byNode.set(e.node_id, []);
    byNode.get(e.node_id)!.push(e);
  }
  for (const [nodeId, nodeEntries] of byNode) {
    const mirrorRoot = await getMirrorPath(userId, nodeId);
    if (!mirrorRoot) continue;
    let nodeRoot: string;
    try {
      nodeRoot = buildNodeRoot(await resolveNodeInfo(db, nodeId));
    } catch {
      continue;
    }
    const tombRes = await db.execute({
      sql: `SELECT target_id, action,
                   COALESCE(json_extract(detail, '$.remote_path'),
                            json_extract(detail, '$.old_remote_path')) AS remote_path
            FROM audit_log
            WHERE target_type = 'file'
              AND action IN ('sync_delete', 'sync_delete_remote', 'sync_move', 'sync_rename')
              AND json_extract(detail, '$.node_id') = ?
            ORDER BY timestamp DESC LIMIT 200`,
      args: [nodeId],
    });
    for (const t of tombRes.rows) {
      const remotePath = t.remote_path as string | null;
      if (!remotePath) continue;
      const action = t.action as string;
      const recordAlive = action === "sync_move" || action === "sync_rename";
      let expectedLocal: string;
      try {
        expectedLocal = deriveLocalPath({ mirrorRoot, nodeRoot, remotePath }).normalize("NFC");
      } catch {
        continue;
      }
      const entry = nodeEntries.find(
        (e) => e.local_path.normalize("NFC") === expectedLocal && !matchedPaths.has(e.local_path),
      );
      if (!entry) continue;
      const st = await getFileState(t.target_id as string);
      if (!st || st.last_synced_hash === null) continue;
      const hash = await diskHashMatching(st.last_synced_hash, entry.local_path, entry.hash);
      if (hash === null || hash !== st.last_synced_hash) continue;
      if (recordAlive) {
        // The file's record moved on -- skip the tombstone if it moved
        // right back to this exact path (the move was undone), otherwise
        // a live file would get its file_state deleted out from under it.
        const cur = await db.execute({
          sql: "SELECT remote_path FROM files WHERE id = ?",
          args: [t.target_id as string],
        });
        if (cur.rows.length > 0 && (cur.rows[0].remote_path as string | null) === remotePath) {
          continue;
        }
      }
      matchedPaths.add(entry.local_path);
      deleted.push({
        file_id: t.target_id as string,
        node_id: nodeId,
        filename: entry.filename,
        local_path: entry.local_path,
        remote_path: remotePath,
        hash,
        record_alive: recordAlive,
      });
    }
  }
  return {
    deleted_remote: deleted,
    remaining: entries.filter((e) => !matchedPaths.has(e.local_path)),
  };
}

// Disk hash in the SAME algorithm as the reference hash: adapters report
// different canonical hashes (Drive md5 = 32 hex, fs/sha256 = 64 hex), and a
// cross-algorithm comparison would never match -- silently disabling the
// tombstone cleanup on Drive-backed files. A precomputed sha256 (discovery
// walk) is reused only when the reference is sha256 too. Exported for the
// central engine's tombstone matcher.
export async function diskHashMatching(
  referenceHash: string,
  localPath: string,
  precomputedSha256?: string,
): Promise<string | null> {
  const useMd5 = referenceHash.length === 32;
  if (!useMd5 && precomputedSha256 && precomputedSha256.length === 64) {
    return precomputedSha256;
  }
  const content = await readFile(localPath).catch(() => null);
  if (content === null) return null;
  return useMd5 ? md5Buffer(content) : sha256Buffer(content);
}

// Apply the deleted_remote cleanup: remove the stale local copy and the
// dangling file_state row. Lossless by the matchDeleteTombstones contract --
// only files byte-identical to their last synced state ever get here.
export async function cleanupDeletedRemote(
  entries: DeletedRemoteEntry[],
): Promise<{
  cleaned: DeletedRemoteEntry[];
  errors: Array<{ file_id: string; filename: string; error: string }>;
}> {
  const cleaned: DeletedRemoteEntry[] = [];
  const errors: Array<{ file_id: string; filename: string; error: string }> = [];
  for (const e of entries) {
    try {
      await rm(e.local_path, { force: true });
      // A move/rename tombstone's record is still alive at its new path --
      // its file_state must survive the cleanup of the stale old copy.
      if (!e.record_alive) await deleteFileState(e.file_id).catch(() => undefined);
      cleaned.push(e);
    } catch (err) {
      errors.push({ file_id: e.file_id, filename: e.filename, error: String(err) });
    }
  }
  return { cleaned, errors };
}

// discovery walks mirrors to find new_local files and lists adapters to find new_remote files.
async function runDiscovery(db: Client, a: StatusArgs, out: StatusResult): Promise<void> {
  const mirrors = a.nodeId
    ? await (async () => {
        const one = await getMirrorPath(a.userId, a.nodeId!);
        return one
          ? [{ user_id: a.userId, node_id: a.nodeId!, local_path: one, registered_at: "" }]
          : [];
      })()
    : await listUserMirrors(a.userId);

  // Collect file-row paths per node (for new_local local-file discovery) AND
  // a global set keyed by "remoteName::remotePath" (for new_remote discovery).
  // The global set matters when a parent (org) node's mirror lists its full
  // subtree -- files registered on child nodes are still "known", not new.
  const knownRemoteByNode = new Map<string, { remoteName: string; remotePath: string }[]>();
  const knownRemoteGlobal = new Set<string>();
  // Scope the known-files query to the node subtree when scanning a single
  // mirror -- the full-table scan only pays off for the all-mirrors case.
  // The prefix (not node_id alone) matters for org mirrors: their remote
  // listing covers the whole org subtree, and child nodes' files must stay
  // "known" or they would all surface as new_remote.
  let filesSql = "SELECT node_id, remote_name, remote_path FROM files";
  let filesArgs: Array<string> = [];
  if (a.nodeId && mirrors.length === 1) {
    try {
      const info = await resolveNodeInfo(db, a.nodeId);
      const root = buildNodeRoot(info);
      const likePrefix = root.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      filesSql += " WHERE node_id = ? OR remote_path LIKE ? ESCAPE '\\'";
      filesArgs = [a.nodeId, `${likePrefix}/%`];
    } catch {
      /* node info unavailable -- fall back to the full scan */
    }
  }
  const filesRes = await db.execute({ sql: filesSql, args: filesArgs });
  for (const r of filesRes.rows) {
    const nid = r.node_id as string;
    const rn = r.remote_name as string | null;
    const rp = r.remote_path as string | null;
    if (rn && rp) {
      if (!knownRemoteByNode.has(nid)) knownRemoteByNode.set(nid, []);
      knownRemoteByNode.get(nid)!.push({ remoteName: rn, remotePath: rp });
      // NFC-normalized keys: remote backends may return either byte form
      // for the same logical name (Drive normalizes, fs preserves).
      knownRemoteGlobal.add(`${rn}::${rp.normalize("NFC")}`);
    }
  }

  for (const m of mirrors) {
    let info: NodeInfo;
    try {
      info = await resolveNodeInfo(db, m.node_id);
    } catch {
      // Stale row — skip, best-effort cleanup.
      void unregisterMirror(a.userId, m.node_id).catch(() => undefined);
      continue;
    }
    const nodeRoot = buildNodeRoot(info);

    // Scan filesystem under mirrorRoot for new_local.
    const localSet = new Set<string>();
    const knownForNode = knownRemoteByNode.get(m.node_id) ?? [];
    for (const { remotePath } of knownForNode) {
      try {
        localSet.add(
          deriveLocalPath({ mirrorRoot: m.local_path, nodeRoot, remotePath }).normalize("NFC"),
        );
      } catch {
        /* ok */
      }
    }

    for (const section of ["wip", "outputs", "resources"] as Section[]) {
      await walkMirror(out, m.node_id, m.local_path, section, localSet);
    }

    // Discovery on remote: list adapter paths under buildNodeRoot, skip any
    // file that is tracked anywhere in `files` (not just under this node id).
    // Org nodes' nodeRoot expands to the whole org subtree, so per-node-only
    // matching would falsely flag every child's file as new_remote.
    // Callers that don't consume new_remote (the unsynced aggregate) opt out
    // of this network round-trip via skipRemoteDiscovery.
    if (a.skipRemoteDiscovery) continue;
    const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
    if (!remoteName) continue;
    try {
      const adapter = await getAdapter(db, remoteName);
      const entries = await adapter.list(nodeRoot);
      for (const e of entries) {
        if (!knownRemoteGlobal.has(`${remoteName}::${e.path.normalize("NFC")}`)) {
          out.new_remote.push({
            node_id: m.node_id,
            remote_name: remoteName,
            remote_path: e.path,
            filename: e.path.split("/").pop() ?? e.path,
            hash: e.hash,
          });
        }
      }
    } catch {
      // Adapter unavailable — skip quietly.
    }
  }
}

async function walkMirror(
  out: StatusResult,
  nodeId: string,
  mirrorRoot: string,
  section: Section,
  knownLocal: Set<string>,
): Promise<void> {
  const sectionAbs = join(mirrorRoot, section);
  const isIgnored = await loadMirrorIgnore(mirrorRoot);

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (isIgnored(p)) continue;
      if (ent.isDirectory()) {
        await walk(p);
      } else if (ent.isFile()) {
        // readdir preserves on-disk bytes (possibly NFD); the known set is
        // derived from the DB (NFC). Compare normalized so one logical file
        // does not get re-discovered under its other byte form.
        if (knownLocal.has(p.normalize("NFC"))) continue;
        const sub = subpathFromMirror(mirrorRoot, p);
        if (!sub) continue;
        try {
          const h = await sha256File(p);
          out.new_local.push({
            node_id: nodeId,
            local_path: p,
            section: sub.section,
            subpath: sub.subpath,
            filename: sub.filename,
            hash: h,
          });
        } catch {
          /* unreadable */
        }
      }
    }
  }

  try {
    await walk(sectionAbs);
  } catch {
    /* section dir may not exist */
  }
}

// ---------------------------------------------------------------------------
// previewNode
// ---------------------------------------------------------------------------

export interface PreviewNodeArgs {
  userId: string;
  nodeId: string;
}

export interface PreviewFileEntry {
  file_id: string;
  filename: string;
  status: "new" | "updated" | "unchanged" | "conflict" | "remote_missing" | "remote_error" | "native";
  remote_hash: string | null;
  local_hash: string | null;
  last_synced_hash: string | null;
}

export interface PreviewNodeResult {
  files: PreviewFileEntry[];
}

export async function previewNode(
  db: Client,
  a: PreviewNodeArgs,
): Promise<PreviewNodeResult> {
  const scan = await statusScan(db, {
    userId: a.userId,
    nodeId: a.nodeId,
    includeDiscovery: false,
  });
  const files: PreviewFileEntry[] = [];
  const toEntry =
    (cls: "new" | "updated" | "unchanged" | "conflict" | "remote_missing" | "remote_error" | "native") =>
    (e: StatusFileEntry): PreviewFileEntry => ({
      file_id: e.file_id,
      filename: e.filename,
      status: cls,
      remote_hash: e.remote_hash,
      local_hash: e.local_hash,
      last_synced_hash: e.last_synced_hash,
    });
  for (const e of scan.clean) files.push(toEntry("unchanged")(e));
  for (const e of scan.push_candidates) files.push(toEntry("updated")(e));
  for (const e of scan.pull_candidates) files.push(toEntry("updated")(e));
  for (const e of scan.conflicts) files.push(toEntry("conflict")(e));
  for (const e of scan.remote_missing) files.push(toEntry("remote_missing")(e));
  for (const e of scan.remote_error) files.push(toEntry("remote_error")(e));
  for (const e of scan.native) files.push(toEntry("native")(e));
  return { files };
}

// Mutations (moveFile, renameFolder, adoptFiles, deleteFile) live in
// engine-mutations.ts but are re-exported here so existing imports
// (`from "../domain/sync/engine.js"`) keep working.
export {
  moveFile,
  renameFolder,
  adoptFiles,
  deleteFile,
} from "./engine-mutations.js";
