// Central-mode sync engine (teammate mirrors). Same responsibilities as the
// local engine -- status classification, push/pull, registration, reconcile,
// mirror creation -- but the graph plane comes from the central server (via
// CentralClient) and bytes move through the server's file endpoints. All
// disk work, the per-device sync.db (file_state, local_mirrors) and the
// watcher stay local and are shared with the local engine unchanged.
//
// Deliberate v1 scope cuts (documented in the plan):
//   - remote truth is ALWAYS files.current_remote_hash from sync-info
//     ("hash is identity"; Turso is canonical) -- no per-file adapter.stat.
//   - no new_remote discovery and no move detection (owner-side features).
//   - no remote folder scaffold on mirror create; folders materialize when
//     the first file is pushed (adapter.put resolves parents server-side).

import { mkdir, readFile, writeFile, stat as fsStat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { CentralClient } from "./client.js";
import { CentralHttpError } from "./client.js";
import { localHashFor } from "../engine.js";
import type {
  StatusResult,
  StatusFileEntry,
  NewLocalEntry,
  RegisterLocalFileResult,
} from "../engine.js";
import { getFileState, upsertFileState } from "../local-db.js";
import { getMirrorPath, listUserMirrors, registerMirror } from "../mirror-registry.js";
import {
  buildNodeRoot,
  deriveLocalPath,
  subpathFromMirror,
  type NodeInfo,
  type Section,
} from "../remote-path.js";
import { loadMirrorIgnore, type MirrorIgnore } from "../mirror-ignore.js";
import { md5Buffer, sha256Buffer, statForCache } from "../hash.js";
import type { NodeSyncInfo, SyncInfoFile } from "../sync-remote-api.js";
import type {
  SyncPendingNode,
  SyncPendingResponse,
  SyncRunResponse,
} from "../../../shared/api-types.js";
import { MirrorCreateError, type CreateMirrorResult } from "../mirror-create.js";
import { ensureUnderRoot, PathTraversalError } from "../../../shared/safe-path.js";
import { resolvePortuniRoot, resolveGuardScriptPath } from "../../write-scope.js";
import { materializeScopeConfig } from "../../scope-materialize.js";

const TYPE_PLURAL: Record<string, string> = {
  project: "projects",
  process: "processes",
  area: "areas",
  principle: "principles",
};

function toNodeInfo(si: NodeSyncInfo): NodeInfo {
  return {
    orgSyncKey: si.node.org_sync_key,
    nodeType: si.node.type,
    nodeSyncKey: si.node.sync_key,
  };
}

interface NodeContext {
  si: NodeSyncInfo;
  info: NodeInfo;
  nodeRoot: string;
  mirrorRoot: string | null;
}

async function loadNodeContext(
  client: CentralClient,
  userId: string,
  nodeId: string,
): Promise<NodeContext> {
  const si = await client.syncInfo(nodeId);
  const info = toNodeInfo(si);
  return {
    si,
    info,
    nodeRoot: buildNodeRoot(info),
    mirrorRoot: await getMirrorPath(userId, nodeId),
  };
}

// Mirror-relative "<section>[/<subpath>]/<filename>" for a local path inside
// the mirror. NFC-normalized (matches the engine's identity rules).
function relPathFor(mirrorRoot: string, absPath: string): string | null {
  const sub = subpathFromMirror(mirrorRoot, absPath);
  if (!sub) return null;
  const subpath = sub.subpath?.normalize("NFC") ?? null;
  const filename = sub.filename.normalize("NFC");
  return subpath ? `${sub.section}/${subpath}/${filename}` : `${sub.section}/${filename}`;
}

// ---------------------------------------------------------------------------
// Status scan
// ---------------------------------------------------------------------------

export interface StatusCentralArgs {
  userId: string;
  nodeId: string;
  // Fast: classify from file_state.cached_local_hash only (UI hot path; the
  // watcher keeps the cache current). Slow: re-hash local files (mtime/size
  // guarded) for ground truth before a sync run.
  fast?: boolean;
  includeDiscovery?: boolean;
}

async function classifyRecord(
  ctx: NodeContext,
  rec: SyncInfoFile,
  fast: boolean,
): Promise<{ bucket: keyof StatusResult; entry: StatusFileEntry }> {
  const localPath =
    ctx.mirrorRoot && rec.remote_path
      ? (() => {
          try {
            return deriveLocalPath({
              mirrorRoot: ctx.mirrorRoot as string,
              nodeRoot: ctx.nodeRoot,
              remotePath: rec.remote_path as string,
            });
          } catch {
            return null;
          }
        })()
      : null;

  const base: StatusFileEntry = {
    file_id: rec.id,
    node_id: ctx.si.node.id,
    filename: rec.filename,
    local_path: localPath,
    remote_name: ctx.si.remote_name,
    remote_path: rec.remote_path,
    local_hash: null,
    remote_hash: null,
    last_synced_hash: null,
    class: "clean",
  };

  if (rec.is_native_format) return { bucket: "native", entry: { ...base, class: "native" } };
  if (!ctx.si.remote_name || !rec.remote_path) {
    return { bucket: "orphan", entry: { ...base, class: "orphan" } };
  }

  const state = await getFileState(rec.id);
  base.last_synced_hash = state?.last_synced_hash ?? null;
  const remoteHash = rec.current_remote_hash;
  const localHash = fast
    ? (state?.cached_local_hash ?? null)
    : localPath
      ? await localHashFor(localPath, rec.id, remoteHash)
      : null;
  base.local_hash = localHash;
  base.remote_hash = remoteHash;

  const remoteExists = remoteHash !== null;
  if (!remoteExists) {
    // Registered but never pushed: pending upload reads as push; a file whose
    // remote vanished after a sync, or with no local content, stays orphan.
    if (localHash !== null && base.last_synced_hash === null) {
      return { bucket: "push_candidates", entry: { ...base, class: "push" } };
    }
    return { bucket: "orphan", entry: { ...base, class: "orphan" } };
  }

  if (localHash === null) {
    if (base.last_synced_hash) {
      return { bucket: "deleted_local", entry: { ...base, class: "clean" } };
    }
    // Remote content exists but this device never synced it -> fetchable.
    return { bucket: "pull_candidates", entry: { ...base, class: "pull" } };
  }

  const last = base.last_synced_hash;

  // No baseline on this device: never guess. Identical content is provably
  // clean; anything else needs a human decision.
  if (last === null) {
    if (remoteHash !== null && remoteHash === localHash) {
      return { bucket: "clean", entry: { ...base, class: "clean" } };
    }
    return { bucket: "conflicts", entry: { ...base, class: "conflict" } };
  }

  const remoteMatchesLast = remoteHash === last;
  const localMatchesLast = localHash === last;

  if (localMatchesLast && remoteMatchesLast) return { bucket: "clean", entry: { ...base, class: "clean" } };
  if (!localMatchesLast && remoteMatchesLast)
    return { bucket: "push_candidates", entry: { ...base, class: "push" } };
  if (localMatchesLast && !remoteMatchesLast)
    return { bucket: "pull_candidates", entry: { ...base, class: "pull" } };
  return { bucket: "conflicts", entry: { ...base, class: "conflict" } };
}

export async function statusScanCentral(
  client: CentralClient,
  a: StatusCentralArgs,
): Promise<StatusResult> {
  const ctx = await loadNodeContext(client, a.userId, a.nodeId);
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
  for (const rec of ctx.si.files) {
    const r = await classifyRecord(ctx, rec, a.fast ?? false);
    (out[r.bucket] as StatusFileEntry[]).push(r.entry);
  }
  if (a.includeDiscovery !== false) {
    out.new_local = await untrackedForContext(ctx);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Local discovery (untracked files in the mirror)
// ---------------------------------------------------------------------------

async function untrackedForContext(ctx: NodeContext): Promise<NewLocalEntry[]> {
  if (!ctx.mirrorRoot) return [];
  const known = new Set<string>();
  for (const rec of ctx.si.files) {
    if (!rec.remote_path) continue;
    try {
      known.add(
        deriveLocalPath({
          mirrorRoot: ctx.mirrorRoot,
          nodeRoot: ctx.nodeRoot,
          remotePath: rec.remote_path,
        }).normalize("NFC"),
      );
    } catch {
      /* unmappable record -- ignore */
    }
  }
  const out: NewLocalEntry[] = [];
  const isIgnored = await loadMirrorIgnore(ctx.mirrorRoot);
  for (const section of ["wip", "outputs", "resources"] as Section[]) {
    await walkUntracked(join(ctx.mirrorRoot, section), ctx, known, isIgnored, out);
  }
  return out;
}

async function walkUntracked(
  dir: string,
  ctx: NodeContext,
  known: Set<string>,
  isIgnored: MirrorIgnore,
  out: NewLocalEntry[],
): Promise<void> {
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
      await walkUntracked(p, ctx, known, isIgnored, out);
    } else if (ent.isFile()) {
      if (known.has(p.normalize("NFC"))) continue;
      const sub = subpathFromMirror(ctx.mirrorRoot as string, p);
      if (!sub) continue;
      out.push({
        node_id: ctx.si.node.id,
        local_path: p,
        section: sub.section,
        subpath: sub.subpath,
        filename: sub.filename,
        hash: "",
      });
    }
  }
}

export async function listUntrackedLocalCentral(
  client: CentralClient,
  a: { userId: string; nodeId: string },
): Promise<NewLocalEntry[]> {
  const ctx = await loadNodeContext(client, a.userId, a.nodeId);
  return untrackedForContext(ctx);
}

// ---------------------------------------------------------------------------
// Register / push / pull
// ---------------------------------------------------------------------------

export async function registerLocalFileCentral(
  client: CentralClient,
  a: { userId: string; nodeId: string; localPath: string },
): Promise<RegisterLocalFileResult> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) {
    throw new Error(`Node ${a.nodeId} has no local mirror. Register via portuni_mirror first.`);
  }
  const relPath = relPathFor(mirrorRoot, a.localPath);
  if (!relPath) {
    throw new Error(
      `Path is outside the mirror's tracked sections (wip/outputs/resources): ${a.localPath}`,
    );
  }
  const reg = await client.registerFile(a.nodeId, relPath);
  const hash = (await localHashFor(a.localPath, reg.id, null)) ?? "";
  return {
    file_id: reg.id,
    remote_name: reg.remote_name,
    remote_path: reg.remote_path,
    local_path: a.localPath,
    hash,
  };
}

// Push one classified push-candidate. Conflict-safe: re-reads the current
// remote bytes to (a) obtain the sha256 the PUT's optimistic check needs and
// (b) verify the remote still matches this device's baseline -- a remote that
// moved between scan and push must not be clobbered.
async function pushEntryCentral(
  client: CentralClient,
  a: { userId: string; nodeId: string; mirrorRoot: string; entry: StatusFileEntry },
): Promise<void> {
  const localPath = a.entry.local_path;
  if (!localPath) throw new Error("push candidate has no local path");
  const relPath = relPathFor(a.mirrorRoot, localPath);
  if (!relPath) throw new Error(`path left the mirror sections: ${localPath}`);

  let baseVersion: string | undefined;
  try {
    const cur = await client.getFileRaw(a.nodeId, relPath);
    const baseline = a.entry.last_synced_hash;
    if (baseline !== null && cur.canonicalHash !== baseline) {
      throw new Error(
        `remote changed since the last scan (expected baseline ${baseline}, remote is ${cur.canonicalHash}) -- rescan and resolve`,
      );
    }
    if (baseline === null) {
      // Fresh registration but the remote already has bytes: only a
      // byte-identical remote is safe to overwrite.
      const local = await readFile(localPath);
      const localInCanonical =
        cur.canonicalHash.length === 32 ? md5Buffer(local) : sha256Buffer(local);
      if (localInCanonical !== cur.canonicalHash) {
        throw new Error("remote already has different content for a never-synced file -- resolve manually");
      }
    }
    baseVersion = cur.version;
  } catch (e) {
    if (e instanceof CentralHttpError && (e.status === 404 || e.code === "NOT_FOUND")) {
      baseVersion = undefined; // brand-new remote object
    } else {
      throw e;
    }
  }

  const bytes = await readFile(localPath);
  const put = await client.putFileRaw(a.nodeId, relPath, bytes, { baseVersion });
  const fsInfo = await statForCache(localPath);
  await upsertFileState({
    file_id: a.entry.file_id,
    last_synced_hash: put.canonicalHash,
    last_synced_at: new Date().toISOString(),
    cached_local_hash: put.canonicalHash,
    cached_mtime: fsInfo.mtime,
    cached_size: fsInfo.size,
  });
}

export async function pullFileCentral(
  client: CentralClient,
  a: {
    userId: string;
    nodeId: string;
    entry: StatusFileEntry;
    force?: boolean;
  },
): Promise<{ file_id: string; local_path: string; hash: string }> {
  const ctx = await loadNodeContext(client, a.userId, a.nodeId);
  if (!ctx.mirrorRoot) {
    throw new Error(`Node ${a.nodeId} has no local mirror on this device.`);
  }
  if (!a.entry.remote_path) throw new Error(`file ${a.entry.file_id} has no remote binding`);
  const localPath =
    a.entry.local_path ??
    deriveLocalPath({
      mirrorRoot: ctx.mirrorRoot,
      nodeRoot: ctx.nodeRoot,
      remotePath: a.entry.remote_path,
    });
  const relPath = relPathFor(ctx.mirrorRoot, localPath);
  if (!relPath) throw new Error(`derived path left the mirror sections: ${localPath}`);

  const cur = await client.getFileRaw(a.nodeId, relPath);

  // Dirty-local guard (same contract as engine.pullFile): overwriting is only
  // safe when the local copy matches this device's synced baseline or already
  // equals the incoming bytes.
  const exists = await fsStat(localPath).then(
    () => true,
    () => false,
  );
  if (!a.force && exists) {
    const state = await getFileState(a.entry.file_id);
    const baseline = state?.last_synced_hash ?? null;
    const local = await readFile(localPath);
    const localCur =
      cur.canonicalHash.length === 32 ? md5Buffer(local) : sha256Buffer(local);
    const dirty =
      localCur !== cur.canonicalHash && (baseline === null || localCur !== baseline);
    if (dirty) {
      throw new Error(
        `File ${a.entry.file_id} has local changes that were never pushed from this device (${localPath}). Sync them first, or force the pull.`,
      );
    }
  }

  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, cur.bytes);
  const fsInfo = await statForCache(localPath);
  await upsertFileState({
    file_id: a.entry.file_id,
    last_synced_hash: cur.canonicalHash,
    last_synced_at: new Date().toISOString(),
    cached_local_hash: cur.canonicalHash,
    cached_mtime: fsInfo.mtime,
    cached_size: fsInfo.size,
  });
  return { file_id: a.entry.file_id, local_path: localPath, hash: cur.canonicalHash };
}

// ---------------------------------------------------------------------------
// Reconcile (watcher callback)
// ---------------------------------------------------------------------------

export type ReconcileCentralResult = {
  action: "ignored" | "noop" | "registered" | "rehashed" | "deleted";
  file_id?: string;
};

export async function reconcilePathCentral(
  client: CentralClient,
  a: { userId: string; nodeId: string; absPath: string },
): Promise<ReconcileCentralResult> {
  const mirrorRoot = await getMirrorPath(a.userId, a.nodeId);
  if (!mirrorRoot) return { action: "noop" };

  const isIgnored = await loadMirrorIgnore(mirrorRoot);
  if (isIgnored(a.absPath)) return { action: "ignored" };

  const relPath = relPathFor(mirrorRoot, a.absPath);
  if (!relPath) return { action: "ignored" };

  let ctx: NodeContext;
  try {
    ctx = await loadNodeContext(client, a.userId, a.nodeId);
  } catch {
    return { action: "noop" };
  }

  // Match the disk path to a tracked record via its derived local path.
  const target = a.absPath.normalize("NFC");
  let rec: SyncInfoFile | null = null;
  for (const f of ctx.si.files) {
    if (!f.remote_path) continue;
    try {
      const lp = deriveLocalPath({
        mirrorRoot,
        nodeRoot: ctx.nodeRoot,
        remotePath: f.remote_path,
      }).normalize("NFC");
      if (lp === target) {
        rec = f;
        break;
      }
    } catch {
      /* unmappable record */
    }
  }

  const st = await fsStat(a.absPath).then(
    (s) => ({ exists: true, isFile: s.isFile() }),
    () => ({ exists: false, isFile: false }),
  );

  if (!rec) {
    if (!st.exists || !st.isFile) return { action: "noop" };
    const r = await registerLocalFileCentral(client, {
      userId: a.userId,
      nodeId: a.nodeId,
      localPath: a.absPath,
    });
    return { action: "registered", file_id: r.file_id };
  }

  if (st.exists && st.isFile) {
    await localHashFor(a.absPath, rec.id, rec.current_remote_hash);
    return { action: "rehashed", file_id: rec.id };
  }

  const existing = await getFileState(rec.id);
  await upsertFileState({
    file_id: rec.id,
    last_synced_hash: existing?.last_synced_hash ?? null,
    last_synced_at: existing?.last_synced_at ?? null,
    cached_local_hash: null,
    cached_mtime: null,
    cached_size: null,
  });
  return { action: "deleted", file_id: rec.id };
}

// ---------------------------------------------------------------------------
// Sync run (push + pull + adopt) -- the POST /nodes/:id/sync equivalent
// ---------------------------------------------------------------------------

export async function syncRunCentral(
  client: CentralClient,
  a: { userId: string; nodeId: string },
): Promise<SyncRunResponse> {
  const ctx = await loadNodeContext(client, a.userId, a.nodeId);
  const scan = await statusScanCentral(client, {
    userId: a.userId,
    nodeId: a.nodeId,
    includeDiscovery: true,
    fast: false,
  });
  const result: SyncRunResponse = {
    pushed: [],
    pulled: [],
    adopted: [],
    conflicts: [],
    deleted_local: [],
    errors: [],
    skipped: [],
  };
  const mirrorRoot = ctx.mirrorRoot;

  for (const e of scan.push_candidates) {
    if (!e.local_path || !mirrorRoot) {
      result.errors.push({
        file_id: e.file_id,
        filename: e.filename,
        error: "no local path -- node has no mirror on this device",
      });
      continue;
    }
    try {
      await pushEntryCentral(client, { userId: a.userId, nodeId: a.nodeId, mirrorRoot, entry: e });
      result.pushed.push({ file_id: e.file_id, filename: e.filename });
    } catch (err) {
      result.errors.push({ file_id: e.file_id, filename: e.filename, error: String(err) });
    }
  }

  for (const e of scan.pull_candidates) {
    try {
      await pullFileCentral(client, { userId: a.userId, nodeId: a.nodeId, entry: e });
      result.pulled.push({ file_id: e.file_id, filename: e.filename });
    } catch (err) {
      result.errors.push({ file_id: e.file_id, filename: e.filename, error: String(err) });
    }
  }

  for (const e of scan.deleted_local) {
    result.deleted_local.push({ file_id: e.file_id, filename: e.filename });
  }
  for (const e of scan.conflicts) {
    result.conflicts.push({ file_id: e.file_id, filename: e.filename });
  }
  for (const e of [...scan.clean, ...scan.orphan, ...scan.native]) {
    result.skipped.push({ file_id: e.file_id, filename: e.filename, sync_class: e.class });
  }

  // Adopt untracked: register (record-only), then push the bytes.
  for (const u of scan.new_local) {
    try {
      const reg = await registerLocalFileCentral(client, {
        userId: a.userId,
        nodeId: a.nodeId,
        localPath: u.local_path,
      });
      if (mirrorRoot) {
        await pushEntryCentral(client, {
          userId: a.userId,
          nodeId: a.nodeId,
          mirrorRoot,
          entry: {
            file_id: reg.file_id,
            node_id: a.nodeId,
            filename: u.filename,
            local_path: u.local_path,
            remote_name: reg.remote_name,
            remote_path: reg.remote_path,
            local_hash: reg.hash,
            remote_hash: null,
            last_synced_hash: null,
            class: "push",
          },
        });
      }
      result.adopted.push({ file_id: reg.file_id, filename: u.filename });
    } catch (err) {
      result.errors.push({ file_id: "", filename: u.filename, error: String(err) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cross-mirror pending aggregate -- GET /sync/pending equivalent
// ---------------------------------------------------------------------------

const PENDING_SCAN_CONCURRENCY = 8;

export async function computeSyncPendingCentral(
  client: CentralClient,
  userId: string,
): Promise<SyncPendingResponse> {
  const mirrors = await listUserMirrors(userId);

  const scanOne = async (m: (typeof mirrors)[number]): Promise<SyncPendingNode | null> => {
    let si: NodeSyncInfo;
    try {
      si = await client.syncInfo(m.node_id);
    } catch {
      return null; // node gone or not visible -- skip, never break the overview
    }
    const scan = await statusScanCentral(client, {
      userId,
      nodeId: m.node_id,
      includeDiscovery: true,
      fast: true,
    }).catch(() => null);
    if (!scan) return null;
    const push = scan.push_candidates.length;
    const conflict = scan.conflicts.length;
    const untracked = scan.new_local.length;
    const orphan = scan.orphan.length;
    const deleted_local = scan.deleted_local.length;
    const total = push + conflict + untracked + orphan + deleted_local;
    if (total === 0) return null;
    return {
      node_id: m.node_id,
      node_name: si.node.name,
      node_type: si.node.type,
      push,
      conflict,
      untracked,
      orphan,
      deleted_local,
      total,
    };
  };

  const nodes: SyncPendingNode[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= mirrors.length) return;
      const n = await scanOne(mirrors[i]);
      if (n) nodes.push(n);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PENDING_SCAN_CONCURRENCY, mirrors.length) }, () => worker()),
  );

  nodes.sort((a, b) => b.total - a.total);
  const total = nodes.reduce((s, n) => s + n.total, 0);
  return { nodes, total };
}

// ---------------------------------------------------------------------------
// Mirror creation -- POST /nodes/:id/mirror equivalent
// ---------------------------------------------------------------------------

export async function createMirrorForNodeCentral(
  client: CentralClient,
  userId: string,
  args: { nodeId: string; customPath?: string },
): Promise<CreateMirrorResult> {
  let si: NodeSyncInfo;
  try {
    si = await client.syncInfo(args.nodeId);
  } catch (e) {
    if (e instanceof CentralHttpError && e.status === 404) {
      throw new MirrorCreateError(`node ${args.nodeId} not found`, "NODE_NOT_FOUND");
    }
    throw e;
  }

  const existing = await getMirrorPath(userId, args.nodeId);
  if (existing && !args.customPath) {
    return {
      node_id: args.nodeId,
      local_path: existing,
      created: false,
      subdirs: ["outputs/", "wip/", "resources/"],
      remote_scaffold: { scaffolded: [], remote_name: si.remote_name },
      scope_config: { written: [], errors: [], portuni_root: null },
    };
  }

  const root = process.env.PORTUNI_WORKSPACE_ROOT?.replace(/^~/, homedir());
  if (!root) {
    throw new MirrorCreateError(
      "PORTUNI_WORKSPACE_ROOT env variable is not set",
      "WORKSPACE_ROOT_UNSET",
    );
  }

  let localPath: string;
  if (args.customPath) {
    try {
      localPath = ensureUnderRoot(root, args.customPath);
    } catch (e) {
      if (e instanceof PathTraversalError) {
        throw new MirrorCreateError(
          `custom_path must be inside PORTUNI_WORKSPACE_ROOT (${root})`,
          "PATH_TRAVERSAL",
        );
      }
      throw e;
    }
  } else if (si.node.type === "organization") {
    localPath = join(root, si.node.sync_key);
  } else {
    const typePlural = TYPE_PLURAL[si.node.type] ?? si.node.type;
    localPath = si.node.org_sync_key
      ? join(root, si.node.org_sync_key, typePlural, si.node.sync_key)
      : join(root, typePlural, si.node.sync_key);
  }

  const mirrors = await listUserMirrors(userId);
  const taken = mirrors.find((m) => m.local_path === localPath && m.node_id !== args.nodeId);
  if (taken) {
    throw new MirrorCreateError(
      `path ${localPath} is already registered as the mirror of node ${taken.node_id}`,
      "PATH_IN_USE",
    );
  }

  for (const subdir of ["outputs", "wip", "resources"]) {
    await mkdir(join(localPath, subdir), { recursive: true });
  }
  await registerMirror(userId, args.nodeId, localPath);

  // Scope config for the new mirror + regen of siblings. Data sources come
  // from the central server (the sidecar has no graph db in agent mode).
  const scopeConfig = await materializeAndRegenCentral(client, userId, localPath, args.nodeId);

  return {
    node_id: args.nodeId,
    local_path: localPath,
    created: true,
    subdirs: ["outputs/", "wip/", "resources/"],
    // v1: no remote scaffold from the agent; folders appear on first push.
    remote_scaffold: { scaffolded: [], remote_name: si.remote_name },
    scope_config: scopeConfig,
  };
}

async function materializeAndRegenCentral(
  client: CentralClient,
  userId: string,
  newMirrorPath: string,
  newNodeId: string,
): Promise<{ written: string[]; errors: { path: string; message: string }[]; portuni_root: string | null }> {
  const allMirrors = await listUserMirrors(userId);
  const paths = allMirrors.map((m) => m.local_path);
  if (!paths.includes(newMirrorPath)) paths.push(newMirrorPath);

  const portuniRoot =
    resolvePortuniRoot({
      envValue: process.env.PORTUNI_ROOT ?? null,
      knownMirrors: paths,
    }) ?? null;
  if (!portuniRoot) return { written: [], errors: [], portuni_root: null };

  const guardScriptPath = resolveGuardScriptPath();
  const aggregated: { written: string[]; errors: { path: string; message: string }[] } = {
    written: [],
    errors: [],
  };

  const dataSourcesFor = async (nodeId: string) => {
    try {
      return await client.dataSources(nodeId);
    } catch {
      return [];
    }
  };

  for (const m of allMirrors) {
    const others = paths.filter((p) => p !== m.local_path);
    const r = await materializeScopeConfig({
      currentMirror: m.local_path,
      nodeId: m.node_id,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
      dataSources: await dataSourcesFor(m.node_id),
    });
    aggregated.written.push(...r.written);
    aggregated.errors.push(...r.errors);
  }
  if (!allMirrors.find((m) => m.node_id === newNodeId)) {
    const others = paths.filter((p) => p !== newMirrorPath);
    const r = await materializeScopeConfig({
      currentMirror: newMirrorPath,
      nodeId: newNodeId,
      otherMirrors: others,
      portuniRoot,
      guardScriptPath,
      dataSources: await dataSourcesFor(newNodeId),
    });
    aggregated.written.push(...r.written);
    aggregated.errors.push(...r.errors);
  }

  return { ...aggregated, portuni_root: portuniRoot };
}
