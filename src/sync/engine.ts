import { copyFile, mkdir, readFile, readdir, stat as fsStat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import { sha256Buffer, sha256File, statForCache } from "./hash.js";
import { getAdapter } from "./adapter-cache.js";
import { resolveRemote } from "./routing.js";
import {
  upsertFileState,
  getFileState,
  getRemoteStat,
  upsertRemoteStat,
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

  // Compute hash from the mirror copy (which is the canonical path).
  const hash = await sha256File(mirroredAbs);
  const content = await readFile(mirroredAbs);

  // Remote path.
  const remotePath = buildRemotePath({ ...info, section, subpath, filename });

  // Upload.
  const adapter = await getAdapter(db, remoteName);
  const mt = mimeFor(filename);
  await adapter.put(remotePath, content, mt ? { mimeType: mt } : undefined);

  // Post-upload verification.
  try {
    const stat = await adapter.stat(remotePath);
    if (stat && stat.hash && stat.hash !== hash) {
      throw new Error(
        `Post-upload hash verification failed: expected ${hash}, adapter reported ${stat.hash}`,
      );
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
                               last_pushed_by = ?, last_pushed_at = ?, mime_type = ?, local_path = ?,
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
        mirroredAbs,
        now,
        fileId,
      ],
    });
  } else {
    fileId = ulid();
    await db.execute({
      sql: `INSERT INTO files (id, node_id, filename, local_path, status, description, mime_type,
                                remote_name, remote_path, current_remote_hash, last_pushed_by, last_pushed_at,
                                is_native_format, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      args: [
        fileId,
        a.nodeId,
        filename,
        mirroredAbs,
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
    sql: "SELECT id, node_id, filename, remote_name, remote_path FROM files WHERE id = ?",
    args: [a.fileId],
  });
  if (row.rows.length === 0) throw new Error(`File ${a.fileId} not found`);
  const f = row.rows[0];
  const nodeId = f.node_id as string;
  const remoteName = f.remote_name as string | null;
  const remotePath = f.remote_path as string | null;
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

  const hash = sha256Buffer(content);
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
}

async function fileExistsAt(path: string): Promise<boolean> {
  try {
    await fsStat(path);
    return true;
  } catch {
    return false;
  }
}

async function localHashFor(path: string, fileId: string): Promise<string | null> {
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
  const h = await sha256File(path);
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

  for (const row of rowsRes.rows) {
    const fileId = row.id as string;
    const nodeId = row.node_id as string;
    const filename = row.filename as string;
    const remoteName = (row.remote_name as string | null) ?? null;
    const remotePath = (row.remote_path as string | null) ?? null;
    const isNative = Number(row.is_native_format) === 1;

    let info: NodeInfo;
    try {
      info = await resolveNodeInfo(db, nodeId);
    } catch {
      // Node gone -> treat as orphan, best-effort cleanup.
      out.orphan.push({
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
      });
      continue;
    }

    const mirrorRoot = await getMirrorPath(a.userId, nodeId);
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

    if (isNative) {
      out.native.push({ ...base, class: "native" });
      continue;
    }
    if (!remoteName || !remotePath) {
      out.orphan.push({ ...base, class: "orphan" });
      continue;
    }

    const state = await getFileState(fileId);
    base.last_synced_hash = state?.last_synced_hash ?? null;
    const localHash = localPath ? await localHashFor(localPath, fileId) : null;
    base.local_hash = localHash;
    const rs = await cachedRemoteStat(db, fileId, remoteName, remotePath);
    if (rs === null) {
      out.orphan.push({ ...base, class: "orphan" });
      continue;
    }
    base.remote_hash = rs.hash;

    if (!rs.exists) {
      out.orphan.push({ ...base, class: "orphan" });
      continue;
    }

    if (localHash === null) {
      if (base.last_synced_hash) {
        out.deleted_local.push({ ...base, class: "clean" });
      } else {
        // Haven't pulled yet — this is essentially a new_remote scenario; but
        // since the row exists we keep it as an orphan candidate.
        out.orphan.push({ ...base, class: "orphan" });
      }
      continue;
    }

    const last = base.last_synced_hash;
    const remoteUnknown = rs.hash === null;
    const remoteMatchesLast = rs.hash !== null ? rs.hash === last : last !== null;
    const localMatchesLast = localHash === last;

    if (remoteUnknown && localMatchesLast) {
      out.clean.push({ ...base, class: "clean" });
      continue;
    }
    if (remoteUnknown && !localMatchesLast) {
      out.push_candidates.push({ ...base, class: "push" });
      continue;
    }

    if (localMatchesLast && remoteMatchesLast) out.clean.push({ ...base, class: "clean" });
    else if (!localMatchesLast && remoteMatchesLast)
      out.push_candidates.push({ ...base, class: "push" });
    else if (localMatchesLast && !remoteMatchesLast)
      out.pull_candidates.push({ ...base, class: "pull" });
    else out.conflicts.push({ ...base, class: "conflict" });
  }

  if (a.includeDiscovery !== false) {
    await runDiscovery(db, a, out);
  }

  return out;
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

  // Collect file-row paths per node to identify NEW_LOCAL/NEW_REMOTE.
  const knownRemoteByNode = new Map<string, { remoteName: string; remotePath: string }[]>();
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

    // Discovery on remote: list adapter paths under buildNodeRoot, skip known.
    const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
    if (!remoteName) continue;
    try {
      const adapter = await getAdapter(db, remoteName);
      const entries = await adapter.list(nodeRoot);
      const knownRemotePaths = new Set(knownForNode.map((x) => x.remotePath));
      for (const e of entries) {
        if (!knownRemotePaths.has(e.path)) {
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

