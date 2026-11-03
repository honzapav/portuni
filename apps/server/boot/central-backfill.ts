// The sync agent's backfill sweep (team workspace, PORTUNI_AGENT_MODE=1):
// at boot and every 10 min, register anything on disk the central records
// don't know yet, so files created while the agent was down are tracked.
// Runs in the device's sidecar only; a personal workspace has the watcher's
// own db-backed sweep (boot/mirror-watch.ts) instead.
//
// A mirror whose node central does not know (404 NODE_NOT_FOUND on its
// sync-info) is unregistered here (#635): it used to be asked about at every
// boot and every sweep, forever, and could only be removed by hand from
// .portuni/sync.db. Only the registration goes -- the folder and its files
// stay on disk. Any other failure (network, 5xx, 401, 429) keeps the mirror.

import type { CentralClient } from "../domain/sync/central/client.js";
import { CentralHttpError } from "../domain/sync/central/client.js";
import {
  listUntrackedLocalCentral,
  mapConcurrent,
  reconcilePathCentral,
  syncInfoByNode,
} from "../domain/sync/central/engine-central.js";
import type { NodeSyncInfo } from "../domain/sync/sync-remote-api.js";
import { listUserMirrors, unregisterMirror } from "../domain/sync/mirror-registry.js";
import {
  backoffMsFor,
  initialBackoff,
  isUnreachableError,
  recordReachable,
  recordUnreachable,
  shouldAttempt,
} from "../domain/sync/central/reachability.js";

// Reconcile anything on disk in one mirror that the central records don't
// know yet. Used for the boot backfill sweep and, via the watcher's
// backfillMirror seam, for mirrors registered while running.
//
// Routed through reconcilePathCentral per file (#253), not a batch
// client.registerFiles call: a live watcher pairs an on-disk mv by inode via
// tryApplyDiskMoveCentral, but that never runs for a mv that happened while
// the agent was down (or missed a directory-level watcher event, which only
// fires once for the directory itself -- see reconcileDirectoryCentral) --
// this backfill sweep is the catch-up path for exactly that case. A raw
// batch register would instead split a moved file into a fresh duplicate
// record, leaving the old one stuck deleted_local with its Drive copy
// orphaned. Sequential, matching the local engine's dbBackfillMirror: one
// unreadable/misbehaving file must not abort backfill for the rest of the
// mirror. reconcilePathCentral's own registration/move paths already cache
// the local hash (registerLocalFileCentral / tryApplyDiskMoveCentral both
// call localHashFor), so there is no separate hash-caching pass needed here.
export async function centralBackfillMirror(
  client: CentralClient,
  userId: string,
  m: { node_id: string },
  // The node's sync-info from the sweep's one batch request (#633); absent
  // when central omitted the node or the batch failed, then this asks for it.
  preloaded?: NodeSyncInfo,
): Promise<void> {
  const untracked = await listUntrackedLocalCentral(
    client,
    { userId, nodeId: m.node_id },
    preloaded,
  );
  for (const u of untracked) {
    try {
      await reconcilePathCentral(client, {
        userId,
        nodeId: u.node_id,
        absPath: u.local_path,
      });
    } catch (e) {
      console.error(`[portuni:watch] central backfill reconcile failed for ${u.local_path}:`, e);
    }
  }
}

// Central answered that the node does not exist (or is not visible to this
// user, which central reports the same way). Nothing else qualifies.
function isNodeNotFound(e: unknown): boolean {
  return e instanceof CentralHttpError && e.status === 404 && e.code === "NODE_NOT_FOUND";
}

export interface CentralBackfillSweepDeps {
  client: CentralClient;
  userId: string;
  // Defaults to console; tests capture the lines.
  log?: Pick<Console, "error" | "warn">;
  now?: () => number;
}

// Returns the sweep function; it keeps its own in-flight guard and the
// unreachable backoff across calls. `tag` prefixes every log line
// ("boot", "sweep").
export function createCentralBackfillSweep(
  deps: CentralBackfillSweepDeps,
): (tag: string) => Promise<void> {
  const { client, userId } = deps;
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  let sweepRunning = false;
  let backoff = initialBackoff();
  return async (tag: string): Promise<void> => {
    if (sweepRunning) return;
    // Central unreachable on the last round: stay quiet until the backoff
    // window opens. A laptop that is asleep or off wifi would otherwise
    // burn one doomed round every 10 minutes, forever.
    if (!shouldAttempt(backoff, now())) return;
    sweepRunning = true;
    try {
      const mirrors = await listUserMirrors(userId);
      // Set by the first mirror whose call fails at the NETWORK level. The
      // remaining mirrors would all fail the same way, so they are skipped
      // rather than asked -- 26 mirrors x 2 (client-side retry) doomed
      // connects per round is what buried the log.
      let unreachable = false;
      // #633: one POST /sync/info-batch for every mirror instead of one
      // GET /nodes/:id/sync-info each -- at boot this ran alongside the
      // config refresh and the first MCP connects, all on the same token's
      // per-minute budget. A node the batch omits falls back to its own GET,
      // which is what reports NODE_NOT_FOUND for an unknown node.
      let infos = new Map<string, NodeSyncInfo>();
      if (mirrors.length > 0) {
        try {
          infos = await syncInfoByNode(
            client,
            mirrors.map((m) => m.node_id),
          );
        } catch (e) {
          if (isUnreachableError(e)) unreachable = true;
          else log.error(`[${tag}] central sync-info batch failed, asking per mirror:`, e);
        }
      }
      await mapConcurrent(mirrors, 4, async (m) => {
        if (unreachable) return;
        try {
          await centralBackfillMirror(client, userId, m, infos.get(m.node_id));
        } catch (e) {
          if (isUnreachableError(e)) {
            unreachable = true;
            return;
          }
          if (isNodeNotFound(e)) {
            // #635: logged once -- the registration is gone afterwards, so
            // the next sweep never asks about this node again.
            try {
              await unregisterMirror(userId, m.node_id);
              log.warn(
                `[${tag}] central does not know node ${m.node_id}; unregistered its mirror ${m.local_path} (files stay on disk)`,
              );
            } catch (ue) {
              log.error(`[${tag}] unregistering mirror of unknown node ${m.node_id} failed:`, ue);
            }
            return;
          }
          // Central answered -- this is a real per-mirror problem, so it
          // keeps its full detail.
          log.error(`[${tag}] central backfill failed for`, m.node_id, e);
        }
      });
      if (unreachable) {
        backoff = recordUnreachable(backoff, now());
        // ONE line, no stack trace: being offline is not an error report,
        // it is a condition. The stack was identical for every mirror and
        // carried a source excerpt of the bundled sidecar with it.
        log.warn(
          `[${tag}] central unreachable, skipped ${mirrors.length} mirror(s); next attempt in ${Math.round(
            backoffMsFor(backoff.consecutiveFailures) / 60_000,
          )} min`,
        );
      } else {
        backoff = recordReachable(backoff);
      }
    } catch (e) {
      log.error(`[${tag}] central backfill skipped:`, e);
    } finally {
      sweepRunning = false;
    }
  };
}
