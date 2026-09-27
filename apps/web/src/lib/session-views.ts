// Pure helpers for #343 (runner batch phase 3, second issue -- Relace tab,
// Práce sidebar, Přehled reading live session state): the compact status
// chip used in list/sub-row contexts (distinct wording from
// lib/session-chat.ts's sessionStatusChip, which is SessionChat's own
// header), live-state overlay, and Přehled's inbox ordering. Dependency-
// free so test/session-views-helpers.test.ts can exercise it directly.

import type { TFunction } from "i18next";
import type { SessionState, OverviewSessionRow } from "../types";
import type { SessionStateMessage } from "./sessions-client";

type CommonT = TFunction<"common">;

export type SessionRowChip = { label: string; color: string; pulsing: boolean };

// Two wordings of the same chip: the compact one for list rows and
// sub-rows, the full one for SessionChat's own header.
export type SessionChipVariant = "row" | "header";

// Complete Records of literal selectors, so a state added to SessionState
// fails the typecheck until it has a label in both variants.
const STATE_LABEL: Record<SessionChipVariant, Record<SessionState, (t: CommonT) => string>> = {
  row: {
    running: (t) => t(($) => $.thread.state.row.running, { ns: "common" }),
    suspended: (t) => t(($) => $.thread.state.row.suspended, { ns: "common" }),
    closed: (t) => t(($) => $.thread.state.row.closed, { ns: "common" }),
    archived: (t) => t(($) => $.thread.state.row.archived, { ns: "common" }),
    draft: (t) => t(($) => $.thread.state.row.draft, { ns: "common" }),
  },
  header: {
    running: (t) => t(($) => $.thread.state.header.running, { ns: "common" }),
    suspended: (t) => t(($) => $.thread.state.header.suspended, { ns: "common" }),
    closed: (t) => t(($) => $.thread.state.header.closed, { ns: "common" }),
    archived: (t) => t(($) => $.thread.state.header.archived, { ns: "common" }),
    draft: (t) => t(($) => $.thread.state.header.draft, { ns: "common" }),
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
  t: CommonT,
  variant: SessionChipVariant = "row",
): SessionRowChip {
  if (state === "running" && waitingSince !== null) {
    return { label: t(($) => $.thread.state.waiting, { ns: "common" }), color: "var(--color-node-process)", pulsing: true };
  }
  return { label: STATE_LABEL[variant][state](t), color: ROW_STATE_COLOR[state], pulsing: state === "running" };
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
// session has no sub-row in Práce, Relace lists it. The app opens a thread
// through the runner, so `runner` is what tells them apart: `cli` does not,
// because the thread's own agent fills it in when it connects to the MCP
// server (bindExistingSessionHandshake), and the thread would drop out of
// Práce on the next list refetch. A hand-opened session never has a runner.
export function isThreadSession(s: {
  session_type: string;
  cli: string | null;
  runner: string | null;
}): boolean {
  return s.session_type === "interactive_task" && (s.runner !== null || s.cli === null);
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
// included), suspended (the next message resumes it) and draft (#374,
// rule 5: a thread opens empty). These are the Práce sidebar's threads.
// closed and archived are history, so their node falls back to the plain
// detail surface -- except a closed thread the user opens on purpose
// (#498: Relace's Otevřít chat), see isOpenableChatState.
export function isChatSessionState(state: SessionState): boolean {
  return state === "running" || state === "suspended" || state === "draft";
}

// #498: Uzavřít is "done, off the active lists", not "never again". A
// closed thread is not in the sidebar, but opening it from Relace shows its
// chat, and writing into it reopens it (the server resumes it the way it
// resumes a suspended one). An archived thread has no chat at all.
export function isOpenableChatState(state: SessionState): boolean {
  return isChatSessionState(state) || state === "closed";
}

// #498: the composer takes a message in every state but archived -- a
// closed thread reopens on the message.
export function threadAcceptsMessages(state: SessionState): boolean {
  return state !== "archived";
}

// The composer's placeholder for the thread's own state (a question
// waiting or a transcript elsewhere say their own thing first): every
// state that takes a message (threadAcceptsMessages) invites one.
const COMPOSER_PLACEHOLDER: Record<SessionState, (t: CommonT) => string> = {
  draft: (t) => t(($) => $.thread.composer.placeholder.open, { ns: "common" }),
  running: (t) => t(($) => $.thread.composer.placeholder.open, { ns: "common" }),
  suspended: (t) => t(($) => $.thread.composer.placeholder.open, { ns: "common" }),
  closed: (t) => t(($) => $.thread.composer.placeholder.open, { ns: "common" }),
  archived: (t) => t(($) => $.thread.composer.placeholder.archived, { ns: "common" }),
};

export function composerStatePlaceholder(state: SessionState, t: CommonT): string {
  return COMPOSER_PLACEHOLDER[state](t);
}

// #498: Relace's Otevřít chat, the same for a closed thread as for a
// suspended one (there is no Navázat anymore -- the closed thread has a
// composer).
export function sessionRowOpensChat(state: SessionState): boolean {
  return state === "running" || state === "suspended" || state === "closed";
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
  if (!isOpenableChatState(openSession.state)) return null;
  if (openSession.node_id !== selectedNodeId) return null;
  return openSession.id;
}

// ---------------------------------------------------------------- #506

// What the close control on a thread does, the same on every surface that
// offers it (the sidebar's Uzly and Stav rows, the chat header, the Relace
// row): a draft is deleted outright (api.ts's deleteDraftSession), a
// running or suspended thread is Uzavřít -- both without a dialog (#498: a
// closed thread reopens by writing into it, so only an unfinished turn can
// be lost, the same as with Stop) -- and a closed or archived one has no
// close control at all.
export type ThreadCloseAction = "delete" | "close" | null;

export function threadCloseAction(state: SessionState): ThreadCloseAction {
  if (state === "draft") return "delete";
  if (state === "running" || state === "suspended") return "close";
  return null;
}
