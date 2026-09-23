// Pure helpers for #343 (runner batch phase 3, second issue -- Relace tab,
// Práce sidebar, Přehled reading live session state): the compact status
// chip used in list/sub-row contexts (distinct wording from
// lib/session-chat.ts's sessionStatusChip, which is SessionChat's own
// header), live-state overlay, and Přehled's inbox ordering. Dependency-
// free so test/session-views-helpers.test.ts can exercise it directly.

import type { SessionState, OverviewSessionRow } from "../types";
import type { SessionStateMessage } from "./sessions-client";

export type SessionRowChip = { label: string; color: string; pulsing: boolean };

// Two wordings of the same chip: the compact one for list rows and
// sub-rows, the full one for SessionChat's own header.
export type SessionChipVariant = "row" | "header";

const STATE_LABEL: Record<SessionChipVariant, Record<SessionState, string>> = {
  row: { running: "Běží", suspended: "Pozastaveno", closed: "Hotovo", archived: "Archiv", draft: "Nový" },
  header: {
    running: "Běží",
    suspended: "Pozastaveno",
    closed: "Uzavřeno",
    archived: "Archivováno",
    draft: "Nový",
  },
};

const ROW_STATE_COLOR: Record<SessionState, string> = {
  running: "var(--color-status-active)",
  suspended: "var(--color-node-process)",
  closed: "var(--color-text-dim)",
  archived: "var(--color-text-dim)",
  draft: "var(--color-text-dim)",
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

// Overlays a live `session_state` frame onto a REST-fetched summary --
// state, waiting_since and (when the frame carries it) name; the frame has
// nothing else. Absent live state (nothing has changed since the fetch, or
// none was ever received for this id) returns the input unchanged.
export function applyLiveSessionState<T extends { id: string; state: SessionState; waiting_since: string | null }>(
  session: T,
  liveStates: Readonly<Record<string, SessionStateMessage>>,
): T {
  const live = liveStates[session.id];
  if (!live) return session;
  return {
    ...session,
    state: live.state,
    waiting_since: live.waiting_since,
    ...(live.name !== undefined ? { name: live.name } : {}),
  };
}

export function mergeLiveSessionStates<T extends { id: string; state: SessionState; waiting_since: string | null }>(
  sessions: readonly T[],
  liveStates: Readonly<Record<string, SessionStateMessage>>,
): T[] {
  return sessions.map((s) => applyLiveSessionState(s, liveStates));
}

// Přehled's Relace card: waiting ("Čeká na mě") first, then running, then
// suspended -- each bucket keeps the server's own last_active_at-descending
// order. Since #457 GET /overview carries the caller's own threads only, so
// there is nothing left to filter out here.
export function sortInboxSessions(
  running: readonly OverviewSessionRow[],
  suspended: readonly OverviewSessionRow[],
): OverviewSessionRow[] {
  const waiting = running.filter((s) => s.waiting_since !== null);
  const active = running.filter((s) => s.waiting_since === null);
  return [...waiting, ...active, ...suspended];
}

// The persistent session Práce shows for a node: the requested one when it
// is still live, else the newest row of the first non-empty bucket (what
// selectNodeThreads orders), else nothing. "draft" counts as live too
// (#374: "a thread opens empty") -- since #463 the node's session list
// carries the caller's own drafts, so a draft reaches this pick like every
// other thread, from the store.
export function pickOpenChatSession<T extends { id: string; state: SessionState }>(
  sessions: readonly T[],
  requestedId: string | null,
): T | null {
  const live = sessions.filter((s) => isChatSessionState(s.state));
  if (requestedId) {
    const requested = live.find((s) => s.id === requestedId);
    if (requested) return requested;
  }
  return live[0] ?? null;
}

// The node's shown chat after a thread is started anywhere in the app
// ("Nový úkol" in the detail, the sidebar's "+", the Relace tab's
// "Navázat"): the fresh thread is what the node must show. Setting the
// shown session alone is not enough -- the pick above re-runs the moment
// the new thread is tracked, and without its id requested it keeps
// preferring the previously requested thread (else the newest live one),
// so the surface snapped straight back to the task that was already open.
export function requestChatSession(
  prev: Readonly<Record<string, string>>,
  session: { id: string; node_id: string | null },
): Record<string, string> {
  if (!session.node_id) return { ...prev };
  return { ...prev, [session.node_id]: session.id };
}

// ---------------------------------------------------------------- v2

// v2 rule 7 (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md):
// a thread is a persistent task session the app opened; a hand-opened CLI
// session (cli set) has no sub-row in Práce, Relace lists it.
export function isThreadSession(s: { session_type: string; cli: string | null }): boolean {
  return s.session_type === "interactive_task" && s.cli === null;
}

// v2 rule 6: the accent bar and the surface-2 fill mark exactly one row --
// the open thread when there is one, otherwise the selected node.
export function nodeRowActive(nodeId: string, selectedNodeId: string | null, activeSessionId: string | null): boolean {
  return activeSessionId === null && selectedNodeId === nodeId;
}

// The host to show on a Relace row and in the chat header (#428): the
// server's display label when it has one, otherwise the host id itself
// (domain/runner/hosts.ts keeps ids human-readable for exactly this
// fallback). Null means "nothing to show" -- the surfaces hide the slot
// rather than rendering an empty separator.
export function hostDisplayName(session: {
  host_id: string | null;
  host_label?: string | null;
}): string | null {
  const label = session.host_label?.trim();
  if (label) return label;
  const id = session.host_id?.trim();
  return id || null;
}

// ---------------------------------------------------------------- #429

// A thread renders as chat while it is steerable: running (waiting
// included), suspended (the composer disables, Nahodit resumes) and draft
// (#374, rule 5: a thread opens empty). closed and archived are history,
// so their node falls back to the plain detail surface.
export function isChatSessionState(state: SessionState): boolean {
  return state === "running" || state === "suspended" || state === "draft";
}

// The pane Práce shows for the selected node: the open session, but only
// while it is chat-eligible AND anchored on that node. Right after a switch
// to another node the open session is still the previous node's until its
// own list is fetched and picked; showing it meanwhile reads as "my click
// did nothing" (the old thread stays on screen, the sidebar highlight with
// it) -- and if that fetch never settles, forever. Null shows the node
// surface instead, which is where the fetch's own error lands.
export function shownChatSessionId(
  selectedNodeId: string | null,
  openSession: { id: string; node_id: string | null; state: SessionState } | null,
): string | null {
  if (!selectedNodeId || !openSession) return null;
  if (!isChatSessionState(openSession.state)) return null;
  if (openSession.node_id !== selectedNodeId) return null;
  return openSession.id;
}

// ---------------------------------------------------------------- #506

// What the close control on a thread does, the same on every surface that
// offers it (the sidebar's Uzly and Stav rows, the chat header, the Relace
// row): a draft is deleted outright (api.ts's deleteDraftSession, no
// dialog), a running or suspended thread is Uzavřít behind its
// confirmation, and a closed or archived one has no close control at all.
export type ThreadCloseAction = "delete" | "confirm" | null;

export function threadCloseAction(state: SessionState): ThreadCloseAction {
  if (state === "draft") return "delete";
  if (state === "running" || state === "suspended") return "confirm";
  return null;
}
