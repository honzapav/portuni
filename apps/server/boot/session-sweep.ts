// Composition root for the startup stale-session sweep (#272). Shared by
// index.ts (standalone/central server) and desktop.ts (sidecar), same shape
// as boot/session-projection-sweep.ts -- run once at boot, log the count,
// never fatal. Unlike that sweep this one is not env-mode-only: a `sessions`
// row can be left 'running' after any process restart regardless of auth
// mode or data mode, since the table always exists (schema migration 027).

import { getDb } from "../infra/db.js";
import { closeStaleRunningSessionsOnBoot, pruneStaleDraftSessions } from "../domain/sessions.js";

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
