// Resume-info once per suspension (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 4). The Relace tab shows,
// for a suspended row, whether its conversation is still resumable; that
// answer changes only when the thread is suspended anew, which moves its
// last_active_at. One window-wide cache keyed by id and last_active_at,
// shared between rows asking at once; a failed fetch is not kept.

import type { SessionResumeInfo } from "../types";

const cache = new Map<string, Promise<SessionResumeInfo>>();

export function cachedResumeInfo(
  session: { id: string; state: string; last_active_at: string },
  fetcher: (id: string) => Promise<SessionResumeInfo>,
): Promise<SessionResumeInfo> {
  const key = `${session.id}:${session.last_active_at}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = fetcher(session.id).catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, promise);
  return promise;
}

export function resetResumeInfoCacheForTesting(): void {
  cache.clear();
}
