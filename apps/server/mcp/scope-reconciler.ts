// The single path that projects the authoritative SessionScope set onto
// disk. The Seatbelt sandbox a terminal runs under grants rw on the home
// mirror only; every other in-scope node is made readable by copying its
// mirror into <home>/.portuni-scope/<id>/ (inside the visible zone,
// read-only). Subscribed once per session to scope.onAdd, so ANY code path
// that adds a node to scope — auto-seed, session_init, get_node/get_context
// auto-allow, expand_scope — projects to disk identically. Graph scope is
// authoritative; a failed copy degrades to null, it never throws.

import { join } from "node:path";
import { stageNodeIntoMirror } from "../domain/scope-staging.js";
import { getMirrorPath } from "../domain/sync/mirror-registry.js";
import type { SessionScope } from "./scope.js";

// Deterministic staged location for a node's files inside the home mirror.
export function stagedMirrorRoot(homeMirror: string, nodeId: string): string {
  return join(homeMirror, ".portuni-scope", nodeId);
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

  async function doReconcile(
    nodeId: string,
  ): Promise<{ staged_path: string; files: number } | null> {
    const homeNodeId = args.scope.homeNodeId;
    if (!homeNodeId || nodeId === homeNodeId) return null;
    const homeMirror = await resolveMirror(args.userId, homeNodeId);
    if (!homeMirror) return null;
    const nodeMirror = await resolveMirror(args.userId, nodeId);
    if (!nodeMirror) return null;
    try {
      return await stageNodeIntoMirror({ homeMirror, nodeId, nodeMirror });
    } catch {
      return null;
    }
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
