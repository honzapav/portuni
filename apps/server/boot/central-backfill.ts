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
//
// A failure every other request of the round would get too (no network, a
// 429 from central's per-token limiter, a 401 for the token) ends the
// round on the spot: asking the next mirror -- or, after a failed batch,
// every mirror one by one -- only spends more of the same budget and
// writes the same error again (#633 review). See roundFailureOf.

import type { CentralClient } from "../domain/sync/central/client.js";
import { CentralHttpError, CentralUnreachableError } from "../domain/sync/central/client.js";
import {
  listUntrackedLocalCentral,
  mapConcurrent,
  reconcilePathCentral,
  syncInfoByNode,
} from "../domain/sync/central/engine-central.js";
import type { NodeSyncInfo } from "../domain/sync/sync-remote-api.js";
import { listUserMirrors, unregisterMirror } from "../domain/sync/mirror-registry.js";
import {
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
      // Central's answer holds for the rest of the mirror too (429, 401,
      // no network): hand it to the caller, which ends the round (the
      // sweep) or logs it once (the watcher's backfillMirror seam). A file
      // this device cannot read (EACCES, deleted while hashed) is about
      // that file only and never ends the round.
      if (isCentralRoundFailure(e)) throw e;
      console.error(`[portuni:watch] central backfill reconcile failed for ${u.local_path}:`, e);
    }
  }
}

// Central answered that the node does not exist (or is not visible to this
// user, which central reports the same way). Nothing else qualifies.
function isNodeNotFound(e: unknown): boolean {
  return e instanceof CentralHttpError && e.status === 404 && e.code === "NODE_NOT_FOUND";
}

// What one failed central call means for the rest of the sweep's round.
// `null`: central answered about this one request (404, 409, 5xx, a bad
// body) -- other mirrors may well succeed, and a failed batch falls back to
// one request per mirror. Anything else holds for every request the round
// would still send with this token, so the round stops. (The sweep's own
// calls go to central only, so anything that is not an answer counts as
// unreachable there, as before; the per-file reconcile inside a mirror
// rethrows only isCentralRoundFailure.)
export type RoundFailure =
  | { kind: "unreachable" }
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "refused"; status: number };

// Central's limiter answers 429 RATE_LIMITED with Retry-After and the same
// value as params.retryAfterSeconds (http/server.ts); the client keeps the
// params, not the header. Without one, a minute (the limiter's window).
const DEFAULT_RETRY_AFTER_MS = 60_000;

export function roundFailureOf(e: unknown): RoundFailure | null {
  if (isUnreachableError(e)) return { kind: "unreachable" };
  const err = e as CentralHttpError;
  if (err.status === 429) {
    const s = Number(err.params?.retryAfterSeconds);
    return {
      kind: "rate_limited",
      retryAfterMs: Number.isFinite(s) && s > 0 ? s * 1000 : DEFAULT_RETRY_AFTER_MS,
    };
  }
  // 401 only: central's 403s name one node or route (WRITE_REFUSED with a
  // nodeId, FORBIDDEN with a requiredScope), so other mirrors may pass.
  if (err.status === 401) return { kind: "refused", status: err.status };
  return null;
}

// A failure from talking to central, as opposed to one from this device's
// own disk or db: an answer that holds for the round, or no answer at all
// (CentralUnreachableError, which the client throws for every network
// failure whatever the runtime's fetch error looks like).
export function isCentralRoundFailure(e: unknown): boolean {
  if (e instanceof CentralUnreachableError) return true;
  return e instanceof CentralHttpError && roundFailureOf(e) !== null;
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
      // Set by the first call whose failure holds for the whole round
      // (roundFailureOf): the remaining mirrors would all fail the same
      // way, so they are skipped rather than asked -- 26 mirrors x 2
      // (client-side retry) doomed connects per round is what buried the
      // log, and on a 429 every further request only extends the limit.
      let stop: RoundFailure | null = null;
      // #633: one POST /sync/info-batch for every mirror instead of one
      // GET /nodes/:id/sync-info each -- at boot this ran alongside the
      // config refresh and the first MCP connects, all on the same token's
      // per-minute budget. A node the batch omits falls back to its own GET,
      // which is what reports NODE_NOT_FOUND for an unknown node; so does
      // every node when central answered the batch with a per-request error
      // (an older central without the route, a 403, a 5xx), never when the
      // answer holds for the round (429, 401, no network).
      let infos = new Map<string, NodeSyncInfo>();
      if (mirrors.length > 0) {
        try {
          infos = await syncInfoByNode(
            client,
            mirrors.map((m) => m.node_id),
          );
        } catch (e) {
          stop = roundFailureOf(e);
          if (!stop) log.error(`[${tag}] central sync-info batch failed, asking per mirror:`, e);
        }
      }
      await mapConcurrent(mirrors, 4, async (m) => {
        if (stop) return;
        try {
          await centralBackfillMirror(client, userId, m, infos.get(m.node_id));
        } catch (e) {
          const failure = roundFailureOf(e);
          if (failure) {
            stop ??= failure;
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
      // ONE line, no stack trace, whatever stopped the round: being
      // offline or rate limited is a condition, not an error report. The
      // stack was identical for every mirror and carried a source excerpt
      // of the bundled sidecar with it.
      const failure = stop as RoundFailure | null;
      if (failure?.kind === "unreachable" || failure?.kind === "rate_limited") {
        backoff = recordUnreachable(backoff, now());
        if (failure.kind === "rate_limited") {
          // The backoff's first step (10 min) already outlasts any
          // Retry-After central sends (at most its 60 s window); the max
          // keeps that true for whatever a future limiter answers.
          backoff = {
            ...backoff,
            nextAttemptAt: Math.max(backoff.nextAttemptAt, now() + failure.retryAfterMs),
          };
        }
        const why =
          failure.kind === "unreachable"
            ? "central unreachable"
            : `central rate limited this device (retry after ${Math.round(failure.retryAfterMs / 1000)} s)`;
        log.warn(
          `[${tag}] ${why}, skipped ${mirrors.length} mirror(s); next attempt in ${Math.round(
            (backoff.nextAttemptAt - now()) / 60_000,
          )} min`,
        );
      } else if (failure?.kind === "refused") {
        // The token itself was refused (401): no backoff (a re-login fixes it
        // before the next round), but no per-mirror fan-out either.
        backoff = recordReachable(backoff);
        log.warn(
          `[${tag}] central refused this device's token (${failure.status}), skipped ${mirrors.length} mirror(s) this round`,
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
