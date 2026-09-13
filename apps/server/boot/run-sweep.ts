// Composition root for the startup orphaned-run sweep (#325), same shape as
// boot/session-sweep.ts one level down: run once at boot, log the count,
// never fatal. Called from index.ts and desktop.ts's local (non-agent)
// branch -- the same two call sites as sweepStaleRunningSessionsOnBoot, and
// BEFORE it: this sweep resolves any session a runner task was driving, so
// that sweep's own "sessions still 'running' with no run at all" query sees
// an already-correct picture.

import { getDb } from "../infra/db.js";
import { resolveRunnerDataDir } from "../domain/runner/data-dir.js";
import { sweepOrphanedRuns } from "../domain/runner/run-sweep.js";

export async function sweepOrphanedRunsOnBoot(): Promise<void> {
  try {
    const result = await sweepOrphanedRuns(getDb(), resolveRunnerDataDir());
    if (result.cleaned > 0 || result.staleFilesRemoved > 0) {
      console.log(
        `[boot] run sweep: ${result.cleaned} orphaned run(s) marked host_lost (${result.killed} process(es) signaled), ${result.staleFilesRemoved} stale pid file(s) removed`,
      );
    }
  } catch (e) {
    console.error("[boot] run sweep failed:", e);
  }
}
