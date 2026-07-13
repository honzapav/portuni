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
import { onMirrorRegistryChange } from "./mirror-registry.js";
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
  // Graph db for the default reconcile/backfill wiring. Optional: the
  // central-mode agent injects its own reconcile and disables backfill, so
  // it runs the watcher with no db at all.
  db?: Client;
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
  // Per-mirror backfill used when refresh() picks up a newly registered
  // mirror -- files written between mirror registration and the watch
  // attaching must not stay invisible. The central-mode agent injects its
  // central registration here; default is the db-backed backfill (or none
  // when backfill is disabled).
  backfillMirror?: (m: LocalMirrorRow) => Promise<void>;
  // Registry-change subscription so mirrors registered after start() still
  // get watched. Default: onMirrorRegistryChange (same-process hub).
  subscribe?: (onChange: () => void) => () => void;
  debounceMs?: number;
  onError?: (e: unknown) => void;
}

export interface MirrorWatcher {
  start(): Promise<void>;
  // Re-list mirrors and diff against the watched set: watch + backfill new
  // mirrors, drop watches for unregistered ones, re-resolve event ownership.
  refresh(): Promise<void>;
  stop(): void;
}

export function createMirrorWatcher(deps: MirrorWatcherDeps): MirrorWatcher {
  const listMirrors = deps.listMirrors ?? listLocalMirrors;
  const db = deps.db ?? null;
  const reconcile =
    deps.reconcile ??
    ((a: { userId: string; nodeId: string; absPath: string }) => {
      if (!db) {
        return Promise.reject(
          new Error("mirror watcher: no db and no reconcile injected"),
        );
      }
      return reconcilePath(db, a);
    });
  const watchFactory = deps.watchFactory ?? defaultWatchFactory;
  const wantBackfill = (deps.backfill ?? true) && db !== null;
  const subscribe = deps.subscribe ?? onMirrorRegistryChange;
  const debounceMs = deps.debounceMs ?? 300;
  const onError = deps.onError ?? (() => undefined);

  let mirrors: LocalMirrorRow[] = [];
  const watched = new Map<string, { path: string; handle: WatchHandle }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let unsubscribe: (() => void) | null = null;
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
  // the watcher was down (or before its watch attached) do not stay
  // invisible. Local-only (no remote calls); upload still waits for a
  // deliberate sync.
  async function dbBackfillMirror(m: LocalMirrorRow): Promise<void> {
    if (!db) return; // agent mode: the caller runs its own central backfill
    const untracked = await listUntrackedLocal(db, {
      userId: deps.userId,
      nodeId: m.node_id,
    });
    for (const u of untracked) {
      await registerLocalFile(db, {
        userId: deps.userId,
        nodeId: u.node_id,
        localPath: u.local_path,
      });
    }
  }

  // Backfill for mirrors that appear on a refresh: injected central-mode
  // registration wins, else the db-backed path (when backfill is enabled).
  const refreshBackfillMirror =
    deps.backfillMirror ?? (wantBackfill ? dbBackfillMirror : null);

  // Diff the registry against the watched set. Best-effort throughout: a
  // mirror that fails to watch or backfill must not take the others down.
  async function reconcileMirrors(
    backfillOne: ((m: LocalMirrorRow) => Promise<void>) | null,
  ): Promise<void> {
    if (stopped) return;
    let next: LocalMirrorRow[];
    try {
      next = await listMirrors(deps.userId);
    } catch (e) {
      onError(e);
      return;
    }
    if (stopped) return;
    const nextByNode = new Map(next.map((m) => [m.node_id, m]));
    for (const [nodeId, w] of watched) {
      const m = nextByNode.get(nodeId);
      if (!m || m.local_path !== w.path) {
        try {
          w.handle.close();
        } catch {
          /* already closed */
        }
        watched.delete(nodeId);
      }
    }
    const added: LocalMirrorRow[] = [];
    for (const m of next) {
      if (watched.has(m.node_id)) continue;
      try {
        watched.set(m.node_id, {
          path: m.local_path,
          handle: watchFactory(m.local_path, schedule),
        });
        added.push(m);
      } catch (e) {
        onError(e);
      }
    }
    // Update the ownership list before backfilling: watch first, resolve
    // owners correctly, then sweep what landed before the watch attached.
    mirrors = next;
    if (backfillOne) {
      for (const m of added) {
        try {
          await backfillOne(m);
        } catch (e) {
          onError(e);
        }
      }
    }
  }

  // Serialize refreshes: a registry notification arriving mid-refresh queues
  // behind it instead of racing the watched-set bookkeeping.
  let refreshChain: Promise<void> = Promise.resolve();
  function queueReconcile(
    backfillOne: ((m: LocalMirrorRow) => Promise<void>) | null,
  ): Promise<void> {
    refreshChain = refreshChain.then(() => reconcileMirrors(backfillOne));
    return refreshChain;
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      unsubscribe = subscribe(() => {
        void queueReconcile(refreshBackfillMirror);
      });
      // Initial pass: every registered mirror is "new" here, so this also
      // performs the start-time backfill (files created while down).
      await queueReconcile(wantBackfill ? dbBackfillMirror : null);
    },
    refresh(): Promise<void> {
      return queueReconcile(refreshBackfillMirror);
    },
    stop(): void {
      stopped = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watched.values()) {
        try {
          w.handle.close();
        } catch {
          /* already closed */
        }
      }
      watched.clear();
    },
  };
}
