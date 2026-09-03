// Shared "Pozastavit" (suspend) mechanism for a running agent terminal
// (#231, desktop multi-window phase 3): write an instruction into the PTY
// asking the agent to call portuni_session_suspend on its own initiative
// (there is no other protocol for this -- see
// docs/superpowers/specs/2026-09-01-desktop-multi-window-design.md's
// "Close contract" -> "The dialog"), poll the correlated persistent
// session until it leaves "running" or a 30s timeout, then the caller
// kills the PTY either way. Used by the window close dialog (App.tsx) and
// meant to be reused by the node-detail session list's own "Pozastavit"
// action (#232) -- one implementation, not two.

import type { SessionState, SessionSummary } from "../types";
import { isAgentCommand, type TerminalSession } from "./sessions";
import { isTauri } from "./backend-url";
import { fetchNodePersistentSessions } from "../api";

export const SUSPEND_POLL_TIMEOUT_MS = 30_000;
export const SUSPEND_POLL_INTERVAL_MS = 2_000;

// Plain text typed into the PTY like a user prompt. English: it addresses
// the agent, not the (Czech-UI) human user, and there is no structured
// instruction format for this -- the agent decides on its own to call the
// tool after reading it.
export const SUSPEND_INSTRUCTION =
  "Please suspend this session now: call portuni_session_suspend with a brief handoff summary of where you left off, then stop.";

export type CorrelatedSession = {
  terminalId: string;
  state: SessionState;
};

// Build CorrelatedSession[] from a batch of SessionSummary rows (however
// fetched -- one or more nodes' worth) by keeping only rows that carry a
// terminal_id. A row with none (Codex/Vibe, or a session never associated
// with a live PTY) can never correlate to a local terminal.
export function correlateSessions(rows: readonly SessionSummary[]): CorrelatedSession[] {
  return rows
    .filter((r): r is SessionSummary & { terminal_id: string } => r.terminal_id !== null)
    .map((r) => ({ terminalId: r.terminal_id, state: r.state }));
}

// Which of these terminals are suspendable: launched as an agent
// (isAgentCommand) AND have a correlated persistent session that is
// currently "running". Everything else (a bare shell, or an agent whose
// terminal_id never reached a session row -- Codex/Vibe, #211/#214) is
// kill-only, per the design doc: "offered for terminals the window spawned
// as an agent... that have a correlated running session".
export function suspendableTerminalIds(
  terminals: readonly Pick<TerminalSession, "id" | "command">[],
  correlated: readonly CorrelatedSession[],
): string[] {
  const runningTerminalIds = new Set(
    correlated.filter((c) => c.state === "running").map((c) => c.terminalId),
  );
  return terminals
    .filter((t) => isAgentCommand(t.command) && runningTerminalIds.has(t.id))
    .map((t) => t.id);
}

// The poll's stop condition: every session asked to suspend has left
// "running" (suspended, or closed some other way -- e.g. the agent quit on
// its own instead of suspending). An empty list is vacuously "done" (no
// suspendable session to wait on in the first place).
export function allSuspended(states: readonly SessionState[]): boolean {
  return states.every((s) => s !== "running");
}

// Has the suspend-poll deadline passed? Pure so the timeout branch ("On
// timeout the kill proceeds and the dialog says the sessions were closed,
// not suspended") is unit-testable without a real clock.
export function suspendPollTimedOut(
  startedAt: number,
  now: number,
  timeoutMs: number = SUSPEND_POLL_TIMEOUT_MS,
): boolean {
  return now - startedAt >= timeoutMs;
}

// Persistent sessions correlated to the given terminals (#231/#232): one
// GET /nodes/:id/sessions per distinct node among them, merged and reduced
// to terminal_id-bearing rows by correlateSessions. A node's fetch failing
// (e.g. it was deleted from under an open tab) just contributes no rows
// for it rather than failing the whole caller.
export async function fetchCorrelatedSessions(
  terminals: readonly Pick<TerminalSession, "nodeId">[],
): Promise<CorrelatedSession[]> {
  const nodeIds = Array.from(new Set(terminals.map((t) => t.nodeId)));
  const results = await Promise.all(
    nodeIds.map((id) => fetchNodePersistentSessions(id).catch(() => ({ sessions: [] }))),
  );
  return correlateSessions(results.flatMap((r) => r.sessions));
}

// Write the suspend instruction into every given terminal id, then poll
// (via fetchCorrelatedSessions over `terminals`, the full context needed to
// know which nodes to query) until every one of `terminalIds` has left
// "running" or the 30s timeout passes. Returns whether it timed out --
// callers decide what happens next (#231's close dialog kills every
// terminal it's showing regardless of outcome; #232's session-list row
// kills just its own one terminal, also regardless -- an attempt that
// either succeeded or ran out of time is done either way).
export async function suspendTerminalsAndPoll(
  terminalIds: string[],
  terminals: readonly Pick<TerminalSession, "nodeId">[],
): Promise<{ timedOut: boolean }> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    for (const id of terminalIds) {
      await invoke("pty_write", {
        args: { session_id: id, data: `${SUSPEND_INSTRUCTION}\n` },
      }).catch(() => undefined);
    }
  }
  const startedAt = Date.now();
  while (true) {
    const correlated = await fetchCorrelatedSessions(terminals);
    const states = correlated
      .filter((c) => terminalIds.includes(c.terminalId))
      .map((c) => c.state);
    if (allSuspended(states)) return { timedOut: false };
    if (suspendPollTimedOut(startedAt, Date.now())) return { timedOut: true };
    await new Promise((r) => setTimeout(r, SUSPEND_POLL_INTERVAL_MS));
  }
}
