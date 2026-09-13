// Pure helpers for #343 (runner batch phase 3, second issue -- Relace tab,
// Práce sidebar, Přehled reading live session state): the compact status
// chip used in list/sub-row contexts (distinct wording from
// lib/session-chat.ts's sessionStatusChip, which is SessionChat's own
// header), client-side echoes of the #321 access table for gating action
// buttons, live-state overlay, and Přehled's inbox ordering. Dependency-
// free so test/session-views-helpers.test.ts can exercise it directly.

import type { SessionState, OverviewSessionRow } from "../types";
import type { SessionStateMessage } from "./sessions-client";

export type SessionRowChip = { label: string; color: string; pulsing: boolean };

// Two wordings of the same chip: the compact one for list rows and
// sub-rows, the full one for SessionChat's own header.
export type SessionChipVariant = "row" | "header";

const STATE_LABEL: Record<SessionChipVariant, Record<SessionState, string>> = {
  row: { running: "Běží", suspended: "Pozastaveno", closed: "Hotovo", archived: "Archiv" },
  header: { running: "Běží", suspended: "Pozastaveno", closed: "Uzavřeno", archived: "Archivováno" },
};

const ROW_STATE_COLOR: Record<SessionState, string> = {
  running: "var(--color-status-active)",
  suspended: "var(--color-node-process)",
  closed: "var(--color-text-dim)",
  archived: "var(--color-text-dim)",
};

// "Čeká na mě" (waiting_since set) overrides the plain "Běží" -- a running
// session with an open question is blocked on the user, not doing work.
export function sessionRowChip(
  state: SessionState,
  waitingSince: string | null,
  variant: SessionChipVariant = "row",
): SessionRowChip {
  if (state === "running" && waitingSince !== null) {
    return { label: "Čeká na mě", color: "var(--color-node-process)", pulsing: true };
  }
  return { label: STATE_LABEL[variant][state], color: ROW_STATE_COLOR[state], pulsing: state === "running" };
}

// Client-side echo of #321's access table, for deciding which action
// buttons to offer -- the server is the real enforcement point (a refused
// action just surfaces its own error), this only avoids showing a button
// that would always 403. read (seeing the row at all, since every caller
// here already fetched it via a node/list endpoint gated on node
// visibility) is always true; message/resume are owner-only; stop
// (interrupt/suspend/close) is the owner or anyone with manage scope.
export type SessionRowAccess = { canResume: boolean; canPauseOrClose: boolean };

export function sessionRowAccess(ownerId: string, meId: string | null, canManage: boolean): SessionRowAccess {
  const isOwner = meId !== null && ownerId === meId;
  return { canResume: isOwner, canPauseOrClose: isOwner || canManage };
}

// Overlays a live `session_state` frame onto a REST-fetched summary --
// state/waiting_since only, since that frame carries nothing else. Absent
// live state (nothing has changed since the fetch, or none was ever
// received for this id) returns the input unchanged.
export function applyLiveSessionState<T extends { id: string; state: SessionState; waiting_since: string | null }>(
  session: T,
  liveStates: Readonly<Record<string, SessionStateMessage>>,
): T {
  const live = liveStates[session.id];
  if (!live) return session;
  return { ...session, state: live.state, waiting_since: live.waiting_since };
}

export function mergeLiveSessionStates<T extends { id: string; state: SessionState; waiting_since: string | null }>(
  sessions: readonly T[],
  liveStates: Readonly<Record<string, SessionStateMessage>>,
): T[] {
  return sessions.map((s) => applyLiveSessionState(s, liveStates));
}

// Přehled's Relace card, restricted to the caller's own sessions (the
// team-wide list is the hosts spec's job, not here): waiting ("Čeká na
// mě") first, then running, then suspended -- each bucket keeps the
// server's own last_active_at-descending order.
export function sortInboxSessions(
  running: readonly OverviewSessionRow[],
  suspended: readonly OverviewSessionRow[],
  meId: string | null,
): OverviewSessionRow[] {
  const mine = (s: OverviewSessionRow) => meId !== null && s.user_id === meId;
  const waiting = running.filter((s) => mine(s) && s.waiting_since !== null);
  const active = running.filter((s) => mine(s) && s.waiting_since === null);
  const paused = suspended.filter(mine);
  return [...waiting, ...active, ...paused];
}

// SessionsSection's `sessions?.length` count of running rows, live
// (StatusFooter's replacement for the PTY tab count) -- counts distinct
// session ids currently reporting `running` via session_state, regardless
// of whether this device has ever fetched their full SessionSummary.
export function countRunningSessions(liveStates: Readonly<Record<string, SessionStateMessage>>): number {
  return Object.values(liveStates).filter((s) => s.state === "running").length;
}

// Folds one session_state frame into the per-session map App.tsx keeps.
// A session that reached a terminal state (closed/archived) stays in the
// map only while another live session still shares its node -- the
// selected-node refresh needs to see the transition -- and is dropped
// otherwise, so the map is bounded by what is currently running or
// suspended, not by everything that ever ran while the window was open.
export function applySessionStateFrame(
  prev: Readonly<Record<string, SessionStateMessage>>,
  frame: SessionStateMessage,
): Record<string, SessionStateMessage> {
  const next: Record<string, SessionStateMessage> = { ...prev, [frame.session_id]: frame };
  for (const s of Object.values(next)) {
    if (s.state !== "closed" && s.state !== "archived") continue;
    const nodeStillLive = Object.values(next).some(
      (o) => o.node_id === s.node_id && o.session_id !== s.session_id && (o.state === "running" || o.state === "suspended"),
    );
    if (!nodeStillLive || s.node_id === null) delete next[s.session_id];
  }
  return next;
}

// The persistent session Práce shows for a node: the requested one when
// it is still live, else the newest live one, else nothing.
export function pickOpenChatSession<T extends { id: string; state: SessionState }>(
  sessions: readonly T[],
  requestedId: string | null,
): T | null {
  const live = sessions.filter((s) => s.state === "running" || s.state === "suspended");
  if (requestedId) {
    const requested = live.find((s) => s.id === requestedId);
    if (requested) return requested;
  }
  return live[0] ?? null;
}
