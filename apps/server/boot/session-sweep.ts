// Composition root for the startup stale-session sweep (#272). Shared by
// index.ts (standalone/central server) and desktop.ts (sidecar), same shape
// as boot/session-projection-sweep.ts -- run once at boot, log the count,
// never fatal. Unlike that sweep this one is not env-mode-only: a `sessions`
// row can be left 'running' after any process restart regardless of auth
// mode or data mode, since the table always exists (schema migration 027).

import { getDb } from "../infra/db.js";
import { closeStaleRunningSessionsOnBoot, pruneStaleDraftSessions } from "../domain/sessions.js";
import type { SessionRuntime } from "../domain/runner/session-runtime.js";

export async function sweepStaleRunningSessionsOnBoot(): Promise<void> {
  try {
    const closed = await closeStaleRunningSessionsOnBoot(getDb());
    if (closed > 0) {
      console.log(`[boot] session sweep closed ${closed} stale 'running' session(s)`);
    }
  } catch (e) {
    console.error("[boot] session sweep failed:", e);
  }
}

// #374: a draft opened and then abandoned (never sent a first message, its
// tab/window closed without an explicit Uzavřít) has no other cleanup
// path -- 24h matches the spec's own "Storage: Prune" cutoff.
export async function sweepStaleDraftSessionsOnBoot(): Promise<void> {
  try {
    const pruned = await pruneStaleDraftSessions(getDb());
    if (pruned > 0) {
      console.log(`[boot] session sweep pruned ${pruned} stale draft session(s)`);
    }
  } catch (e) {
    console.error("[boot] draft session sweep failed:", e);
  }
}

// #378 ("Idle"): "a run with no activity for PORTUNI_RUN_IDLE_MS (default
// 30 min) is ended, its summary written, the session moved to suspended".
// The runtime itself only exposes the one-shot checkIdleRunsOnce (so tests
// call it directly, no timer involved) -- this is the production interval
// that drives it, external to the runtime the same way this whole file's
// other sweeps are. Returns a disposer (clearInterval) purely so a test
// that starts one against a short-lived runtime can stop it; production
// never calls it (the interval is meant to outlive the process).
const DEFAULT_RUN_IDLE_MS = 30 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

function resolveRunIdleMs(): number {
  const raw = process.env.PORTUNI_RUN_IDLE_MS;
  if (!raw) return DEFAULT_RUN_IDLE_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_IDLE_MS;
}

export function startIdleRunSweep(runtime: SessionRuntime): () => void {
  const idleMs = resolveRunIdleMs();
  const timer = setInterval(() => {
    void runtime.checkIdleRunsOnce(idleMs).catch((e) => console.error("[boot] idle-run sweep failed:", e));
  }, IDLE_CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
