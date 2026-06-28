// Mirror watcher: a thin filesystem-event shell around reconcilePath. It is
// the deterministic, agent-independent half of file-state currency -- every
// write to a mirror (agent edit, in-app editor, external editor) is caught
// here and reconciled into the sync DB, so the UI's fast-mode status is
// always correct without anyone calling portuni_status / portuni_store.
//
// Desktop-primary: the desktop app starts this in the sidecar (gated by
// PORTUNI_WATCH_MIRRORS). The fs.watch adapter and the reconcile/list
// dependencies are injectable so the dispatch + debounce logic is tested
// without depending on OS event timing.

import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { listLocalMirrors, type LocalMirrorRow } from "./local-db.js";
import { listUntrackedLocal } from "./discover-local.js";
import { registerLocalFile } from "./engine.js";
import { reconcilePath, type ReconcileResult } from "./reconcile.js";

export interface WatchHandle {
  close(): void;
}

export type WatchFactory = (
  root: string,
  onPath: (absPath: string) => void,
) => WatchHandle;

// The innermost mirror whose root contains absPath. Nested mirrors (a project
// mirror inside its org mirror) resolve to the deepest, matching the session's
// longest-prefix containment. A path that only shares a string prefix with a
// sibling ("/root/foobar" vs mirror "/root/foo") does NOT match.
export function ownerNodeForPath(
  mirrors: readonly { node_id: string; local_path: string }[],
  absPath: string,
): string | null {
  let best: { node_id: string; local_path: string } | null = null;
  for (const m of mirrors) {
    const root = m.local_path.endsWith("/") ? m.local_path : `${m.local_path}/`;
    if (absPath === m.local_path || absPath.startsWith(root)) {
      if (!best || m.local_path.length > best.local_path.length) best = m;
    }
  }
  return best ? best.node_id : null;
}

const defaultWatchFactory: WatchFactory = (root, onPath) => {
  const w = fsWatch(root, { recursive: true }, (_event, filename) => {
    if (filename == null) return;
    onPath(join(root, filename.toString()));
  });
  return { close: () => w.close() };
};

export interface MirrorWatcherDeps {
  db: Client;
  userId: string;
  // Injectable seams (production defaults wire the real sync stack).
  listMirrors?: (userId: string) => Promise<LocalMirrorRow[]>;
  reconcile?: (a: {
    userId: string;
    nodeId: string;
    absPath: string;
  }) => Promise<ReconcileResult>;
  watchFactory?: WatchFactory;
  // Register pre-existing untracked files on start (default true). Disabled in
  // dispatch tests that inject a stub db.
  backfill?: boolean;
  debounceMs?: number;
  onError?: (e: unknown) => void;
}

export interface MirrorWatcher {
  start(): Promise<void>;
  stop(): void;
}

export function createMirrorWatcher(deps: MirrorWatcherDeps): MirrorWatcher {
  const listMirrors = deps.listMirrors ?? listLocalMirrors;
  const reconcile = deps.reconcile ?? ((a) => reconcilePath(deps.db, a));
  const watchFactory = deps.watchFactory ?? defaultWatchFactory;
  const wantBackfill = deps.backfill ?? true;
  const debounceMs = deps.debounceMs ?? 300;
  const onError = deps.onError ?? (() => undefined);

  let mirrors: LocalMirrorRow[] = [];
  const handles: WatchHandle[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  // Coalesce the event burst editors emit on an atomic save (write temp +
  // rename) into a single reconcile per path.
  function schedule(absPath: string): void {
    const existing = timers.get(absPath);
    if (existing) clearTimeout(existing);
    timers.set(
      absPath,
      setTimeout(() => {
        timers.delete(absPath);
        if (stopped) return;
        const nodeId = ownerNodeForPath(mirrors, absPath);
        if (!nodeId) return;
        reconcile({ userId: deps.userId, nodeId, absPath }).catch(onError);
      }, debounceMs),
    );
  }

  // Register anything already on disk but untracked, so files created while
  // the watcher was down do not stay invisible. Local-only (no remote calls);
  // upload still waits for a deliberate sync. Best-effort per mirror.
  async function backfill(): Promise<void> {
    for (const m of mirrors) {
      try {
        const untracked = await listUntrackedLocal(deps.db, {
          userId: deps.userId,
          nodeId: m.node_id,
        });
        for (const u of untracked) {
          await registerLocalFile(deps.db, {
            userId: deps.userId,
            nodeId: u.node_id,
            localPath: u.local_path,
          });
        }
      } catch (e) {
        onError(e);
      }
    }
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      mirrors = await listMirrors(deps.userId);
      for (const m of mirrors) {
        try {
          handles.push(watchFactory(m.local_path, schedule));
        } catch (e) {
          onError(e);
        }
      }
      if (wantBackfill) await backfill();
    },
    stop(): void {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const h of handles) {
        try {
          h.close();
        } catch {
          /* already closed */
        }
      }
      handles.length = 0;
    },
  };
}
