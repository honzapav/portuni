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
};

export type TerminalSession = TerminalSessionInput & {
  id: string;
  createdAt: number;
  lastOutputAt: number;
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
  };
}

export function removeSession(
  sessions: readonly TerminalSession[],
  id: string,
): TerminalSession[] {
  return sessions.filter((s) => s.id !== id);
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

export function countSessionsByNode(
  sessions: readonly TerminalSession[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    out.set(s.nodeId, (out.get(s.nodeId) ?? 0) + 1);
  }
  return out;
}
