// Entry point. Loads varlock-managed env (TURSO_*, AUTH_TOKEN, ...),
// runs schema migrations, then starts the HTTP listener that mounts both
// the REST API and the MCP transport.

import "varlock/auto-load";
import { ensureSchema } from "./infra/schema.js";
import { startHttpServer } from "./http/server.js";
import { startMirrorWatcher } from "./boot/mirror-watch.js";
import { startRemoteWatcher } from "./boot/remote-watch.js";
import { sweepOrphanedRunsOnBoot } from "./boot/run-sweep.js";
import {
  startIdleRunSweep,
  sweepStaleDraftSessionsOnBoot,
  sweepStaleRunningSessionsOnBoot,
} from "./boot/session-sweep.js";
import { warnIfLocalWorkspaceHasStaleRemotesOnBoot } from "./boot/local-mode-remote-warning.js";
import { registerRunnerAdapters } from "./boot/register-runner-adapters.js";
import { getSessionRuntime } from "./boot/session-runtime.js";

async function main() {
  await ensureSchema();
  registerRunnerAdapters();
  startHttpServer();
  // Standalone server: opt in with PORTUNI_WATCH_MIRRORS=1. Default off so it
  // never double-reconciles against a desktop sidecar sharing the same
  // sync.db. Design: docs/archive/specs/2026-06-28-deterministic-file-state-design.md.
  const watcher = startMirrorWatcher(process.env.PORTUNI_WATCH_MIRRORS === "1");
  if (watcher) process.on("SIGINT", () => watcher.stop());
  // Central only (PORTUNI_AUTH_MODE=google): observes each remote's change
  // feed and keeps `files` current, so a device reads `pull` without anyone
  // running a sync. #338.
  const remoteWatcher = startRemoteWatcher();
  if (remoteWatcher) process.on("SIGINT", () => remoteWatcher.stop());
  // Must finish before sweepStaleRunningSessionsOnBoot: this sweep already
  // resolves any 'running' session a runner task was driving, so the other
  // sweep's own query for stale 'running' rows sees an already-correct
  // picture instead of racing it.
  void sweepOrphanedRunsOnBoot().then(() => sweepStaleRunningSessionsOnBoot());
  void sweepStaleDraftSessionsOnBoot();
  void warnIfLocalWorkspaceHasStaleRemotesOnBoot();
  // #378: a live run with no activity for PORTUNI_RUN_IDLE_MS gets ended
  // and its summary written -- an interval outside the runtime itself,
  // same shape as every other boot sweep here.
  startIdleRunSweep(getSessionRuntime());
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
