// Composition root for the mirror watcher: wires infra (graph db, SOLO_USER)
// to the domain watcher. Kept out of the entry files so index.ts (standalone,
// opt-in) and desktop.ts (sidecar, default-on) share one wiring.
//
// Solo (env auth) only: the watcher tracks a single local user's mirrors;
// central/google mode has no local mirrors. Exactly one watcher should run
// per machine -- the desktop sidecar and the standalone server share the same
// sync.db, so the standalone server defaults OFF to avoid double reconcile.

import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import { authMode } from "../infra/server-config.js";
import {
  createMirrorWatcher,
  type MirrorWatcher,
} from "../domain/sync/mirror-watcher.js";

// Same cadence as the central-mode agent's backfillSweep (desktop.ts) --
// local mode previously had no periodic sweep at all (#273), only the
// start-time backfill and whatever refresh() picks up when a mirror is
// newly registered. This is the safety net for a watcher event lost under
// load (fs.watch's recursive mode can drop events on a big enough burst).
const SWEEP_INTERVAL_MS = 10 * 60_000;

export function startMirrorWatcher(enabled: boolean): MirrorWatcher | null {
  if (!enabled) return null;
  if (authMode() !== "env") return null;
  const watcher = createMirrorWatcher({
    db: getDb(),
    userId: SOLO_USER,
    onError: (e) => console.error("[portuni:watch]", e),
  });
  watcher
    .start()
    .then(() => console.log("[portuni:watch] mirror watcher active"))
    .catch((e) => console.error("[portuni:watch] start failed:", e));
  setInterval(() => {
    void watcher.sweep().catch((e) => console.error("[portuni:watch] periodic sweep failed:", e));
  }, SWEEP_INTERVAL_MS).unref();
  return watcher;
}
