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
import { listUserMirrors } from "../domain/sync/mirror-registry.js";
import type { StatusFileEntry } from "../domain/sync/engine.js";

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
      includeDiscovery: true,
      fast: false,
    });
  },

  async portuni_store(client, userId, args) {
    return storeFileCentral(client, {
      userId,
      nodeId: args.node_id as string,
      localPath: args.local_path as string,
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
    // engine-central has no remote-file listing (documented v1 scope cut --
    // no new_remote discovery), so unlike the local tool's args.paths
    // (untracked *remote* paths to adopt), agent mode discovers untracked
    // *local* files itself and registers all of them; args.paths is not
    // applicable here and is ignored. skipped.remote_path holds the local
    // path for a failed entry since no remote path exists yet for it.
    const nodeId = args.node_id as string;
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
    return { adopted, skipped };
  },
};

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
