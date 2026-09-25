// The Nastavení › Synchronizace watcher line (#339), as a pure function so
// its three states are testable without rendering anything.
//
// The watcher itself runs on central only (spec rule 5,
// docs/superpowers/specs/2026-09-12-remote-watcher-design.md), so a local
// workspace gets `{remotes: []}` from GET /sync/watch and renders no line
// at all -- that state is the absence of an entry here, not a variant of
// one.
import type { RemoteWatchStatus } from "../types";
import { formatRelative, parseServerTimestamp } from "./format";

export type RemoteWatchTone = "ok" | "idle" | "error";

export type RemoteWatchLine = {
  remote_name: string;
  tone: RemoteWatchTone;
  text: string;
  // Present while the remote is backing off after a failed tick, or (with
  // the feed healthy) while the catch-up sweep is backing off.
  retry: string | null;
};

function parse(ts: string | null): number | null {
  return parseServerTimestamp(ts)?.getTime() ?? null;
}

function retryAt(until: string | null, nowMs: number, locale: string): string | null {
  const ms = parse(until);
  return ms !== null && ms > nowMs ? `další pokus ${formatRelative(locale, ms, nowMs)}` : null;
}

export function remoteWatchLine(s: RemoteWatchStatus, nowMs: number, locale: string): RemoteWatchLine {
  if (s.last_error) {
    return {
      remote_name: s.remote_name,
      tone: "error",
      text: `${s.remote_name}: sledování hlásí chybu – ${s.last_error}`,
      retry: retryAt(s.backoff_until, nowMs, locale),
    };
  }
  // The catch-up sweep failing is not the feed failing (#422): live changes
  // still land, so the feed's own line stays and the sweep's error is added
  // to it, with the sweep's retry.
  const sweepError = s.sweep_error ? `pravidelná kontrola hlásí chybu – ${s.sweep_error}` : null;
  const sweepRetry = sweepError ? retryAt(s.sweep_backoff_until, nowMs, locale) : null;
  if (!s.watching) {
    // A backend with no change feed (fs/OpenDAL): the periodic full sweep
    // is all there is for it.
    const sweep = parse(s.last_full_sweep_at);
    return {
      remote_name: s.remote_name,
      tone: sweepError ? "error" : "idle",
      text: sweepError
        ? `${s.remote_name}: bez sledování změn, ${sweepError}`
        : `${s.remote_name}: bez sledování změn, jen pravidelná kontrola` +
          (sweep === null ? "" : ` (naposledy ${formatRelative(locale, sweep, nowMs)})`),
      retry: sweepRetry,
    };
  }
  const cursor = parse(s.cursor_updated_at);
  const tick = parse(s.last_tick_at);
  const detail =
    cursor !== null
      ? `poslední změna ${formatRelative(locale, cursor, nowMs)}`
      : tick !== null
        ? `zatím žádná změna, kontrola ${formatRelative(locale, tick, nowMs)}`
        : "zatím bez kontroly";
  return {
    remote_name: s.remote_name,
    tone: sweepError ? "error" : "ok",
    text: `${s.remote_name} sledován, ${detail}` + (sweepError ? `; ${sweepError}` : ""),
    retry: sweepRetry,
  };
}

// The sidebar / sync-overview signal that follows the watcher (spec rule
// 2): how many nodes hold records whose remote copy this device has not
// pulled yet. Counted over nodes, not files -- the badge points at where to
// look, the node detail says how much.
export function pullNodeCount(nodes: Array<{ pull: number }>): number {
  return nodes.filter((n) => n.pull > 0).length;
}
