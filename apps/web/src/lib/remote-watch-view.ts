// The Nastavení › Synchronizace watcher line (#339), as a pure function so
// its three states are testable without rendering anything.
//
// The watcher itself runs on central only (spec rule 5,
// docs/superpowers/specs/2026-09-12-remote-watcher-design.md), so a local
// workspace gets `{remotes: []}` from GET /sync/watch and renders no line
// at all -- that state is the absence of an entry here, not a variant of
// one.
import type { RemoteWatchStatus } from "../types";

export type RemoteWatchTone = "ok" | "idle" | "error";

export type RemoteWatchLine = {
  remote_name: string;
  tone: RemoteWatchTone;
  text: string;
  // Present only while the remote is backing off after a failed tick.
  retry: string | null;
};

// "před 2 min" / "před 3 h" / "za 5 min". Seconds below a minute read as
// "právě teď" -- a watcher tick is a minute apart, so anything finer is
// noise.
export function relativeCzech(fromMs: number, nowMs: number): string {
  const deltaS = Math.round((nowMs - fromMs) / 1000);
  const ago = deltaS >= 0;
  const s = Math.abs(deltaS);
  if (s < 60) return ago ? "právě teď" : "za chvíli";
  const unit = amountCzech(s);
  return ago ? `před ${unit}` : `za ${unit}`;
}

function amountCzech(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 den" : d < 5 ? `${d} dny` : `${d} dnů`;
}

function parse(ts: string | null): number | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function remoteWatchLine(s: RemoteWatchStatus, nowMs: number): RemoteWatchLine {
  const backoffMs = parse(s.backoff_until);
  const retry =
    backoffMs !== null && backoffMs > nowMs ? `další pokus ${relativeCzech(backoffMs, nowMs)}` : null;
  if (s.last_error) {
    return {
      remote_name: s.remote_name,
      tone: "error",
      text: `${s.remote_name}: sledování hlásí chybu – ${s.last_error}`,
      retry,
    };
  }
  if (!s.watching) {
    // A backend with no change feed (fs/OpenDAL): the periodic full sweep
    // is all there is for it.
    const sweep = parse(s.last_full_sweep_at);
    return {
      remote_name: s.remote_name,
      tone: "idle",
      text:
        `${s.remote_name}: bez sledování změn, jen pravidelná kontrola` +
        (sweep === null ? "" : ` (naposledy ${relativeCzech(sweep, nowMs)})`),
      retry,
    };
  }
  const cursor = parse(s.cursor_updated_at);
  const tick = parse(s.last_tick_at);
  const detail =
    cursor !== null
      ? `poslední změna ${relativeCzech(cursor, nowMs)}`
      : tick !== null
        ? `zatím žádná změna, kontrola ${relativeCzech(tick, nowMs)}`
        : "zatím bez kontroly";
  return {
    remote_name: s.remote_name,
    tone: "ok",
    text: `${s.remote_name} sledován, ${detail}`,
    retry,
  };
}

// The sidebar / sync-overview signal that follows the watcher (spec rule
// 2): how many nodes hold records whose remote copy this device has not
// pulled yet. Counted over nodes, not files -- the badge points at where to
// look, the node detail says how much.
export function pullNodeCount(nodes: Array<{ pull: number }>): number {
  return nodes.filter((n) => n.pull > 0).length;
}
