// Resume-info once per suspension and once per tab (docs/superpowers/
// specs/2026-11-05-client-traffic-contract.md, rules 4 and 6). The Relace
// tab shows, for a suspended row, whether its conversation is still
// resumable: it asks POST /sessions/resume-info for every suspended row
// without a fresh answer here, primes this window-wide cache, and the rows
// read it. The answer changes when the thread runs again and suspends
// anew -- App.tsx's frame listener invalidates the id on every frame that
// moves it out of `suspended` -- and its handoff part describes a file on
// disk, so an answer older than RESUME_INFO_TTL_MS is asked for again.

import type { SessionResumeInfo } from "../types";

export const RESUME_INFO_TTL_MS = 60_000;

const cache = new Map<string, { info: SessionResumeInfo; at: number }>();

export function primeResumeInfo(infos: readonly SessionResumeInfo[], now = Date.now()): void {
  for (const info of infos) cache.set(info.session_id, { info, at: now });
}

export function peekResumeInfo(sessionId: string, now = Date.now()): SessionResumeInfo | null {
  const hit = cache.get(sessionId);
  return hit && now - hit.at < RESUME_INFO_TTL_MS ? hit.info : null;
}

// The suspended rows the tab has no fresh answer for, in row order.
export function resumeInfoIdsToAsk(rows: readonly { id: string; state: string }[], now = Date.now()): string[] {
  return rows.filter((r) => r.state === "suspended" && peekResumeInfo(r.id, now) === null).map((r) => r.id);
}

// The thread ran again: whatever the row knew about resuming it is over.
export function invalidateResumeInfo(sessionId: string): void {
  cache.delete(sessionId);
}

export function resetResumeInfoCacheForTesting(): void {
  cache.clear();
}
