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
import { subpathFromMirror } from "../domain/sync/remote-path.js";
import type { StatusFileEntry } from "../domain/sync/engine.js";

// Raised when a caller asks for something the local tool supports but the
// agent plane cannot serve faithfully (CentralClient API gaps). Failing
// loudly beats silently dropping the arg -- the caller would otherwise
// believe e.g. a description was persisted when it was not.
class AgentUnsupportedError extends Error {
  constructor(what: string) {
    super(
      `not supported by the agent plane yet: ${what}. Use the desktop app / local mode for this.`,
    );
    this.name = "AgentUnsupportedError";
  }
}

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
    const nodeId = args.node_id as string | undefined;
    if (!nodeId) {
      // Central-mode statusScanCentral is single-node only (v1 scope cut --
      // no cross-mirror scan without a graph db to enumerate nodes from).
      throw new Error("portuni_status requires node_id in agent mode (single-node scan only)");
    }
    return statusScanCentral(client, {
      userId,
      nodeId,
      // Same default as the local tool (sync-status.ts): discovery on
      // unless the caller explicitly opts out.
      includeDiscovery: args.include_discovery !== false,
      fast: false,
    });
  },

  async portuni_store(client, userId, args) {
    // CentralClient.registerFile only takes (nodeId, relPath) -- there is
    // no way to persist description/status/subpath through the agent
    // plane. Fail loudly rather than silently dropping metadata the
    // caller believes was saved.
    const unsupported = (["description", "status", "subpath"] as const).filter(
      (k) => args[k] !== undefined && args[k] !== null,
    );
    if (unsupported.length > 0) {
      throw new AgentUnsupportedError(`portuni_store args ${unsupported.join(", ")}`);
    }
    // Local storeFile copies an outside-the-mirror source file into the
    // mirror (routing via status/subpath); the central path has no such
    // copy-in, so an external path would fail deep inside with a
    // confusing message. Reject it up front with the same loud error.
    const nodeId = args.node_id as string;
    const localPath = args.local_path as string;
    const mirrorRoot = await getMirrorPath(userId, nodeId);
    if (mirrorRoot && subpathFromMirror(mirrorRoot, localPath) === null) {
      throw new AgentUnsupportedError(
        `storing a file from outside the mirror's tracked sections (${localPath})`,
      );
    }
    return storeFileCentral(client, { userId, nodeId, localPath });
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
    // engine-central has no remote-file listing (documented v1 scope cut --
    // no new_remote discovery), so unlike the local tool's args.paths
    // (untracked *remote* paths to adopt), agent mode discovers untracked
    // *local* files itself and registers all of them. skipped.remote_path
    // holds the local path for a failed entry since no remote path exists
    // yet for it. When the caller did pass paths, surface the divergence
    // via an extra `note` field: additive next to adopted/skipped, so it
    // cannot break a consumer of the local payload contract, but the
    // caller learns its path selection was not applied.
    const nodeId = args.node_id as string;
    const paths = args.paths as unknown[] | undefined;
    const note =
      paths && paths.length > 0
        ? "agent mode ignores `paths` (no remote listing on this plane): all untracked local files under the node's mirror were adopted instead"
        : undefined;
    const untracked = await listUntrackedLocalCentral(client, { userId, nodeId });
    const adopted: Array<{ file_id: string; remote_path: string; filename: string; hash: string }> =
      [];
    const skipped: Array<{ remote_path: string; reason: string }> = [];
    for (const entry of untracked) {
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
    return note !== undefined ? { adopted, skipped, note } : { adopted, skipped };
  },
};

type ToolTextResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

// Overlay device-local fields onto a proxied portuni_get_node result. Central
// serves the node with local_mirror:null and files[].local_path:null (it has
// no device state); this fills them from the device that owns the mirror, so
// an agent in central mode sees the same paths a local session would.
//
// - local_mirror: from getLocalMirror (registration metadata for any node).
// - files[].local_path: derived real paths, but ONLY for the home node. Under
//   the seatbelt sandbox the agent can read only its home mirror (non-home
//   mirrors are denied; local mode surfaces them via .portuni-scope staging,
//   which central mode does not do), so a real non-home path would be a path
//   the agent cannot read. Non-home files stay null rather than misleading.
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
  if (id === homeNodeId && mirrorPath && Array.isArray(node.files)) {
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

// Overlay device-local `local_path` (the node's readable mirror root) onto a
// proxied portuni_get_context result. Central serves every node's local_path
// null; only the session home node is readable under the seatbelt sandbox
// (non-home nodes need .portuni-scope staging central mode does not do), so we
// fill just the home node's mirror root wherever it appears (root or a
// connected node). Any shape it does not recognise passes through unchanged.
export async function enrichGetContextResult<T extends ToolTextResult>(
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
  const homeMirror = await getMirrorPath(userId, homeNodeId);
  if (!homeMirror) return result;
  const fillIfHome = (n: unknown): void => {
    if (n && typeof n === "object") {
      const node = n as Record<string, unknown>;
      if (node.id === homeNodeId && !node.local_path) node.local_path = homeMirror;
    }
  };
  fillIfHome(payload.root);
  if (Array.isArray(payload.connected)) {
    for (const n of payload.connected) fillIfHome(n);
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
    if (
      e instanceof MirrorCreateError ||
      e instanceof CentralHttpError ||
      e instanceof AgentUnsupportedError
    ) {
      return {
        content: [{ type: "text", text: `Error: ${e.message}` }],
        isError: true,
      };
    }
    throw e;
  }
}
