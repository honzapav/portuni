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
// (StatusFooter's running count) -- counts distinct
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
// it is still live, else the newest live one, else nothing. "draft" counts
// as live too (#374: "a thread opens empty") -- a draft is never in the
// server-fetched list on its own (every list excludes it), so it only ever
// surfaces here when the caller merges in the one it just created locally
// and asks for it by id.
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

// ---------------------------------------------------------------- #412

// The Práce sidebar's per-node thread map (App.tsx's openSessionsByNode).
// A thread only ever reached it through the per-node refetch keyed on the
// open-node set, so a thread started from the node detail (the Relace
// tab's "Navázat", the detail's "Nový úkol") never showed up under its
// node -- nothing changed that set. These are the three folds that keep
// the map current without a refetch-everything pass.

type NodeSession = { id: string; node_id: string | null; state: SessionState; name?: string };

// A thread the caller just started, straight into its node's list (the
// server list is refetched too, but only once the state frame arrives --
// the row must be there the moment the thread opens). Dedupe by id: a
// session already listed is replaced in place, keeping its position.
export function mergeSessionIntoNodeMap<T extends NodeSession>(
  prev: Readonly<Record<string, T[]>>,
  session: T,
): Record<string, T[]> {
  const nodeId = session.node_id;
  if (!nodeId) return { ...prev };
  const list = prev[nodeId] ?? [];
  const existing = list.findIndex((s) => s.id === session.id);
  const next = existing >= 0 ? list.map((s, i) => (i === existing ? session : s)) : [...list, session];
  return { ...prev, [nodeId]: next };
}

// One node's refetched list replacing whatever was there. Restricted to
// what the sidebar shows (a thread still open), same filter the
// open-node-set fetch applies.
export function applyNodeSessionsRefetch<T extends NodeSession & { session_type: string; cli: string | null }>(
  prev: Readonly<Record<string, T[]>>,
  nodeId: string,
  sessions: readonly T[],
): Record<string, T[]> {
  return {
    ...prev,
    [nodeId]: sessions.filter((s) => isThreadSession(s) && (s.state === "running" || s.state === "suspended")),
  };
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

// A locally-tracked draft (#374) is forgotten only once the refetched
// server list actually carries it -- as a draft of its own (#463) or as
// the thread it was promoted into. Dropping it on the promotion frame
// alone, before the refetch resolved, is what made the row disappear the
// moment a draft became a real thread: the frame says "it is running now",
// the list it should have moved into had not been fetched since.
export function dropPromotedDrafts<T extends { id: string }>(
  drafts: Record<string, T>,
  fetched: readonly { id: string }[],
): Record<string, T> {
  const seen = new Set(fetched.map((s) => s.id));
  const next: Record<string, T> = {};
  let dropped = false;
  for (const [id, draft] of Object.entries(drafts)) {
    if (seen.has(id)) dropped = true;
    else next[id] = draft;
  }
  // Same reference when nothing changed: every refetch calls this, and a
  // fresh object each time would re-run every effect keyed on the draft
  // map (the shown thread's own fetch among them).
  return dropped ? next : drafts;
}

// Drafts overlaid on the server-fetched map. Deduped by id, so the window
// in which a draft is both still tracked locally and already in the
// server's list (#463: the list carries the caller's own drafts) renders
// one row, not two.
export function mergeDraftsIntoNodeMap<T extends NodeSession>(
  byNode: Readonly<Record<string, T[]>>,
  drafts: Readonly<Record<string, T>>,
): Record<string, T[]> {
  const merged: Record<string, T[]> = { ...byNode };
  for (const draft of Object.values(drafts)) {
    if (!draft.node_id) continue;
    const list = merged[draft.node_id] ?? [];
    if (list.some((s) => s.id === draft.id)) continue;
    merged[draft.node_id] = [...list, draft];
  }
  return merged;
}

// Entries for nodes no longer open, dropped -- the per-node refetch adds
// keys on its own now, so nothing else prunes the map.
export function pruneNodeSessions<T>(
  byNode: Record<string, T[]>,
  openNodeIds: readonly string[],
): Record<string, T[]> {
  const open = new Set(openNodeIds);
  const next: Record<string, T[]> = {};
  let removed = false;
  for (const [id, list] of Object.entries(byNode)) {
    if (open.has(id)) next[id] = list;
    else removed = true;
  }
  return removed ? next : byNode;
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

// The threads that keep a mounted SessionChat in this window (#429, the
// task-surface spec's "mounted for every open thread and toggled"): every
// chat-eligible thread of an open node, plus the shown one, which the
// per-node map can still be missing (its own fetch resolved first, or it
// is a local draft of a node whose list has not come back yet).
//
// Order is the open-node order, then each node's own list order, so the
// rendered keys are stable across a switch -- React keeps a keyed child
// mounted when only its position or props change, and that is what makes
// switching threads free of a re-subscribe. The shown thread's own object
// wins over the map's copy of it: it carries whatever the chat has since
// updated (model, effort, live state), the map's copy is whatever the
// last refetch returned -- except the name, which the map's copy carries
// from the live channel (a rename in the Relace tab or another window
// reaches this window only that way), so it is overlaid onto the shown one.
export function mountedChatSessions<T extends NodeSession>(
  byNode: Readonly<Record<string, T[]>>,
  openNodeIds: readonly string[],
  shown: T | null,
): T[] {
  const mounted: T[] = [];
  const seen = new Set<string>();
  for (const nodeId of openNodeIds) {
    for (const session of byNode[nodeId] ?? []) {
      if (!isChatSessionState(session.state) || seen.has(session.id)) continue;
      seen.add(session.id);
      if (shown && shown.id === session.id) {
        mounted.push(session.name !== undefined && session.name !== shown.name ? { ...shown, name: session.name } : shown);
      } else {
        mounted.push(session);
      }
    }
  }
  if (shown && isChatSessionState(shown.state) && !seen.has(shown.id)) mounted.push(shown);
  return mounted;
}

// A chat reporting its session back (the picker's runner/instance, a
// model change, a live state frame) has to reach the tracked draft too:
// the shown-thread pick on a node switch reads the draft map, so a copy
// left behind there is what the composer shows next. Same reference when
// the session is no tracked draft.
export function applySessionUpdateToDrafts<T extends { id: string }>(
  drafts: Readonly<Record<string, T>>,
  updated: T,
): Record<string, T> {
  if (!(updated.id in drafts)) return drafts as Record<string, T>;
  return { ...drafts, [updated.id]: updated };
}
