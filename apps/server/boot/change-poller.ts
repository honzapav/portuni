// The sync agent's long-poll of central's change feed (docs/superpowers/
// specs/2026-11-05-client-traffic-contract.md, rule 3): one GET /changes
// that waits up to CHANGE_WAIT_S for the next change, then the next one --
// one request per change or per wait, in place of the window's per-node
// polls. A failure backs off (5 s doubling to 5 min); a 429 waits out the
// Retry-After central sent; a `reset` (central restarted, or the cursor
// fell behind) is handed on so the window refetches what it shows once.

import { CentralHttpError } from "../domain/sync/central/client.js";
import type { ChangesResponse } from "../shared/api-types.js";

export const CHANGE_WAIT_S = 20;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

export type ChangePoller = { run(): Promise<void>; start(): void; stop(): void };

export function createChangePoller(deps: {
  fetchChanges: (since: string | null, waitSeconds: number) => Promise<ChangesResponse>;
  onChanges: (changes: ChangesResponse["changes"], reset: boolean) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}): ChangePoller {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const log = deps.log ?? ((m: string) => console.error(m));
  let stopped = false;
  let cursor: string | null = null;
  let backoff = BACKOFF_MIN_MS;

  async function run(): Promise<void> {
    stopped = false;
    while (!stopped) {
      try {
        const r = await deps.fetchChanges(cursor, CHANGE_WAIT_S);
        cursor = r.cursor;
        backoff = BACKOFF_MIN_MS;
        if (r.reset || r.changes.length > 0) deps.onChanges(r.changes, r.reset);
      } catch (err) {
        if (stopped) return;
        if (err instanceof CentralHttpError && err.status === 429) {
          const s = Number(err.params?.retryAfterSeconds);
          const waitMs = Number.isFinite(s) && s > 0 ? s * 1000 : DEFAULT_RATE_LIMIT_WAIT_MS;
          log(`[portuni:changes] central rate limited the change feed; waiting ${waitMs / 1000} s`);
          await sleep(waitMs);
          continue;
        }
        log(`[portuni:changes] change feed unreachable (${(err as Error).message}); retrying in ${backoff / 1000} s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  return {
    run,
    start() {
      void run();
    },
    stop() {
      stopped = true;
    },
  };
}
