// Pure rules of Přehled (OverviewView.tsx; docs/superpowers/specs/
// 2026-09-21-task-surface-v2-design.md, "Přehled"): the row cap per card,
// threads vs hand-opened CLI sessions in the Relace card, the counter
// strip. Dependency-free so test/overview-view-helpers.test.ts covers them.

import type { OverviewSessionRow } from "../types";
import { isThreadSession, sortInboxSessions } from "./session-views";

// Every card lists at most this many rows; the rest sits behind
// "Zobrazit všech N", which expands the card in place.
export const OVERVIEW_ROW_CAP = 8;

export function capRows<T>(rows: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || rows.length <= OVERVIEW_ROW_CAP) return { shown: [...rows], hidden: 0 };
  return { shown: rows.slice(0, OVERVIEW_ROW_CAP), hidden: rows.length - OVERVIEW_ROW_CAP };
}

// Rule 7: a hand-opened CLI session is not a thread. Relace lists threads
// and says how many CLI sessions there are besides.
export function splitThreadsAndCli<
  T extends { session_type: string; cli: string | null; runner: string | null; state: string },
>(
  rows: readonly T[],
): { threads: T[]; cli: { total: number; running: number } } {
  const threads: T[] = [];
  let total = 0;
  let running = 0;
  for (const r of rows) {
    if (isThreadSession(r)) {
      threads.push(r);
    } else {
      total++;
      if (r.state === "running") running++;
    }
  }
  return { threads, cli: { total, running } };
}

export type OverviewCounters = { waiting: number; running: number; attention: number; unsynced: number };

// The strip's numbers: the caller's own threads by what they need, the
// attention card's row count, the unsynced total from /sync/pending.
export function overviewCounters(
  running: readonly OverviewSessionRow[],
  suspended: readonly OverviewSessionRow[],
  attention: number,
  unsynced: number,
): OverviewCounters {
  const mine = sortInboxSessions(running, suspended).filter(isThreadSession);
  return {
    waiting: mine.filter((s) => s.state === "running" && s.waiting_since !== null).length,
    running: mine.filter((s) => s.state === "running" && s.waiting_since === null).length,
    attention,
    unsynced,
  };
}
