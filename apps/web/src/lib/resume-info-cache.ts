// Resume-info once per suspension (docs/superpowers/specs/
// 2026-11-05-client-traffic-contract.md, rule 4). The Relace tab shows,
// for a suspended row, whether its conversation is still resumable. One
// window-wide cache keyed by session id, shared between rows asking at
// once; a failed fetch is not kept. The answer changes when the thread runs
// again and suspends anew -- App.tsx's frame listener invalidates the id on
// every frame that moves it out of `suspended` -- and its handoff part
// describes a file on disk, so an answer older than RESUME_INFO_TTL_MS is
// asked for again.

import type { SessionResumeInfo } from "../types";

export const RESUME_INFO_TTL_MS = 60_000;

const cache = new Map<string, { promise: Promise<SessionResumeInfo>; at: number }>();

export function cachedResumeInfo(
  sessionId: string,
  fetcher: (id: string) => Promise<SessionResumeInfo>,
  now = Date.now(),
): Promise<SessionResumeInfo> {
  const hit = cache.get(sessionId);
  if (hit && now - hit.at < RESUME_INFO_TTL_MS) return hit.promise;
  const entry = {
    at: now,
    promise: fetcher(sessionId).catch((err: unknown) => {
      if (cache.get(sessionId) === entry) cache.delete(sessionId);
      throw err;
    }),
  };
  cache.set(sessionId, entry);
  return entry.promise;
}

// The thread ran again: whatever the row knew about resuming it is over.
export function invalidateResumeInfo(sessionId: string): void {
  cache.delete(sessionId);
}

export function resetResumeInfoCacheForTesting(): void {
  cache.clear();
}
