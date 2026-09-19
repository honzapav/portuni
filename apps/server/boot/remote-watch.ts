// Composition root for the remote watcher (#338). Central only: Drive
// credentials live on central since the one-collaboration-mode spec, and a
// local workspace has no remote at all -- so this is started from index.ts
// when PORTUNI_AUTH_MODE=google and nowhere else (an env-mode standalone
// server, the desktop sidecar in either of its modes, and the central-mode
// sync agent all skip it).
//
// Single instance in-process, like the mirror watcher's sweep. If central
// ever runs more than one process, the loop needs a DB lease before it is
// safe (two instances would double every Drive call and race on the
// cursor); noted in the spec's "Out of scope", not built.
//
// Everything time-related is injected (`now`, `schedule`) so the tick, the
// backoff and the 6 h catch-up are driven directly in tests -- no test ever
// waits on a real timer.

import type { DbClient } from "../infra/db.js";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import { authMode } from "../infra/server-config.js";
import { getAdapter } from "../domain/sync/adapter-cache.js";
import { listRemotes } from "../domain/sync/routing.js";
import { startSyncJob } from "../domain/sync/sync-jobs.js";
import {
  catchUpSweepNode,
  getRemoteCursor,
  runRemoteWatchTick,
  watchedNodesForRemote,
} from "../domain/sync/remote-watcher.js";
import {
  backoffMsFor,
  initialBackoff,
  shouldAttempt,
  type BackoffState,
} from "../domain/sync/central/reachability.js";

export const DEFAULT_WATCH_INTERVAL_MS = 60_000;
export const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(`[portuni:remote-watch] ignoring ${name}=${raw} (expected a positive integer ms)`);
    return fallback;
  }
  return n;
}

// What GET /sync/watch (#339) reports per remote. Kept here because the loop
// is the only thing that knows it.
export interface RemoteWatchStatus {
  remote_name: string;
  watching: boolean;
  cursor_updated_at: string | null;
  last_tick_at: string | null;
  last_error: string | null;
  backoff_until: string | null;
  last_full_sweep_at: string | null;
}

interface RemoteState {
  // false for a backend with no change feed (fs/OpenDAL): the periodic full
  // sweep is all there is for it (spec rule 3).
  hasFeed: boolean;
  backoff: BackoffState;
  lastTickAt: number | null;
  lastError: string | null;
  lastFullSweepAt: number | null;
  cursorUpdatedAt: string | null;
}

export interface RemoteWatchOptions {
  db?: DbClient;
  userId?: string;
  intervalMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => { unref?: () => void };
  // Runs the catch-up sweep for these nodes. Defaults to the sync-jobs
  // worker pool, which is what keeps a catch-up from overlapping a
  // user-triggered sync of the same node.
  runCatchUp?: (nodeIds: string[]) => Promise<void> | void;
}

export class RemoteWatchLoop {
  private readonly db: DbClient;
  private readonly userId: string;
  private readonly intervalMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => { unref?: () => void };
  private readonly runCatchUp: (nodeIds: string[]) => Promise<void> | void;
  private readonly states = new Map<string, RemoteState>();
  private running = false;
  private stopped = false;

  constructor(opts: RemoteWatchOptions = {}) {
    this.db = opts.db ?? getDb();
    this.userId = opts.userId ?? SOLO_USER;
    this.intervalMs = opts.intervalMs ?? positiveIntEnv("PORTUNI_REMOTE_WATCH_INTERVAL_MS", DEFAULT_WATCH_INTERVAL_MS);
    this.sweepIntervalMs =
      opts.sweepIntervalMs ?? positiveIntEnv("PORTUNI_REMOTE_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS);
    this.now = opts.now ?? Date.now;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.runCatchUp =
      opts.runCatchUp ??
      ((nodeIds) => {
        if (nodeIds.length === 0) return;
        startSyncJob({
          userId: this.userId,
          nodeIds,
          runNode: (nodeId) => catchUpSweepNode(this.db, { userId: this.userId, nodeId }),
        });
      });
  }

  status(): RemoteWatchStatus[] {
    const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
    return Array.from(this.states.entries()).map(([remote_name, s]) => ({
      remote_name,
      watching: s.hasFeed && s.lastError === null,
      cursor_updated_at: s.cursorUpdatedAt,
      last_tick_at: iso(s.lastTickAt),
      last_error: s.lastError,
      backoff_until: s.backoff.nextAttemptAt > this.now() ? iso(s.backoff.nextAttemptAt) : null,
      last_full_sweep_at: iso(s.lastFullSweepAt),
    }));
  }

  // One pass over every remote with a change feed. Skips a remote that is
  // still backing off; a remote whose tick throws (Drive 429/5xx, network)
  // backs off exponentially from the tick interval and leaves its cursor
  // untouched, so nothing is lost -- the next successful tick replays from
  // where the last applied batch ended.
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const remotes = await listRemotes(this.db);
      for (const remote of remotes) {
        const state = this.stateFor(remote.name);
        const now = this.now();
        if (!shouldAttempt(state.backoff, now)) continue;
        let adapter: Awaited<ReturnType<typeof getAdapter>>;
        try {
          adapter = await getAdapter(this.db, remote.name);
        } catch (e) {
          this.fail(state, e);
          continue;
        }
        if (typeof adapter.changes !== "function") {
          // fs/OpenDAL: no change feed, the periodic full sweep is all there
          // is (spec rule 3).
          state.hasFeed = false;
          await this.maybeFullSweep(remote.name, state, now);
          continue;
        }
        state.hasFeed = true;
        try {
          const res = await runRemoteWatchTick(this.db, {
            remoteName: remote.name,
            userId: this.userId,
            adapter,
            fullSweep: (nodeIds) => {
              state.lastFullSweepAt = this.now();
              return this.runCatchUp(nodeIds);
            },
          });
          state.lastTickAt = this.now();
          state.backoff = initialBackoff();
          state.lastError =
            res.applied.errors.length > 0 ? res.applied.errors[0].error : null;
          state.cursorUpdatedAt = (await getRemoteCursor(this.db, remote.name))?.updated_at ?? null;
          await this.maybeFullSweep(remote.name, state, this.now());
        } catch (e) {
          this.fail(state, e);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private stateFor(name: string): RemoteState {
    let s = this.states.get(name);
    if (!s) {
      s = {
        hasFeed: true,
        backoff: initialBackoff(),
        lastTickAt: null,
        lastError: null,
        lastFullSweepAt: null,
        cursorUpdatedAt: null,
      };
      this.states.set(name, s);
    }
    return s;
  }

  private fail(state: RemoteState, e: unknown): void {
    const now = this.now();
    state.lastTickAt = now;
    state.lastError = e instanceof Error ? e.message : String(e);
    const failures = state.backoff.consecutiveFailures + 1;
    state.backoff = {
      consecutiveFailures: failures,
      nextAttemptAt: now + backoffMsFor(failures, this.intervalMs, MAX_BACKOFF_MS),
    };
    console.warn(`[portuni:remote-watch] tick failed: ${state.lastError}`);
  }

  private async maybeFullSweep(remoteName: string, state: RemoteState, now: number): Promise<void> {
    if (state.lastFullSweepAt !== null && now - state.lastFullSweepAt < this.sweepIntervalMs) return;
    state.lastFullSweepAt = now;
    const nodes = await watchedNodesForRemote(this.db, remoteName);
    await this.runCatchUp(nodes.map((n) => n.nodeId));
  }

  // Fire the first tick immediately, then reschedule one interval after each
  // finishes (never overlapping, unlike a bare setInterval).
  start(): void {
    const loop = (): void => {
      if (this.stopped) return;
      void this.tick()
        .catch((e) => console.error("[portuni:remote-watch]", e))
        .finally(() => {
          if (this.stopped) return;
          this.schedule(loop, this.intervalMs).unref?.();
        });
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
  }
}

export function startRemoteWatcher(): RemoteWatchLoop | null {
  if (authMode() !== "google") return null;
  const loop = new RemoteWatchLoop();
  loop.start();
  console.log("[portuni:remote-watch] remote watcher active");
  return loop;
}
