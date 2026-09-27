// The Nastavení › Synchronizace watcher line (#339), as a pure function so
// its three states are testable without rendering anything.
//
// The watcher itself runs on central only (spec rule 5,
// docs/superpowers/specs/2026-09-12-remote-watcher-design.md), so a local
// workspace gets `{remotes: []}` from GET /sync/watch and renders no line
// at all -- that state is the absence of an entry here, not a variant of
// one.
import type { TFunction } from "i18next";
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

type FilesT = TFunction<"files">;

function retryAt(until: string | null, nowMs: number, locale: string, t: FilesT): string | null {
  const ms = parse(until);
  return ms !== null && ms > nowMs
    ? t(($) => $.remote_watch.retry, { ns: "files", when: formatRelative(locale, ms, nowMs) })
    : null;
}

// Every line is one whole sentence per state; the remote's name, the
// relative times and the watcher's own error text (`last_error`,
// `sweep_error`) are placeholder values, never pieces of the sentence.
export function remoteWatchLine(
  s: RemoteWatchStatus,
  nowMs: number,
  locale: string,
  t: FilesT,
): RemoteWatchLine {
  const remote = s.remote_name;
  if (s.last_error) {
    return {
      remote_name: remote,
      tone: "error",
      text: t(($) => $.remote_watch.error, { ns: "files", remote, error: s.last_error }),
      retry: retryAt(s.backoff_until, nowMs, locale, t),
    };
  }
  // The catch-up sweep failing is not the feed failing (#422): live changes
  // still land, so the feed's own line stays and the sweep's error is added
  // to it, with the sweep's retry.
  const sweepError = s.sweep_error || null;
  const sweepRetry = sweepError ? retryAt(s.sweep_backoff_until, nowMs, locale, t) : null;
  if (!s.watching) {
    // A backend with no change feed (fs/OpenDAL): the periodic full sweep
    // is all there is for it.
    const sweep = parse(s.last_full_sweep_at);
    return {
      remote_name: remote,
      tone: sweepError ? "error" : "idle",
      text: sweepError
        ? t(($) => $.remote_watch.unwatched.sweep_error, { ns: "files", remote, error: sweepError })
        : sweep === null
          ? t(($) => $.remote_watch.unwatched.sweep_only, { ns: "files", remote })
          : t(($) => $.remote_watch.unwatched.sweep_last, {
              ns: "files",
              remote,
              when: formatRelative(locale, sweep, nowMs),
            }),
      retry: sweepRetry,
    };
  }
  const cursor = parse(s.cursor_updated_at);
  const tick = parse(s.last_tick_at);
  let text: string;
  if (cursor !== null) {
    const when = formatRelative(locale, cursor, nowMs);
    text = sweepError
      ? t(($) => $.remote_watch.watched.last_change_sweep_error, { ns: "files", remote, when, error: sweepError })
      : t(($) => $.remote_watch.watched.last_change, { ns: "files", remote, when });
  } else if (tick !== null) {
    const when = formatRelative(locale, tick, nowMs);
    text = sweepError
      ? t(($) => $.remote_watch.watched.no_change_sweep_error, { ns: "files", remote, when, error: sweepError })
      : t(($) => $.remote_watch.watched.no_change, { ns: "files", remote, when });
  } else {
    text = sweepError
      ? t(($) => $.remote_watch.watched.not_checked_sweep_error, { ns: "files", remote, error: sweepError })
      : t(($) => $.remote_watch.watched.not_checked, { ns: "files", remote });
  }
  return { remote_name: remote, tone: sweepError ? "error" : "ok", text, retry: sweepRetry };
}

// The sidebar / sync-overview signal that follows the watcher (spec rule
// 2): how many nodes hold records whose remote copy this device has not
// pulled yet. Counted over nodes, not files -- the badge points at where to
// look, the node detail says how much.
export function pullNodeCount(nodes: Array<{ pull: number }>): number {
  return nodes.filter((n) => n.pull > 0).length;
}
