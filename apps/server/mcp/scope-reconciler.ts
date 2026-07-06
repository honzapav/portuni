// Scope -> disk projection. Copy staging is retired: the Seatbelt profile now
// grants the seed set (home + depth-1) their REAL mirror paths, and ad-hoc
// in-scope nodes are read through portuni_read_file rather than a staged copy.
// The reconciler survives only as a one-time sweeper of legacy .portuni-scope
// directories from pre-real-path sessions (fired via scope.onAdd on the first
// node added). readableMirrorRoot decides which nodes get a real disk path.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import type { SessionScope } from "./scope.js";

// The readable mirror root the agent can use on disk for a node's files.
// Home + the seed set (depth-1) are granted their REAL mirror by the seatbelt,
// so return it. Ad-hoc (non-seed) in-scope nodes are NOT exposed on disk (no
// staging any more), so return null -- the agent reads their content through
// portuni_read_file instead of a stale copy.
export function readableMirrorRoot(args: {
  scope: SessionScope;
  nodeId: string;
  homeMirror: string | null;
  realMirror: string | null;
}): string | null {
  const { scope, nodeId, realMirror } = args;
  if (nodeId === scope.homeNodeId || scope.isSeed(nodeId)) return realMirror;
  if (scope.has(nodeId)) return null; // ad-hoc: read via portuni_read_file
  return realMirror;
}

export interface ScopeReconciler {
  // Stage a node now and resolve when the copy is complete. Idempotent:
  // re-staging replaces the previous copy so callers can use it to refresh.
  // Returns null when nothing was staged (home node, no home, no mirror,
  // or a copy failure).
  reconcileNode(nodeId: string): Promise<{ staged_path: string; files: number } | null>;
  // Fire-and-forget staging for the onAdd hook. Errors are swallowed.
  schedule(nodeId: string): void;
}

type MirrorResolver = (userId: string, nodeId: string) => Promise<string | null>;

export function createScopeReconciler(args: {
  userId: string;
  scope: SessionScope;
  // Injectable for tests; defaults to the per-device mirror registry.
  resolveMirror?: MirrorResolver;
}): ScopeReconciler {
  const resolveMirror: MirrorResolver = args.resolveMirror ?? getMirrorPath;

  // Per-node in-flight dedup: concurrent reconcileNode(id) calls for the same
  // id share ONE stage run. Without this, expand_scope's awaited reconcile and
  // the onAdd-fired schedule() race on the same .portuni-scope/<id>/ dir (each
  // does rm -rf + cp), nulling the awaited result and rm+re-cp'ing the dir
  // while the agent reads it.
  const inFlight = new Map<
    string,
    Promise<{ staged_path: string; files: number } | null>
  >();

  // Once per session: clear the whole <home>/.portuni-scope before any ad-hoc
  // staging, so stale copies from a previous session (which are readable in
  // the home rw zone and out of THIS session's scope) never leak in. Shared
  // promise so the fire-and-forget home reconcile and an awaited expand_scope
  // reconcile can't double-sweep or stage into a half-swept dir.
  let sweepPromise: Promise<void> | null = null;
  function sweepStagedRootOnce(homeMirror: string): Promise<void> {
    if (!sweepPromise) {
      sweepPromise = rm(join(homeMirror, ".portuni-scope"), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    return sweepPromise;
  }

  async function doReconcile(
    _nodeId: string,
  ): Promise<{ staged_path: string; files: number } | null> {
    // Staging is retired: home + seed nodes are granted their real mirror by
    // the seatbelt, and ad-hoc nodes are read via portuni_read_file. The only
    // remaining job is a one-time sweep of legacy .portuni-scope copies left
    // by pre-real-path sessions, so they can't linger as stale readable dirs.
    const homeNodeId = args.scope.homeNodeId;
    if (!homeNodeId) return null;
    const homeMirror = await resolveMirror(args.userId, homeNodeId);
    if (homeMirror) await sweepStagedRootOnce(homeMirror);
    return null;
  }

  async function reconcileNode(
    nodeId: string,
  ): Promise<{ staged_path: string; files: number } | null> {
    const running = inFlight.get(nodeId);
    if (running) return running;
    const p = doReconcile(nodeId).finally(() => inFlight.delete(nodeId));
    inFlight.set(nodeId, p);
    return p;
  }

  return {
    reconcileNode,
    schedule(nodeId: string): void {
      void reconcileNode(nodeId);
    },
  };
}
