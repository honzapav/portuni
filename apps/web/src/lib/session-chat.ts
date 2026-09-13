// Pure, testable logic for SessionChat (#342, docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md "Web: Práce, New task") -- event
// grouping, status-chip derivation, the open-question panel, streamed-delta
// buffering, and the restart-indicator hint. Dependency-free (no React) so
// test/session-chat-helpers.test.ts can exercise it directly against
// fixture event arrays, same convention as lib/sessions.ts.
//
// CanonicalEvent mirrors apps/server/domain/runner/types.ts's own union
// exactly. domain/runner/types.ts is server-only (not under shared/, which
// exists precisely so the web can type REST responses without importing
// server domain code) -- this is a deliberate parallel definition of the
// wire shape, not an import across that boundary.

import type { SessionState } from "../types";
import type { SessionSignals } from "../api";

export type RunEndReason = "completed" | "interrupted" | "suspended" | "error" | "limit" | "host_lost";
export type ToolCallCategory = "command" | "file_read" | "file_change" | "mcp" | "other";
export type ToolCallStatus = "started" | "completed" | "failed";
export type FileChangeOp = "create" | "edit" | "delete" | "rename";
export type QuestionType = "approval" | "input";
export type ErrorClass = "provider" | "transport" | "permission" | "unknown";

export interface QuestionDecision {
  by: string;
  value: string | boolean;
  at: string;
}

export interface RunStartedEvent {
  kind: "run_started";
  payload: { run_id: string; runner: string; instance_id: string | null; resume: null | "conversation" | "handoff" };
}
export interface RunEndedEvent {
  kind: "run_ended";
  payload: { run_id: string; reason: RunEndReason; usage: unknown };
}
export interface UserMessageEvent {
  kind: "user_message";
  payload: { text: string; source: "chat" | "system" };
}
export interface AssistantMessageEvent {
  kind: "assistant_message";
  payload: { text: string };
}
export interface ReasoningEvent {
  kind: "reasoning";
  payload: { summary: string };
}
export interface ToolCallEvent {
  kind: "tool_call";
  payload: {
    tool_use_id: string;
    tool: string;
    category: ToolCallCategory;
    title: string;
    input_summary: string;
    status: ToolCallStatus;
    output_excerpt: string | null;
    truncated: boolean;
  };
}
export interface FileChangeEvent {
  kind: "file_change";
  payload: { path: string; op: FileChangeOp };
}
export interface QuestionEvent {
  kind: "question";
  payload: {
    request_id: string;
    type: QuestionType;
    tool: string;
    title: string;
    detail: string;
    options: string[] | null;
    decision: QuestionDecision | null;
  };
}
export interface CompactionEvent {
  kind: "compaction";
  payload: { trigger: "auto" | "manual" };
}
export interface HandoffEvent {
  kind: "handoff";
  payload: { path: string | null; hash: string | null; generated_by: "agent" | "server" };
}
export interface StateChangedEvent {
  kind: "state_changed";
  payload: { from: string; to: string; waiting: boolean; by?: string };
}
export interface ErrorEvent {
  kind: "error";
  payload: { class: ErrorClass; message: string };
}

export type CanonicalEvent =
  | RunStartedEvent
  | RunEndedEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ReasoningEvent
  | ToolCallEvent
  | FileChangeEvent
  | QuestionEvent
  | CompactionEvent
  | HandoffEvent
  | StateChangedEvent
  | ErrorEvent;

export type CanonicalEventKind = CanonicalEvent["kind"];

export interface ChatEvent {
  seq: number;
  event: CanonicalEvent;
}

// Trusts the server's own kind/payload pairing -- the wire frame is already
// `{kind, payload, seq}` shaped (session-runtime.ts's PublishedEvent), so
// this is a plain cast, not a validating parse.
export function toCanonicalEvent(kind: string, payload: unknown): CanonicalEvent {
  return { kind, payload } as CanonicalEvent;
}

// --- Status chip -----------------------------------------------------------

export interface StatusChip {
  label: string;
  color: string;
  // A subtle "something is actively happening" indicator (a live run, or
  // waiting on the user) -- distinct from the state color, which only
  // encodes the coarse SessionState.
  pulsing: boolean;
}

const STATE_COLOR: Record<SessionState, string> = {
  running: "var(--color-status-active)",
  suspended: "var(--color-node-process)",
  closed: "var(--color-text-dim)",
  archived: "var(--color-text-dim)",
};

// "Čeká na mě" (waiting_since set) takes priority over the coarse "Běží" --
// a running session with an open question is functionally blocked on the
// user, not doing work, and the chip should say so (SessionSummary's own
// comment: "Set while a question event is open ... Drives the 'Čeká na mě'
// status label").
export function sessionStatusChip(state: SessionState, waitingSince: string | null): StatusChip {
  if (state === "running" && waitingSince !== null) {
    return { label: "Čeká na mě", color: "var(--color-node-process)", pulsing: true };
  }
  const label: Record<SessionState, string> = {
    running: "Běží",
    suspended: "Pozastaveno",
    closed: "Uzavřeno",
    archived: "Archivováno",
  };
  return { label: label[state], color: STATE_COLOR[state], pulsing: state === "running" };
}

// --- Open question panel ----------------------------------------------------

// The most recent question event in the transcript, for display while
// waiting_since is set. "Is a question currently open" is driven by
// waiting_since (SessionSummary/SessionStateMessage), not by this event's
// own `decision` field -- the canonical log is append-only, so a decision
// never mutates an already-persisted question event in place; this is
// purely "what to show" once the caller already knows a question is open.
export function latestQuestionEvent(events: readonly ChatEvent[]): QuestionEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i].event;
    if (event.kind === "question") return event;
  }
  return null;
}

// --- Streamed delta buffering ------------------------------------------------

export type DeltaBuffers = Readonly<Record<string, string>>;

export function appendDelta(buffers: DeltaBuffers, runId: string, text: string): DeltaBuffers {
  return { ...buffers, [runId]: (buffers[runId] ?? "") + text };
}

// The persisted assistant_message/reasoning event for a run has landed --
// the streaming buffer's job is done, drop it so the finalized event (not
// a stale streaming bubble) is what renders from here on.
export function clearDeltaBuffer(buffers: DeltaBuffers, runId: string): DeltaBuffers {
  if (!(runId in buffers)) return buffers;
  const next = { ...buffers };
  delete next[runId];
  return next;
}

// --- Tool-call collapsing ---------------------------------------------------

// Consecutive tool_call events sharing the same tool_use_id (started ->
// completed/failed) collapse into the LATEST one -- one visual row per
// tool invocation instead of a "started" line immediately followed by its
// own "completed" line. Every other event kind, and a tool_call whose
// tool_use_id repeats non-consecutively (should not happen in practice,
// each id is used once per invocation), passes through unchanged.
export function collapseToolCalls(events: readonly ChatEvent[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  const lastToolCallIndex = new Map<string, number>();
  for (const item of events) {
    if (item.event.kind === "tool_call") {
      const id = item.event.payload.tool_use_id;
      const priorIndex = lastToolCallIndex.get(id);
      if (priorIndex !== undefined && out[priorIndex]?.event.kind === "tool_call") {
        out[priorIndex] = item;
        continue;
      }
      lastToolCallIndex.set(id, out.length);
    }
    out.push(item);
  }
  return out;
}

// --- Restart indicator -------------------------------------------------------

// Null when there is no live run (nothing to report) -- the caller decides
// whether/where to show this, e.g. only while state === "running".
export function formatRestartHint(signals: SessionSignals): string | null {
  if (signals.runAgeMs === null) return null;
  const minutes = Math.max(0, Math.round(signals.runAgeMs / 60_000));
  const ageText = minutes < 1 ? "méně než minutu" : `${minutes} min`;
  const growth = signals.expansionsSinceRunStart > 0 ? ` (+${signals.expansionsSinceRunStart} od startu běhu)` : "";
  return `Běží ${ageText} · zápis ${signals.writeSetSize} · čtení ${signals.readSetSize}${growth}`;
}
