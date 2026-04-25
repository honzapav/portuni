import { copyFile, mkdir, readFile, readdir, rename as fsRename, stat as fsStat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { md5Buffer, sha256Buffer, sha256File, statForCache } from "./hash.js";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import {
  upsertFileState,
  getFileState,
  getRemoteStat,
  upsertRemoteStat,
  deleteFileState,
} from "./local-db.js";
import { getMirrorPath, listUserMirrors, unregisterMirror } from "./mirror-registry.js";
import {
  buildNodeRoot,
  buildRemotePath,
  deriveLocalPath,
  subpathFromMirror,
  type Section,
  type NodeInfo,
} from "./remote-path.js";

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

function mimeFor(n: string): string | null {
  const d = n.lastIndexOf(".");
  return d < 0 ? null : (MIME[n.slice(d).toLowerCase()] ?? null);
}

export async function resolveNodeInfo(db: Client, nodeId: string): Promise<NodeInfo> {
  const r = await db.execute({
    sql: "SELECT type, sync_key FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (r.rows.length === 0) throw new Error(`Node ${nodeId} not found`);
  const type = r.rows[0].type as string;
  const syncKey = r.rows[0].sync_key as string;
  if (type === "organization") {
    return { orgSyncKey: syncKey, nodeType: type, nodeSyncKey: syncKey };
  }
  const org = await db.execute({
    sql: `SELECT n.sync_key FROM edges e JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? AND e.relation = 'belongs_to' AND n.type = 'organization' LIMIT 1`,
    args: [nodeId],
  });
  const orgSyncKey = org.rows.length > 0 ? (org.rows[0].sync_key as string) : null;
  return { orgSyncKey, nodeType: type, nodeSyncKey: syncKey };
}

export interface StoreFileArgs {
  userId: string;
  nodeId: string;
  localPath: string;
  description?: string | null;
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
      `No remote routing configured for node ${a.nodeId} (type=${info.nodeType}, org=${info.orgSyncKey ?? "null"})`,
    );
  }

  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) {
    throw new Error(
      `Node ${a.nodeId} has no local mirror. Register via portuni_mirror first.`,
    );
  }

  // Detect section + subpath + filename.
  let section: Section;
  let subpath: string | null = null;
  let filename: string;
  const inside = subpathFromMirror(mirrorRoot, a.localPath);
  if (inside !== null) {
    section = inside.section;
    subpath = inside.subpath;
    filename = inside.filename;
  } else {
    section = a.status === "output" ? "outputs" : "wip";
    subpath = a.subpath ?? null;
    filename = basename(a.localPath);
  }

  // Compute mirror destination.
  const mirroredAbs = join(mirrorRoot, section, ...(subpath ? [subpath] : []), filename);

  // If source file is not already at the mirror path, copy it in.
  const sourceStat = await fsStat(a.localPath);
  if (sourceStat.size > WARN_SIZE_BYTES) {
    console.warn(
      `[portuni:sync] file ${a.localPath} is ${(sourceStat.size / (1024 * 1024)).toFixed(1)}MB - large upload`,
    );
  }
  if (mirroredAbs !== a.localPath) {
    await mkdir(dirname(mirroredAbs), { recursive: true });
    await copyFile(a.localPath, mirroredAbs);
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
    if (stat && stat.hash) {
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

  // Upsert files row.
  const now = new Date().toISOString();
  const existing = await db.execute({
    sql: "SELECT id FROM files WHERE node_id = ? AND remote_name = ? AND remote_path = ? LIMIT 1",
    args: [a.nodeId, remoteName, remotePath],
  });
  let fileId: string;
  if (existing.rows.length > 0) {
    fileId = existing.rows[0].id as string;
    await db.execute({
      sql: `UPDATE files SET filename = ?, status = COALESCE(?, status), description = COALESCE(?, description),
                               remote_name = ?, remote_path = ?, current_remote_hash = ?,
                               last_pushed_by = ?, last_pushed_at = ?, mime_type = ?,
                               updated_at = ?
                               WHERE id = ?`,
      args: [
        filename,
        a.status ?? null,
        a.description ?? null,
        remoteName,
        remotePath,
        hash,
        a.userId,
        now,
        mt,
        now,
        fileId,
      ],
    });
  } else {
    fileId = ulid();
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, status, description, mime_type,
                                remote_name, remote_path, current_remote_hash, last_pushed_by, last_pushed_at,
                                is_native_format, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      args: [
        fileId,
        a.nodeId,
        filename,
        a.status ?? "wip",
        a.description ?? null,
        mt,
        remoteName,
        remotePath,
        hash,
        a.userId,
        now,
        a.userId,
        now,
        now,
      ],
    });
  }

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
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, content);

  // Use the same hash algorithm the backend reports, so file_state stays
  // comparable with adapter.stat() in subsequent statusScans.
  const useMd5 = knownRemoteHash !== null && knownRemoteHash.length === 32;
  const hash = useMd5 ? md5Buffer(content) : sha256Buffer(content);
  const fsInfo = await statForCache(localPath);
  const now = new Date().toISOString();
  await upsertFileState({
    file_id: a.fileId,
    last_synced_hash: hash,
    last_synced_at: now,
    cached_local_hash: hash,
    cached_mtime: fsInfo.mtime,
    cached_size: fsInfo.size,
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
  class: "clean" | "push" | "pull" | "conflict" | "orphan" | "native";
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

export interface StatusResult {
  clean: StatusFileEntry[];
  push_candidates: StatusFileEntry[];
  pull_candidates: StatusFileEntry[];
  conflicts: StatusFileEntry[];
  orphan: StatusFileEntry[];
  native: StatusFileEntry[];
  new_local: NewLocalEntry[];
  new_remote: NewRemoteEntry[];
  deleted_local: StatusFileEntry[];
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

async function localHashFor(
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
  await upsertFileState({
    file_id: fileId,
    last_synced_hash: cached?.last_synced_hash ?? h,
    last_synced_at: cached?.last_synced_at,
    cached_local_hash: h,
    cached_mtime: now.mtime,
    cached_size: now.size,
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
  } catch {
    return null;
  }
}

type ScanBucket = "clean" | "push_candidates" | "pull_candidates" | "conflicts" | "orphan" | "native" | "deleted_local";

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
      bucket: "orphan",
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
        class: "orphan",
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
  if (!remoteName || !remotePath) return { bucket: "orphan", entry: { ...base, class: "orphan" } };

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
  if (rs === null) return { bucket: "orphan", entry: { ...base, class: "orphan" } };
  base.remote_hash = rs.hash;
  if (!rs.exists) return { bucket: "orphan", entry: { ...base, class: "orphan" } };

  if (localHash === null) {
    if (base.last_synced_hash) {
      return { bucket: "deleted_local", entry: { ...base, class: "clean" } };
    }
    return { bucket: "orphan", entry: { ...base, class: "orphan" } };
  }

  const last = base.last_synced_hash;
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
    orphan: [],
    native: [],
    new_local: [],
    new_remote: [],
    deleted_local: [],
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
    await moveDetectionPhase(db, a, out);
  }

  return out;
}

async function moveDetectionPhase(
  _db: Client,
  _a: StatusArgs,
  out: StatusResult,
): Promise<void> {
  if (out.deleted_local.length === 0 || out.new_local.length === 0) return;
  const byHash = new Map<string, { file_id: string; old_local_path: string }>();
  for (const dl of out.deleted_local) {
    if (dl.last_synced_hash && dl.local_path) {
      byHash.set(dl.last_synced_hash, {
        file_id: dl.file_id,
        old_local_path: dl.local_path,
      });
    }
  }
  for (const nl of out.new_local) {
    const match = byHash.get(nl.hash);
    if (match) {
      out.moved.push({
        file_id: match.file_id,
        old_local_path: match.old_local_path,
        new_local_path: nl.local_path,
        hash: nl.hash,
      });
    }
  }
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
  const filesRes = await db.execute({
    sql: `SELECT node_id, remote_name, remote_path FROM files`,
  });
  for (const r of filesRes.rows) {
    const nid = r.node_id as string;
    const rn = r.remote_name as string | null;
    const rp = r.remote_path as string | null;
    if (rn && rp) {
      if (!knownRemoteByNode.has(nid)) knownRemoteByNode.set(nid, []);
      knownRemoteByNode.get(nid)!.push({ remoteName: rn, remotePath: rp });
      knownRemoteGlobal.add(`${rn}::${rp}`);
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
        localSet.add(deriveLocalPath({ mirrorRoot: m.local_path, nodeRoot, remotePath }));
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
    const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
    if (!remoteName) continue;
    try {
      const adapter = await getAdapter(db, remoteName);
      const entries = await adapter.list(nodeRoot);
      for (const e of entries) {
        if (!knownRemoteGlobal.has(`${remoteName}::${e.path}`)) {
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

  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else if (ent.isFile()) {
        if (knownLocal.has(p)) continue;
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
  status: "new" | "updated" | "unchanged" | "conflict" | "orphan" | "native";
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
    (cls: "new" | "updated" | "unchanged" | "conflict" | "orphan" | "native") =>
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
  for (const e of scan.orphan) files.push(toEntry("orphan")(e));
  for (const e of scan.native) files.push(toEntry("native")(e));
  return { files };
}

// ---------------------------------------------------------------------------
// moveFile / renameFolder (advanced ops)
// ---------------------------------------------------------------------------

export type OpStatus = "ok" | "repair_needed";
export interface OpResult {
  status: OpStatus;
  detail: Record<string, unknown>;
  repair_hint?: string;
}

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
        // Local file absent - not fatal, remote is already moved.
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

// ---------------------------------------------------------------------------
// adoptFiles (remote-only: register untracked remote paths)
// ---------------------------------------------------------------------------

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
  const adopted: AdoptFilesResult["adopted"] = [];
  const skipped: AdoptFilesResult["skipped"] = [];
  for (const p of a.paths) {
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

// ---------------------------------------------------------------------------
// deleteFile (confirm-first; modes: complete | unregister_only)
// ---------------------------------------------------------------------------

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
