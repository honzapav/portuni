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
import { authMode } from "../infra/auth-config.js";
import { tryCleanStaleMirrors } from "../domain/sync/mirror-registry.js";
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

// #635: a mirror of a node that is gone from the graph db would otherwise
// be backfilled (and fail) at every start and every sweep, forever. Its
// registration is dropped, logged once with the folder; files stay.
export async function cleanStaleMirrorsLogged(
  db: Parameters<typeof tryCleanStaleMirrors>[0],
  userId: string,
  tag: string,
  log: Pick<Console, "warn"> = console,
): Promise<void> {
  const report = await tryCleanStaleMirrors(db, userId);
  for (const m of report.removedMirrors) {
    log.warn(
      `[${tag}] node ${m.node_id} no longer exists; unregistered its mirror ${m.local_path} (files stay on disk)`,
    );
  }
}

export function startMirrorWatcher(enabled: boolean): MirrorWatcher | null {
  if (!enabled) return null;
  if (authMode() !== "env") return null;
  const watcher = createMirrorWatcher({
    db: getDb(),
    userId: SOLO_USER,
    onError: (e) => console.error("[portuni:watch]", e),
  });
  // Stale registrations go before the watcher's start-time backfill, so it
  // never walks a mirror whose node is gone.
  cleanStaleMirrorsLogged(getDb(), SOLO_USER, "portuni:watch")
    .catch((e) => console.error("[portuni:watch] stale mirror cleanup failed:", e))
    .then(() => watcher.start())
    .then(() => console.log("[portuni:watch] mirror watcher active"))
    .catch((e) => console.error("[portuni:watch] start failed:", e));
  setInterval(() => {
    void cleanStaleMirrorsLogged(getDb(), SOLO_USER, "portuni:watch")
      .catch((e) => console.error("[portuni:watch] stale mirror cleanup failed:", e))
      .then(() => watcher.sweep())
      .catch((e) => console.error("[portuni:watch] periodic sweep failed:", e));
  }, SWEEP_INTERVAL_MS).unref();
  return watcher;
}
