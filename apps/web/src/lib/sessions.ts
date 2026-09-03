// Pure session-list helpers. No React, no DOM, no Tauri. The whole point
// of pulling this out is so the data shape can be unit-tested with the
// backend node-test runner without a browser environment.

export type NodeTypeLite =
  | "organization"
  | "project"
  | "process"
  | "area"
  | "principle"
  | (string & {});

export type TerminalSessionInput = {
  nodeId: string;
  nodeName: string;
  nodeType: NodeTypeLite;
  cwd: string;
  command: string;
  // Seatbelt profile text from GET /nodes/:id/sandbox-profile. Passed to
  // pty_spawn so the shell (and any agent in it) runs under the node's
  // disk scope. Null only for sessions created before the profile fetch
  // existed; new sessions always carry one (launch is fail-closed).
  sandboxProfile: string | null;
  // Wall-clock ms (Date.now()) when the spawn flow began -- before mirror
  // creation / sandbox profile fetch, i.e. the moment the user asked for a
  // terminal. Optional: defaults to session-creation time when the caller
  // doesn't track an earlier start (e.g. tests). TerminalPane uses it to
  // print a one-line spawn-phase timing breakdown once the terminal is
  // ready (spec: "Spawn UX" -- instrument spawn phases).
  spawnRequestedAt?: number;
  // CLI spawn profile id (phase 3, spawn UX) chosen for this session, if
  // any -- threaded to pty_spawn so its env vars / command override apply,
  // and to the MCP connection (X-Portuni-Profile header) so the durable
  // session record stores it. Null/absent spawns with inherited env, same
  // as before profiles existed.
  profileId?: string | null;
  // Session id GET /nodes/:id/sandbox-profile already narrowed the
  // Seatbelt projection grant to (#208 follow-up). Threaded to pty_spawn so
  // the MCP connection (X-Portuni-Spawn-Id header) reuses this exact id
  // instead of minting an unrelated one. Null/absent for sessions created
  // before this field existed, or when the profile response omitted it.
  spawnSessionId?: string | null;
};

export type TerminalSession = TerminalSessionInput & {
  id: string;
  createdAt: number;
  lastOutputAt: number;
  spawnRequestedAt: number;
  // User-assigned tab label. Absent until the user renames the session;
  // the UI falls back to "#<n>" via sessionDisplayName. In-memory only --
  // a PTY (and therefore its label) does not survive an app restart.
  label?: string;
};

const ACTIVITY_THRESHOLD_MS = 1500;
// pty-data fires per byte chunk -- during heavy agent output that is many
// times per second, and every accepted update re-renders all consumers of
// the sessions state. The indicator threshold is 1500ms, so recording at
// most one timestamp per 250ms loses nothing visible.
const ACTIVITY_THROTTLE_MS = 250;

export function createSession(
  input: TerminalSessionInput,
  now: number = Date.now(),
): TerminalSession {
  const rand = Math.random().toString(36).slice(2, 8);
  return {
    ...input,
    id: `term_${input.nodeId}_${now}_${rand}`,
    createdAt: now,
    lastOutputAt: now,
    spawnRequestedAt: input.spawnRequestedAt ?? now,
  };
}

export function removeSession(
  sessions: readonly TerminalSession[],
  id: string,
): TerminalSession[] {
  return sessions.filter((s) => s.id !== id);
}

// Set or clear a session's custom tab label. An empty/whitespace label
// clears it (UI then falls back to the numeric default). Returns the
// original array reference when nothing changed so React setters
// short-circuit on identity.
export function renameSession(
  sessions: readonly TerminalSession[],
  id: string,
  label: string,
): TerminalSession[] {
  const trimmed = label.trim();
  const nextLabel = trimmed.length > 0 ? trimmed : undefined;
  let mutated = false;
  const next = sessions.map((s) => {
    if (s.id !== id) return s;
    if (s.label === nextLabel) return s;
    mutated = true;
    return { ...s, label: nextLabel };
  });
  return mutated ? next : (sessions as unknown as TerminalSession[]);
}

// Display name for a session tab: the user's label if set, else "#<n>"
// where n is the 1-based position of the session within its node.
export function sessionDisplayName(
  session: Pick<TerminalSession, "label">,
  index: number,
): string {
  const label = session.label?.trim();
  return label && label.length > 0 ? label : `#${index + 1}`;
}

export function markActivity(
  sessions: readonly TerminalSession[],
  id: string,
  at: number = Date.now(),
): TerminalSession[] {
  let mutated = false;
  const next = sessions.map((s) => {
    if (s.id !== id) return s;
    if (at - s.lastOutputAt < ACTIVITY_THROTTLE_MS) return s;
    mutated = true;
    return { ...s, lastOutputAt: at };
  });
  // Return the original array reference when nothing changed so React
  // setters short-circuit on identity. pty-data fires per byte chunk;
  // a fresh array on every event would rerender every consumer for
  // free. Cast through unknown to drop readonly without copying.
  return mutated ? next : (sessions as unknown as TerminalSession[]);
}

export function isSessionActive(
  now: number,
  lastOutputAt: number,
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  return now - lastOutputAt <= thresholdMs;
}

export function nodeIsActive(
  sessions: readonly TerminalSession[],
  nodeId: string,
  now: number,
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  return sessions.some(
    (s) => s.nodeId === nodeId && isSessionActive(now, s.lastOutputAt, thresholdMs),
  );
}

// The activity indicator means "an agent is working", not "the PTY emitted
// bytes". A bare shell that echoes keystrokes, redraws a prompt, or runs
// `ls` must NOT light up green. Only sessions launched as an agent CLI
// qualify -- matched against the session's launch command.
export function isAgentCommand(command: string): boolean {
  return /\b(claude|codex|vibe|opencode)\b/i.test(command);
}

// A session is "agent working" when it was launched as an agent AND it is
// currently computing. The command gate answers "which kind of session";
// output recency answers "is it computing right now" -- an interactive
// agent TUI owns the PTY foreground for its whole lifetime (idle or not),
// so foreground ownership can't distinguish the two and isn't used here.
export function sessionIsAgentWorking(
  session: Pick<TerminalSession, "command" | "lastOutputAt">,
  now: number,
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  if (!isAgentCommand(session.command)) return false;
  return isSessionActive(now, session.lastOutputAt, thresholdMs);
}

// Node-level aggregate: green when any of the node's sessions is an agent
// that is currently working.
export function nodeHasWorkingAgent(
  sessions: readonly TerminalSession[],
  nodeId: string,
  now: number,
  thresholdMs: number = ACTIVITY_THRESHOLD_MS,
): boolean {
  return sessions.some(
    (s) => s.nodeId === nodeId && sessionIsAgentWorking(s, now, thresholdMs),
  );
}

export function countSessionsByNode(
  sessions: readonly TerminalSession[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    out.set(s.nodeId, (out.get(s.nodeId) ?? 0) + 1);
  }
  return out;
}

// A node shown in the workspace's left column. `id` plus enough to render
// the row without a second graph lookup at the call site.
export type WorkspaceNodeRow = { id: string; name: string; type: string };

// The set of nodes shown in the workspace: every explicitly "open" node
// PLUS every node that has a live session, de-duplicated and ordered
// open-first then session-only (each by first-seen). Name/type come from a
// live session when present (always populated) and otherwise from
// `resolve` (the graph). Ids that resolve to nothing AND have no session
// are dropped -- e.g. a node deleted out from under a stale persisted id.
//
// Decoupling "open" from "has a session" is the whole point: a node can be
// opened to view/edit without ever launching a terminal, and it stays open
// after its last terminal closes.
export function deriveWorkspaceNodeRows(
  openNodeIds: readonly string[],
  sessions: readonly TerminalSession[],
  resolve: (id: string) => { name: string; type: string } | undefined,
): WorkspaceNodeRow[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  for (const id of openNodeIds) add(id);
  for (const s of sessions) add(s.nodeId);

  const rows: WorkspaceNodeRow[] = [];
  for (const id of order) {
    const sess = sessions.find((s) => s.nodeId === id);
    if (sess) {
      rows.push({ id, name: sess.nodeName, type: sess.nodeType });
    } else {
      const r = resolve(id);
      if (r) rows.push({ id, name: r.name, type: r.type });
    }
  }
  return rows;
}
