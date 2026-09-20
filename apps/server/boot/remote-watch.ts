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
import { awaitSyncJob, startSyncJob } from "../domain/sync/sync-jobs.js";
import {
  catchUpSweepNode,
  getRemoteCursor,
  runRemoteWatchTick,
  watchedNodesForRemote,
} from "../domain/sync/remote-watcher.js";
import type { RemoteWatchStatus } from "../shared/api-types.js";
import {
  isoFromDbTimestamp,
  setRemoteWatchStatusSource,
} from "../domain/sync/remote-watch-status.js";
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

// What GET /sync/watch (#339) reports per remote; the shape itself lives in
// shared/api-types.ts, since it is a REST response the web reads too.
export type { RemoteWatchStatus } from "../shared/api-types.js";

interface RemoteState {
  // false for a backend with no change feed (fs/OpenDAL): the periodic full
  // sweep is all there is for it (spec rule 3).
  hasFeed: boolean;
  backoff: BackoffState;
  lastTickAt: number | null;
  lastError: string | null;
  // When the last catch-up sweep FINISHED clean. A sweep that is still
  // running, or one that ended with a node error, leaves this untouched, so
  // the next tick sweeps again instead of waiting out the 6 h interval on
  // the strength of a job that never worked (#417).
  lastFullSweepAt: number | null;
  sweepInFlight: boolean;
  cursorUpdatedAt: string | null;
}

export interface RemoteWatchOptions {
  db?: DbClient;
  userId?: string;
  intervalMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => { unref?: () => void };
  // Runs the catch-up sweep for these nodes and resolves once it has
  // actually finished; it rejects when a node of the sweep failed. Defaults
  // to the sync-jobs worker pool, which is what keeps a catch-up from
  // overlapping a user-triggered sync of the same node.
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
      (async (nodeIds) => {
        if (nodeIds.length === 0) return;
        const started = startSyncJob({
          userId: this.userId,
          nodeIds,
          runNode: (nodeId) => catchUpSweepNode(this.db, { userId: this.userId, nodeId }),
        });
        // Starting the job is not evidence that it worked: wait for it and
        // surface the first node error, so a failed sweep is not recorded
        // as a successful one and retried only 6 h later (#417).
        const finished = await awaitSyncJob(started.id);
        const errored = finished?.nodes.find((n) => n.status === "error");
        if (errored) {
          throw new Error(`catch-up sweep failed for ${errored.node_id}: ${errored.error ?? "unknown error"}`);
        }
      });
  }

  status(): RemoteWatchStatus[] {
    const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
    return Array.from(this.states.entries()).map(([remote_name, s]) => ({
      remote_name,
      watching: s.hasFeed && s.lastError === null,
      cursor_updated_at: isoFromDbTimestamp(s.cursorUpdatedAt),
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
          // The tick's own baseline/reset branches ask for a sweep; a tick
          // that did keeps its hands off maybeFullSweep below, so one pass
          // never starts two.
          let sweptByTick = false;
          const res = await runRemoteWatchTick(this.db, {
            remoteName: remote.name,
            userId: this.userId,
            adapter,
            fullSweep: (nodeIds) => {
              sweptByTick = true;
              this.beginCatchUp(state, nodeIds);
            },
          });
          state.cursorUpdatedAt = (await getRemoteCursor(this.db, remote.name))?.updated_at ?? null;
          if (res.applied.errors.length > 0) {
            // A per-file error (Drive 429/5xx on stat/get, a dropped
            // connection) leaves the cursor unpersisted by design, so the
            // SAME batch replays next tick. Without a backoff that is one
            // replay a minute forever against a remote that is already
            // refusing (#417) -- treat it exactly like a thrown tick.
            this.fail(state, new Error(res.applied.errors[0].error));
          } else {
            state.lastTickAt = this.now();
            state.backoff = initialBackoff();
            state.lastError = null;
            if (!sweptByTick) await this.maybeFullSweep(remote.name, state, this.now());
          }
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
        sweepInFlight: false,
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
    if (state.sweepInFlight) return;
    if (state.lastFullSweepAt !== null && now - state.lastFullSweepAt < this.sweepIntervalMs) return;
    const nodes = await watchedNodesForRemote(this.db, remoteName);
    this.beginCatchUp(state, nodes.map((n) => n.nodeId));
  }

  // Start a catch-up sweep and record its OUTCOME when it lands, without
  // holding the tick open for it: the sweep is a whole-workspace job and a
  // tick is a 60 s heartbeat. Only a sweep that finished with no node error
  // counts as a sweep (#417); a failed one leaves lastFullSweepAt alone, so
  // the next tick tries again, and surfaces its error in GET /sync/watch.
  private beginCatchUp(state: RemoteState, nodeIds: string[]): void {
    state.sweepInFlight = true;
    void Promise.resolve()
      .then(() => this.runCatchUp(nodeIds))
      .then(
        () => {
          state.lastFullSweepAt = this.now();
        },
        (e: unknown) => {
          state.lastError = e instanceof Error ? e.message : String(e);
          console.warn(`[portuni:remote-watch] catch-up sweep failed: ${state.lastError}`);
        },
      )
      .finally(() => {
        state.sweepInFlight = false;
      });
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
  // GET /sync/watch reads the loop's live state through this seam; nothing
  // registers it on a server that never starts the loop, so the route
  // answers an empty list there.
  setRemoteWatchStatusSource(() => loop.status());
  loop.start();
  console.log("[portuni:remote-watch] remote watcher active");
  return loop;
}
