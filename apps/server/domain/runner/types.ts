// Canonical event model for the runner batch (docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md, "Events"). session_events is the
// record the chat renders from after a reload -- streamed text deltas
// (DeltaFrame, defined by the live-channel issue) never persist. This file
// grows the RunnerAdapter/RunHandle/RunStart interface as later runner-batch
// issues land (#318 adds them); for now it holds only what the storage layer
// (store.ts) needs to type and cap event payloads.

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
  payload: {
    run_id: string;
    runner: string;
    instance_id: string | null;
    resume: null | "conversation" | "handoff";
  };
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
  payload: { from: string; to: string; waiting: boolean };
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

// Streamed text, never persisted (rule 3: "Events are the record; deltas
// are not"). Carried only on the live channel (the WebSocket issue).
export interface DeltaFrame {
  type: "delta";
  run_id: string;
  text: string;
}
