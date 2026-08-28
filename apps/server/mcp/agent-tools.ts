// Device-local MCP tool dispatch for agent mode. These five tools touch the
// local disk directly (mirror creation, file copy-in/upload/download, local
// discovery), so they must run on the device that owns the mirror -- the
// central server has no local file plane (see mirror-create.ts's
// DEVICE_LOCAL_HINT and its WORKSPACE_ROOT_UNSET error). Everything else is
// proxied to central unchanged (agent-transport.ts, a later task).
//
// Constraint: nothing in this module may call getDb() -- the agent has no
// graph DB, only a CentralClient (network) and the local per-device
// sync.db (mirror registry + file_state), both already central-mode-safe.
//
// Each handler returns the SAME JSON payload shape as the corresponding
// tool in apps/server/mcp/tools/*.ts, so a caller cannot tell which plane
// served the call.

import type { CentralClient } from "../domain/sync/central/client.js";
import { CentralHttpError } from "../domain/sync/central/client.js";
import {
  createMirrorForNodeCentral,
  statusScanCentral,
  storeFileCentral,
  pullFileCentral,
  registerLocalFileCentral,
  listUntrackedLocalCentral,
} from "../domain/sync/central/engine-central.js";
import { MirrorCreateError } from "../domain/sync/mirror-create.js";
import { getMirrorPath, listUserMirrors } from "../domain/sync/mirror-registry.js";
import { getLocalMirror } from "../domain/sync/local-db.js";
import { buildNodeRoot, deriveLocalPath } from "../domain/sync/remote-path.js";
import type { StatusFileEntry, StatusResult, NewLocalEntry } from "../domain/sync/engine.js";
import type { NodeSyncInfo } from "../domain/sync/sync-remote-api.js";

export const LOCAL_TOOLS: ReadonlySet<string> = new Set([
  "portuni_mirror",
  "portuni_status",
  "portuni_store",
  "portuni_pull",
  "portuni_adopt_files",
]);

type LocalHandler = (
  client: CentralClient,
  userId: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

// Locates which of this user's mirrored nodes a file_id belongs to.
// CentralClient has no "look up by file id" endpoint (sync-info is scoped
// per node), so -- like computeSyncPendingCentral's cross-mirror
// aggregate -- this fans out to every mirrored node's sync-info. Builds
// just enough of a StatusFileEntry for pullFileCentral to derive the local
// path itself.
async function findEntryByFileId(
  client: CentralClient,
  userId: string,
  fileId: string,
): Promise<{ nodeId: string; entry: StatusFileEntry } | null> {
  const mirrors = await listUserMirrors(userId);
  if (mirrors.length === 0) return null;
  const infos = await client.syncInfoBatch(mirrors.map((m) => m.node_id));
  for (const si of infos) {
    const rec = si.files.find((f) => f.id === fileId);
    if (rec) {
      return {
        nodeId: si.node.id,
        entry: {
          file_id: rec.id,
          node_id: si.node.id,
          filename: rec.filename,
          local_path: null,
          remote_name: si.remote_name,
          remote_path: rec.remote_path,
          local_hash: null,
          remote_hash: rec.current_remote_hash,
          last_synced_hash: null,
          class: "pull",
        },
      };
    }
  }
  return null;
}

type PreviewStatus = "unchanged" | "updated" | "conflict" | "orphan" | "native";

function toPreviewEntry(e: StatusFileEntry, status: PreviewStatus) {
  return {
    file_id: e.file_id,
    filename: e.filename,
    status,
    remote_hash: e.remote_hash,
    local_hash: e.local_hash,
    last_synced_hash: e.last_synced_hash,
  };
}

const HANDLERS: Record<string, LocalHandler> = {
  async portuni_mirror(client, userId, args) {
    const result = await createMirrorForNodeCentral(client, userId, {
      nodeId: args.node_id as string,
      customPath: args.custom_path as string | undefined,
    });
    return {
      node_id: result.node_id,
      local_path: result.local_path,
      subdirs: result.subdirs,
      remote_scaffold: result.remote_scaffold,
      scope_config: result.scope_config,
    };
  },

  async portuni_status(client, userId, args) {
    // Same default as the local tool (sync-status.ts): discovery on unless
    // the caller explicitly opts out.
    const includeDiscovery = args.include_discovery !== false;
    const nodeId = args.node_id as string | undefined;
    if (nodeId) {
      return statusScanCentral(client, { userId, nodeId, includeDiscovery, fast: false });
    }
    // No node_id: scan across every mirror this user has and aggregate the
    // buckets -- the central-mode analog of local statusScan's cross-mirror
    // sweep. Fans out over listUserMirrors, same enumeration source as
    // computeSyncPendingCentral (the local mirror registry, not a graph db).
    const mirrors = await listUserMirrors(userId);
    const agg: StatusResult = {
      clean: [],
      push_candidates: [],
      pull_candidates: [],
      conflicts: [],
      orphan: [],
      native: [],
      new_local: [],
      new_remote: [],
      deleted_local: [],
      deleted_remote: [],
      moved: [],
    };
    for (const m of mirrors) {
      const r = await statusScanCentral(client, {
        userId,
        nodeId: m.node_id,
        includeDiscovery,
        fast: false,
      });
      agg.clean.push(...r.clean);
      agg.push_candidates.push(...r.push_candidates);
      agg.pull_candidates.push(...r.pull_candidates);
      agg.conflicts.push(...r.conflicts);
      agg.orphan.push(...r.orphan);
      agg.native.push(...r.native);
      agg.new_local.push(...r.new_local);
      agg.new_remote.push(...r.new_remote);
      agg.deleted_local.push(...r.deleted_local);
      agg.deleted_remote.push(...r.deleted_remote);
      agg.moved.push(...r.moved);
    }
    return agg;
  },

  async portuni_store(client, userId, args) {
    // storeFileCentral copies an outside-the-mirror source into the correct
    // section (status/subpath routing) before pushing, and the server derives
    // files.status from that section -- so status and outside-mirror sources
    // both work on the agent plane, same as local storeFile.
    return storeFileCentral(client, {
      userId,
      nodeId: args.node_id as string,
      localPath: args.local_path as string,
      status: args.status as "wip" | "output" | undefined,
      subpath: (args.subpath as string | null | undefined) ?? undefined,
    });
  },

  async portuni_pull(client, userId, args) {
    const fileId = args.file_id as string | undefined;
    const nodeId = args.node_id as string | undefined;
    if (!fileId && !nodeId) {
      throw new Error("portuni_pull requires either file_id or node_id");
    }
    if (fileId) {
      const found = await findEntryByFileId(client, userId, fileId);
      if (!found) {
        throw new Error(`File ${fileId} not found on any mirror registered for this user`);
      }
      return pullFileCentral(client, {
        userId,
        nodeId: found.nodeId,
        entry: found.entry,
        force: args.force as boolean | undefined,
      });
    }
    // Preview mode: classify without modifying anything (mirrors
    // engine.ts's previewNode -- same bucket order and status labels).
    const scan = await statusScanCentral(client, {
      userId,
      nodeId: nodeId as string,
      includeDiscovery: false,
      fast: false,
    });
    return {
      files: [
        ...scan.clean.map((e) => toPreviewEntry(e, "unchanged")),
        ...scan.push_candidates.map((e) => toPreviewEntry(e, "updated")),
        ...scan.pull_candidates.map((e) => toPreviewEntry(e, "updated")),
        ...scan.conflicts.map((e) => toPreviewEntry(e, "conflict")),
        ...scan.orphan.map((e) => toPreviewEntry(e, "orphan")),
        ...scan.native.map((e) => toPreviewEntry(e, "native")),
      ],
    };
  },

  async portuni_adopt_files(client, userId, args) {
    // Registers untracked files found under the node's local mirror. With
    // `paths`, only matching untracked files are adopted -- matched by
    // mirror-relative path "<section>[/<subpath>]/<filename>" or by bare
    // filename; without it, every untracked local file is adopted.
    //
    // Unlike the owner-side local tool (whose `paths` are untracked *remote*
    // objects), there is no untracked-remote set to discover here: in central
    // mode the server tracks everything it stores, so "on the remote but not
    // in Portuni" cannot arise. Adoption is therefore over local files.
    // skipped.remote_path carries the local path of a failed entry (no remote
    // path exists for it yet).
    const nodeId = args.node_id as string;
    const wanted = (Array.isArray(args.paths) ? (args.paths as unknown[]) : [])
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.replace(/^\/+/, ""));
    const relOf = (e: NewLocalEntry): string =>
      e.subpath ? `${e.section}/${e.subpath}/${e.filename}` : `${e.section}/${e.filename}`;
    // Lenient match: a requested path selects a file when it equals, or ends
    // with, the file's mirror-relative path ("wip/foo.md") or bare filename.
    // Handles callers passing either form or a full remote path.
    const matchesWanted = (e: NewLocalEntry, w: string): boolean => {
      const rel = relOf(e);
      return (
        w === rel ||
        w === e.filename ||
        w.endsWith(`/${rel}`) ||
        w.endsWith(`/${e.filename}`)
      );
    };

    const untracked = await listUntrackedLocalCentral(client, { userId, nodeId });
    const selected =
      wanted.length === 0
        ? untracked
        : untracked.filter((e) => wanted.some((w) => matchesWanted(e, w)));

    const adopted: Array<{ file_id: string; remote_path: string; filename: string; hash: string }> =
      [];
    const skipped: Array<{ remote_path: string; reason: string }> = [];
    for (const entry of selected) {
      try {
        const reg = await registerLocalFileCentral(client, {
          userId,
          nodeId,
          localPath: entry.local_path,
        });
        adopted.push({
          file_id: reg.file_id,
          remote_path: reg.remote_path,
          filename: entry.filename,
          hash: reg.hash,
        });
      } catch (e) {
        skipped.push({
          remote_path: entry.local_path,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // Honestly report requested paths that matched no untracked file -- a
    // real "nothing to adopt there" signal, not a plane limitation.
    const notFound = wanted.filter((w) => !untracked.some((e) => matchesWanted(e, w)));
    return notFound.length > 0 ? { adopted, skipped, not_found: notFound } : { adopted, skipped };
  },
};

type ToolTextResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

// The seatbelt-granted read set in central mode: the session home node plus
// its depth-1 neighbours (Phase 3a grants exactly these real mirror paths).
// Read tools may only surface real paths for nodes in this set; deeper ad-hoc
// nodes are not readable and stay null. Best-effort: a central hiccup narrows
// the set to just home (never widens it beyond what the seatbelt grants).
async function seedNodeIds(
  client: CentralClient,
  homeNodeId: string | null,
): Promise<Set<string>> {
  if (!homeNodeId) return new Set();
  try {
    return new Set([homeNodeId, ...(await client.nodeNeighbours(homeNodeId))]);
  } catch {
    return new Set([homeNodeId]);
  }
}

// Overlay device-local fields onto a proxied portuni_get_node result. Central
// serves the node with local_mirror:null and files[].local_path:null (it has
// no device state); this fills them from the device that owns the mirror, so
// an agent in central mode sees the same paths a local session would.
//
// - local_mirror: from getLocalMirror (registration metadata for any node).
// - files[].local_path: derived real paths for nodes in the seatbelt read set
//   (home + depth-1 neighbours). Deeper ad-hoc nodes are not readable under
//   the sandbox, so their files stay null rather than pointing at a denied
//   path.
//
// Defensive: any shape it does not recognise passes through unchanged (error
// result, no text block, non-JSON text, no string id). A syncInfo failure
// leaves file paths null but still returns the local_mirror overlay.
export async function enrichGetNodeResult<T extends ToolTextResult>(
  client: CentralClient,
  userId: string,
  homeNodeId: string | null,
  result: T,
): Promise<T> {
  if (result.isError) return result;
  const first = result.content.find(
    (c) => c.type === "text" && typeof c.text === "string",
  );
  if (!first || typeof first.text !== "string") return result;
  let node: Record<string, unknown>;
  try {
    node = JSON.parse(first.text) as Record<string, unknown>;
  } catch {
    return result;
  }
  const id = typeof node.id === "string" ? node.id : null;
  if (!id) return result;

  if (!node.local_mirror) {
    const m = await getLocalMirror(userId, id);
    node.local_mirror = m
      ? { local_path: m.local_path, registered_at: m.registered_at }
      : null;
  }

  const mirrorPath =
    (node.local_mirror as { local_path?: string } | null)?.local_path ?? null;
  const seed = await seedNodeIds(client, homeNodeId);
  if (seed.has(id) && mirrorPath && Array.isArray(node.files)) {
    try {
      const si = await client.syncInfo(id);
      const nodeRoot = buildNodeRoot({
        orgSyncKey: si.node.org_sync_key,
        nodeType: si.node.type,
        nodeSyncKey: si.node.sync_key,
      });
      const remoteById = new Map<string, string | null>(
        si.files.map((f) => [f.id, f.remote_path]),
      );
      for (const f of node.files as Array<Record<string, unknown>>) {
        if (f.local_path || typeof f.id !== "string") continue;
        const remotePath = remoteById.get(f.id);
        if (!remotePath) continue;
        try {
          f.local_path = deriveLocalPath({ mirrorRoot: mirrorPath, nodeRoot, remotePath });
        } catch {
          /* derivation failed (path escapes mirror etc.) -- leave null */
        }
      }
    } catch {
      /* syncInfo unavailable -- leave file paths null, mirror already set */
    }
  }

  const text = JSON.stringify(node, null, 2);
  return {
    ...result,
    content: result.content.map((c) => (c === first ? { ...c, text } : c)),
  };
}

// Overlay device-local `local_path` (each node's readable mirror root) onto a
// proxied portuni_get_context result. Central serves every node's local_path
// null; the seatbelt makes the seed set (home + depth-1 neighbours) readable
// on their real mirrors, so fill local_path for those nodes (root or connected)
// with their OWN real mirror. Deeper ad-hoc nodes stay null (not readable).
// Any shape it does not recognise passes through unchanged.
export async function enrichGetContextResult<T extends ToolTextResult>(
  client: CentralClient,
  userId: string,
  homeNodeId: string | null,
  result: T,
): Promise<T> {
  if (result.isError || !homeNodeId) return result;
  const first = result.content.find(
    (c) => c.type === "text" && typeof c.text === "string",
  );
  if (!first || typeof first.text !== "string") return result;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(first.text) as Record<string, unknown>;
  } catch {
    return result;
  }
  const seed = await seedNodeIds(client, homeNodeId);
  const fillIfSeed = async (n: unknown): Promise<void> => {
    if (!n || typeof n !== "object") return;
    const node = n as Record<string, unknown>;
    if (typeof node.id !== "string" || node.local_path || !seed.has(node.id)) return;
    const p = await getMirrorPath(userId, node.id);
    if (p) node.local_path = p;
  };
  await fillIfSeed(payload.root);
  if (Array.isArray(payload.connected)) {
    for (const n of payload.connected) await fillIfSeed(n);
  }
  const text = JSON.stringify(payload, null, 2);
  return {
    ...result,
    content: result.content.map((c) => (c === first ? { ...c, text } : c)),
  };
}

export async function callLocalTool(
  client: CentralClient,
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`not a local tool: ${name}`);
  try {
    const result = await handler(client, userId, args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    if (e instanceof MirrorCreateError || e instanceof CentralHttpError) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Proxied disk mutations (GH #78)
// ---------------------------------------------------------------------------
//
// portuni_delete_file / portuni_move_file / portuni_rename_folder are NOT
// local tools -- their record/remote step must run on central. But central's
// engine-mutations local disk step no-ops there (getMirrorPath is null on the
// server), so the device that owns the mirror must apply it itself: snapshot
// the affected record(s) BEFORE the proxy (afterwards the record is gone),
// and after a successful confirmed result apply the rm/rename + file_state
// cleanup here. Best-effort by design: the record mutation already succeeded
// on central, and a failed local step degrades to the tombstone path (GH #79)
// instead of corrupting state.

const PROXIED_DISK_MUTATIONS = new Set([
  "portuni_delete_file",
  "portuni_move_file",
  "portuni_rename_folder",
]);

export function isProxiedDiskMutation(name: string): boolean {
  return PROXIED_DISK_MUTATIONS.has(name);
}

export interface DiskMutationSnapshot {
  tool: string;
  args: Record<string, unknown>;
  nodeId: string;
  mirrorRoot: string;
  nodeRoot: string;
  // delete/move: the affected record's remote path at snapshot time.
  fileId: string | null;
  oldRemotePath: string | null;
}

function nodeRootFor(si: NodeSyncInfo): string {
  return buildNodeRoot({
    orgSyncKey: si.node.org_sync_key,
    nodeType: si.node.type,
    nodeSyncKey: si.node.sync_key,
  });
}

// Resolve the record + mirror context the local disk step will need. Returns
// null when the call is a preview (unconfirmed), the record is unknown, or
// this device has no mirror for the node -- in all three cases there is
// nothing to do locally.
export async function snapshotForDiskMutation(
  client: CentralClient,
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<DiskMutationSnapshot | null> {
  if (!isProxiedDiskMutation(name)) return null;
  // A preview call mutates nothing -- skip the snapshot. delete/move confirm
  // via confirmed:true; rename_folder applies via dry_run:false (its schema
  // has no confirmed param and defaults to a dry run).
  const applies =
    name === "portuni_rename_folder" ? args.dry_run === false : args.confirmed === true;
  if (!applies) return null;

  if (name === "portuni_rename_folder") {
    const nodeId = args.node_id as string | undefined;
    if (!nodeId) return null;
    const mirrorRoot = await getMirrorPath(userId, nodeId);
    if (!mirrorRoot) return null;
    const si = await client.syncInfo(nodeId);
    return {
      tool: name,
      args,
      nodeId,
      mirrorRoot,
      nodeRoot: nodeRootFor(si),
      fileId: null,
      oldRemotePath: null,
    };
  }

  const fileId = args.file_id as string | undefined;
  if (!fileId) return null;
  const found = await findEntryByFileId(client, userId, fileId);
  if (!found?.entry.remote_path) return null;
  const mirrorRoot = await getMirrorPath(userId, found.nodeId);
  if (!mirrorRoot) return null;
  const si = await client.syncInfo(found.nodeId);
  return {
    tool: name,
    args,
    nodeId: found.nodeId,
    mirrorRoot,
    nodeRoot: nodeRootFor(si),
    fileId,
    oldRemotePath: found.entry.remote_path,
  };
}

function deriveOrNull(a: {
  mirrorRoot: string;
  nodeRoot: string;
  remotePath: string;
}): string | null {
  try {
    return deriveLocalPath(a);
  } catch {
    return null;
  }
}

// true when the local copy was moved; false when there was none (ENOENT).
// Anything else is thrown for the caller to log.
async function renameLocalBestEffort(oldPath: string, newPath: string): Promise<boolean> {
  const { mkdir: fsMkdir, rename: fsRename } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  try {
    await fsMkdir(dirname(newPath), { recursive: true });
    await fsRename(oldPath, newPath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return false;
  }
}

// Apply the disk step after central confirmed the mutation. resultText is the
// proxied tool result's JSON payload; anything that does not parse into a
// success shape (preview, repair_needed, error text) is a no-op.
//
// Returns the result text to hand back to the agent, or null to pass the
// central text through unchanged. For a move the central payload's
// `detail.local_done` / `new_local_path` describe the SERVER's disk (always
// false / null -- it has no mirror); they are rewritten here with what
// happened on this device so the agent is not told the local step failed.
export async function applyLocalAfterProxiedMutation(
  client: CentralClient,
  userId: string,
  snapshot: DiskMutationSnapshot,
  resultText: string,
): Promise<string | null> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(resultText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { rm } = await import("node:fs/promises");
  const { deleteFileState } = await import("../domain/sync/local-db.js");
  const { localHashFor } = await import("../domain/sync/engine.js");

  if (snapshot.tool === "portuni_delete_file") {
    if (parsed.status !== "ok" || !parsed.deleted_at) return null;
    if (!snapshot.fileId || !snapshot.oldRemotePath) return null;
    const localPath = deriveOrNull({
      mirrorRoot: snapshot.mirrorRoot,
      nodeRoot: snapshot.nodeRoot,
      remotePath: snapshot.oldRemotePath,
    });
    if (localPath) await rm(localPath, { force: true }).catch(() => undefined);
    await deleteFileState(snapshot.fileId).catch(() => undefined);
    client.invalidateSyncInfo(snapshot.nodeId);
    return null;
  }

  if (snapshot.tool === "portuni_move_file") {
    if (parsed.status !== "ok" || !parsed.moved_at) return null;
    if (!snapshot.fileId || !snapshot.oldRemotePath) return null;
    const newRemotePath = parsed.new_remote_path as string | undefined;
    if (!newRemotePath) return null;
    const oldLocal = deriveOrNull({
      mirrorRoot: snapshot.mirrorRoot,
      nodeRoot: snapshot.nodeRoot,
      remotePath: snapshot.oldRemotePath,
    });
    // Cross-node move: the new path lives under the TARGET node's mirror.
    const targetNodeId = (snapshot.args.new_node_id as string | undefined) ?? snapshot.nodeId;
    let targetMirror = snapshot.mirrorRoot;
    let targetNodeRoot = snapshot.nodeRoot;
    if (targetNodeId !== snapshot.nodeId) {
      const m = await getMirrorPath(userId, targetNodeId);
      if (!m) return null; // target node not mirrored here -- nothing to place
      targetMirror = m;
      targetNodeRoot = nodeRootFor(await client.syncInfo(targetNodeId));
    }
    const newLocal = deriveOrNull({
      mirrorRoot: targetMirror,
      nodeRoot: targetNodeRoot,
      remotePath: newRemotePath,
    });
    let localDone = false;
    if (oldLocal && newLocal && oldLocal !== newLocal) {
      localDone = await renameLocalBestEffort(oldLocal, newLocal);
      if (localDone) await localHashFor(newLocal, snapshot.fileId, null).catch(() => null);
    }
    client.invalidateSyncInfo(snapshot.nodeId);
    if (targetNodeId !== snapshot.nodeId) client.invalidateSyncInfo(targetNodeId);
    const detail =
      parsed.detail && typeof parsed.detail === "object"
        ? (parsed.detail as Record<string, unknown>)
        : {};
    return JSON.stringify({
      ...parsed,
      new_local_path: newLocal,
      detail: { ...detail, local_done: localDone },
    });
  }

  if (snapshot.tool === "portuni_rename_folder") {
    if (parsed.type !== "applied" || !Array.isArray(parsed.files)) return null;
    for (const f of parsed.files as Array<Record<string, unknown>>) {
      if (f.status !== "ok") continue;
      const oldLocal = deriveOrNull({
        mirrorRoot: snapshot.mirrorRoot,
        nodeRoot: snapshot.nodeRoot,
        remotePath: f.old_remote_path as string,
      });
      const newLocal = deriveOrNull({
        mirrorRoot: snapshot.mirrorRoot,
        nodeRoot: snapshot.nodeRoot,
        remotePath: f.new_remote_path as string,
      });
      if (oldLocal && newLocal && oldLocal !== newLocal) {
        await renameLocalBestEffort(oldLocal, newLocal);
      }
    }
    client.invalidateSyncInfo(snapshot.nodeId);
  }
  return null;
}
