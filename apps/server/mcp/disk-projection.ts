// Scope -> disk projection (spec: "Disk contract", #191). Home + the seed
// set (depth-1 neighbours) are granted their REAL mirror by the Seatbelt
// profile at spawn (domain/sandbox-profile.ts); ad-hoc (non-seed) in-scope
// nodes are hardlinked into this session's projection directory
// (domain/session-projection.ts) the first time a read tool touches them,
// so the agent can read them directly on disk too, not only via
// portuni_read_file. readableMirrorRoot decides which path (if any) a tool
// response's local_path should carry.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import { resolveProjectionRootForNode } from "../domain/sandbox-profile.js";
import {
  cleanupSessionProjection,
  nodeProjectionDir,
  projectNode as hardlinkNode,
  registerProjectedNode,
  unregisterSessionProjections,
  UNNARROWED_PROJECTION_ID,
} from "../domain/session-projection.js";
import type { SessionScope } from "./scope.js";

// The readable disk path (if any) for a node's files in a tool response:
// - home / seed (depth-1) nodes: their real mirror (granted rw/ro at spawn).
// - ad-hoc in-scope nodes: their projection directory, once created by
//   DiskProjector.projectNode (passed in by the caller, which awaits that
//   before building the response).
// - out-of-scope nodes: null (guardNodeRead already refused the read).
export function readableMirrorRoot(args: {
  scope: SessionScope;
  nodeId: string;
  homeMirror: string | null;
  realMirror: string | null;
  projectionDir?: string | null;
}): string | null {
  const { scope, nodeId, realMirror, projectionDir } = args;
  if (nodeId === scope.homeNodeId || scope.isSeed(nodeId)) return realMirror;
  if (scope.has(nodeId)) return projectionDir ?? null;
  return null;
}

export interface DiskProjector {
  // Ensure an ad-hoc node's local mirror (if this device has one) is
  // hardlinked into this session's projection directory, and return where
  // + how many files landed. Null when there is nothing to project: a
  // home/seed node (already real-path granted), a node not in scope, no
  // session id yet (persistence race), no PORTUNI_ROOT, or no local mirror
  // for the node on this device (portuni_read_file still works for those).
  projectNode(nodeId: string): Promise<{ dir: string; files: number } | null>;
  // Fire-and-forget variant for the scope.onAdd hook.
  schedule(nodeId: string): void;
}

type MirrorResolver = (userId: string, nodeId: string) => Promise<string | null>;

export function createDiskProjector(args: {
  userId: string;
  scope: SessionScope;
  // Injectable for tests; defaults to the per-device mirror registry.
  resolveMirror?: MirrorResolver;
}): DiskProjector {
  const resolveMirror: MirrorResolver = args.resolveMirror ?? getMirrorPath;

  // Per-node in-flight dedup, same reasoning as the retired reconciler: an
  // awaited projectNode from a tool call and a fire-and-forget schedule()
  // from onAdd must not race and double-link/interleave the same node.
  const inFlight = new Map<string, Promise<{ dir: string; files: number } | null>>();

  async function doProject(nodeId: string): Promise<{ dir: string; files: number } | null> {
    const { scope, userId } = args;
    if (nodeId === scope.homeNodeId || scope.isSeed(nodeId)) return null;
    if (!scope.has(nodeId)) return null;
    // #211: the directory key is projectionSessionId, not sessionId -- see
    // mcp/scope.ts's doc comment. It is set synchronously by createMcpServer,
    // so (unlike the old sessionId-keyed guard this replaces) there is no
    // persistence race to wait out here.
    const projectionSessionId = scope.projectionSessionId;
    const homeNodeId = scope.homeNodeId;
    if (!projectionSessionId || !homeNodeId) return null;

    const mirrorPath = await resolveMirror(userId, nodeId);
    if (!mirrorPath) return null; // no local mirror to link from

    const root = await resolveProjectionRootForNode(userId, homeNodeId);
    if (!root) return null;

    const dir = nodeProjectionDir(root.projectionRoot, projectionSessionId, nodeId);
    const files = await hardlinkNode(mirrorPath, dir);
    registerProjectedNode(nodeId, { sessionId: projectionSessionId, mirrorPath, targetDir: dir });
    return { dir, files };
  }

  function projectNode(nodeId: string): Promise<{ dir: string; files: number } | null> {
    const running = inFlight.get(nodeId);
    if (running) return running;
    const p = doProject(nodeId).finally(() => inFlight.delete(nodeId));
    inFlight.set(nodeId, p);
    return p;
  }

  return {
    projectNode,
    schedule(nodeId: string): void {
      void projectNode(nodeId);
    },
  };
}

// #214: remove the shared bucket (#211) for homeNodeId once this was the
// last running session on it -- it isn't keyed to any single session, so it
// can't be torn down by that session's own close the way a narrow
// projection directory is; it just has to outlive every session that might
// still be reading it. excludeSessionId is the durable row this connection
// is bound to (scope.sessionId, distinct from projectionSessionId which may
// be the shared-bucket sentinel itself): excluded from the "any other
// running session" check so a not-yet-updated row for the very session that
// is closing right now never blocks the sweep.
async function sweepSharedProjectionIfIdle(
  db: Client,
  homeNodeId: string,
  userId: string,
  excludeSessionId: string | null,
): Promise<void> {
  const other = await db.execute({
    sql: excludeSessionId
      ? "SELECT 1 FROM sessions WHERE node_id = ? AND state = 'running' AND id != ? LIMIT 1"
      : "SELECT 1 FROM sessions WHERE node_id = ? AND state = 'running' LIMIT 1",
    args: excludeSessionId ? [homeNodeId, excludeSessionId] : [homeNodeId],
  });
  if (other.rows.length > 0) return;
  const root = await resolveProjectionRootForNode(userId, homeNodeId);
  if (!root) return;
  await rm(join(root.projectionRoot, UNNARROWED_PROJECTION_ID), { recursive: true, force: true });
}

// Session end (spec: "the agent never manages the directory" -- cleanup is
// the system's job): drop this session's registry entries and remove its
// projection directory from disk. Fire-and-forget by design (called from
// transport.onclose, which cannot await); best-effort, matching the rest of
// this module.
export function disposeSessionProjection(scope: SessionScope, userId: string, db: Client): void {
  const projectionSessionId = scope.projectionSessionId;
  const homeNodeId = scope.homeNodeId;
  // The shared bucket (#211) is never torn down purely because THIS
  // session's projection directory happens to be it -- other concurrent
  // non-relaying sessions on the same node may still be reading it. Its own
  // lifetime is handled below, unconditionally, based on node-level running
  // state rather than this one session's identity.
  if (projectionSessionId && projectionSessionId !== UNNARROWED_PROJECTION_ID) {
    unregisterSessionProjections(projectionSessionId);
    if (homeNodeId) {
      void resolveProjectionRootForNode(userId, homeNodeId)
        .then((root) =>
          root ? cleanupSessionProjection(root.projectionRoot, projectionSessionId) : undefined,
        )
        .catch(() => undefined);
    }
  }
  if (homeNodeId) {
    void sweepSharedProjectionIfIdle(db, homeNodeId, userId, scope.sessionId).catch(() => undefined);
  }
}
