// Composition root for the startup orphaned-run sweep (#325), same shape as
// boot/session-sweep.ts one level down: run once at boot, log the count,
// never fatal. Called from index.ts and desktop.ts's local (non-agent)
// branch -- the same two call sites as sweepStaleRunningSessionsOnBoot, and
// BEFORE it: this sweep resolves any session a runner task was driving, so
// that sweep's own "sessions still 'running' with no run at all" query sees
// an already-correct picture.

import { getDb } from "../infra/db.js";
import { resolveRunnerDataDir } from "../domain/runner/data-dir.js";
import {
  centralRunSweepBackend,
  localRunSweepBackend,
  sweepOrphanedRunsOn,
  type RunSweepBackend,
} from "../domain/runner/run-sweep.js";
import { createSuspendFallbackCentral } from "../domain/runner/suspend-fallback-central.js";
import { deviceSessionContentStore } from "../domain/runner/store-content.js";
import type { SessionStore } from "../domain/runner/store.js";
import type { CentralClient } from "../domain/sync/central/client.js";

export async function sweepOrphanedRunsOnBoot(backend?: RunSweepBackend): Promise<void> {
  try {
    const result = await sweepOrphanedRunsOn(backend ?? localRunSweepBackend(getDb()), resolveRunnerDataDir());
    if (result.cleaned > 0 || result.staleFilesRemoved > 0) {
      console.log(
        `[boot] run sweep: ${result.cleaned} orphaned run(s) marked host_lost (${result.killed} process(es) signaled), ${result.staleFilesRemoved} stale pid file(s) removed`,
      );
    }
  } catch (e) {
    console.error("[boot] run sweep failed:", e);
  }
}

// #393: a central-mode sidecar spawns the same children and leaves the same
// pid files, but has no graph db -- the run and session records live on
// central. The suspend half reuses the runtime's own agent-mode fallback,
// so an orphaned run is written up exactly the way a live one that timed
// out would be.
export async function sweepOrphanedRunsOnBootCentral(
  store: SessionStore,
  client: CentralClient,
): Promise<void> {
  const content = deviceSessionContentStore();
  const suspend = createSuspendFallbackCentral(store, content, client);
  await sweepOrphanedRunsOnBoot(centralRunSweepBackend(store, content, suspend));
}
