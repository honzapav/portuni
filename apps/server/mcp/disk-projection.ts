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

// Narrow shape DiskProjector/readableMirrorRoot actually need from a scope --
// satisfied structurally by SessionScope, but also by the lightweight
// stand-in agent-transport.ts builds for a central-mode session (which has
// no real SessionScope: no graph DB, no expansion history, nothing beyond a
// home node id and a projection directory key).
export interface ProjectorScope {
  homeNodeId: string | null;
  has(nodeId: string): boolean;
  // True for a node granted its real mirror at spawn (home's depth-1
  // neighbours). Only consulted by readableMirrorRoot's fallback below, not
  // by DiskProjector itself (which always attempts to project every non-home
  // node, seed or not -- see doProject). Callers with no such concept (the
  // central-mode agent front door's shim) can return false unconditionally.
  isSeed(nodeId: string): boolean;
  projectionSessionId: string | null;
}

// Why a node was NOT hardlinked into the session's projection directory:
//   seed_granted     - it is this session's own home node: already
//                       real-mirror readable (rw, granted at spawn), never
//                       needs a projection.
//   no_mirror        - this device has no local mirror for the node.
//   out_of_scope     - the node is not in this session's read scope
//                       (guardNodeRead has not admitted it), so nothing may
//                       be projected for it regardless of mirrors.
//   no_projection_root - PORTUNI_ROOT (or the projection session id) could
//                       not be resolved -- nowhere to put the hardlink.
//   central          - this session has no home node at all (e.g.
//                       interactive_chat/connector sessions with no
//                       anchor): there is no per-node projection root to
//                       compute without one.
export type NotProjectedReason =
  | "seed_granted"
  | "no_mirror"
  | "out_of_scope"
  | "no_projection_root"
  | "central";

export type ProjectOutcome =
  | { kind: "projected"; dir: string; files: number }
  | { kind: "not_projected"; reason: NotProjectedReason };

// The readable disk path (if any) for a node's files in a tool response:
// - home node: its real mirror (granted rw at spawn).
// - seed (depth-1) node: its projection directory once created (preferred
//   over the real mirror path even though it is USUALLY also granted,
//   because the projection is unconditionally granted by the Seatbelt
//   profile while the depth-1 real-mirror grant is frozen at spawn and can
//   skew from the in-memory seed set recomputed at connect, #252) -- falls
//   back to the real mirror when no projection was made yet (e.g. no
//   PORTUNI_ROOT resolvable), matching the pre-#252 behavior for that case.
// - ad-hoc in-scope node: its projection directory ONLY -- unlike a seed
//   node, its real mirror was never granted by the Seatbelt profile in the
//   first place, so falling back to it here would return an unreadable path.
// - out-of-scope nodes: null (guardNodeRead already refused the read).
export function readableMirrorRoot(args: {
  scope: ProjectorScope;
  nodeId: string;
  homeMirror: string | null;
  realMirror: string | null;
  projectionDir?: string | null;
}): string | null {
  const { scope, nodeId, realMirror, projectionDir } = args;
  if (nodeId === scope.homeNodeId) return realMirror;
  if (scope.isSeed(nodeId)) return projectionDir ?? realMirror ?? null;
  if (scope.has(nodeId)) return projectionDir ?? null;
  return null;
}

export interface DiskProjector {
  // Ensure a non-home in-scope node's local mirror (if this device has one)
  // is hardlinked into this session's projection directory, and return
  // where + how many files landed, or why not (see NotProjectedReason).
  // Always attempted for seed (depth-1) nodes too, not just ad-hoc ones --
  // cheap (a hardlink) and closes the seed/grant skew #252 describes.
  projectNode(nodeId: string): Promise<ProjectOutcome>;
  // Fire-and-forget variant for the scope.onAdd hook.
  schedule(nodeId: string): void;
}

type MirrorResolver = (userId: string, nodeId: string) => Promise<string | null>;

function notProjected(reason: NotProjectedReason): ProjectOutcome {
  return { kind: "not_projected", reason };
}

export function createDiskProjector(args: {
  userId: string;
  scope: ProjectorScope;
  // Injectable for tests; defaults to the per-device mirror registry.
  resolveMirror?: MirrorResolver;
}): DiskProjector {
  const resolveMirror: MirrorResolver = args.resolveMirror ?? getMirrorPath;

  // Per-node in-flight dedup, same reasoning as the retired reconciler: an
  // awaited projectNode from a tool call and a fire-and-forget schedule()
  // from onAdd must not race and double-link/interleave the same node.
  const inFlight = new Map<string, Promise<ProjectOutcome>>();

  async function doProject(nodeId: string): Promise<ProjectOutcome> {
    const { scope, userId } = args;
    const homeNodeId = scope.homeNodeId;
    if (!homeNodeId) return notProjected("central");
    if (nodeId === homeNodeId) return notProjected("seed_granted");
    if (!scope.has(nodeId)) return notProjected("out_of_scope");
    // #211: the directory key is projectionSessionId, not sessionId -- see
    // mcp/scope.ts's doc comment. It is set synchronously by createMcpServer,
    // so (unlike the old sessionId-keyed guard this replaces) there is no
    // persistence race to wait out here.
    const projectionSessionId = scope.projectionSessionId;
    if (!projectionSessionId) return notProjected("no_projection_root");

    const mirrorPath = await resolveMirror(userId, nodeId);
    if (!mirrorPath) return notProjected("no_mirror"); // no local mirror to link from

    const root = await resolveProjectionRootForNode(userId, homeNodeId);
    if (!root) return notProjected("no_projection_root");

    const dir = nodeProjectionDir(root.projectionRoot, projectionSessionId, nodeId);
    const files = await hardlinkNode(mirrorPath, dir);
    registerProjectedNode(nodeId, { sessionId: projectionSessionId, mirrorPath, targetDir: dir });
    return { kind: "projected", dir, files };
  }

  function projectNode(nodeId: string): Promise<ProjectOutcome> {
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
// projection directory from disk. Best-effort, matching the rest of this
// module: every failure is swallowed.
//
// Callers fire and forget -- transport.onclose cannot await. The returned
// promise exists so a caller that CAN wait (tests) has something to wait on
// instead of guessing at a sleep; the real call site keeps discarding it
// with `void`.
export function disposeSessionProjection(
  scope: SessionScope,
  userId: string,
  db: Client,
): Promise<void> {
  const projectionSessionId = scope.projectionSessionId;
  const homeNodeId = scope.homeNodeId;
  // The shared bucket (#211) is never torn down purely because THIS
  // session's projection directory happens to be it -- other concurrent
  // non-relaying sessions on the same node may still be reading it. Its own
  // lifetime is handled below, unconditionally, based on node-level running
  // state rather than this one session's identity.
  const pending: Array<Promise<unknown>> = [];
  if (projectionSessionId && projectionSessionId !== UNNARROWED_PROJECTION_ID) {
    unregisterSessionProjections(projectionSessionId);
    if (homeNodeId) {
      pending.push(
        resolveProjectionRootForNode(userId, homeNodeId)
          .then((root) =>
            root ? cleanupSessionProjection(root.projectionRoot, projectionSessionId) : undefined,
          )
          .catch(() => undefined),
      );
    }
  }
  if (homeNodeId) {
    pending.push(
      sweepSharedProjectionIfIdle(db, homeNodeId, userId, scope.sessionId).catch(() => undefined),
    );
  }
  return Promise.all(pending).then(() => undefined);
}
