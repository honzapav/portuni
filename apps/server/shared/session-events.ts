// The canonical event model (docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md, "Events"): the wire shape of every
// persisted session event. Shared so the server (domain/runner/types.ts
// re-exports it) and the web (lib/session-chat.ts) type the same union from
// one definition. Type-only, no runtime imports, like the rest of shared/.

import type {
  ChatEventParams,
  DenyCode,
  QuestionCode,
  RunErrorCode,
} from "./chat-event-codes.js";

export type RunEndReason = "completed" | "interrupted" | "suspended" | "error" | "limit" | "host_lost";

export type ToolCallCategory = "command" | "file_read" | "file_change" | "mcp" | "other";
export type ToolCallStatus = "started" | "completed" | "failed";
export type FileChangeOp = "create" | "edit" | "delete" | "rename";
export type QuestionType = "approval" | "input";
export type ErrorClass = "provider" | "transport" | "permission" | "unknown";

// `value`: true/false for an approval; a string answers an input question
// (every dotaz of it); a map answers an AskUserQuestion ask question by
// question, keyed by the question text (#492).
export type QuestionAnswer = string | boolean | Record<string, string>;

export interface QuestionDecision {
  by: string;
  value: QuestionAnswer;
  at: string;
}

export interface RunStartedEvent {
  kind: "run_started";
  payload: {
    run_id: string;
    runner: string;
    instance_id: string | null;
    resume: null | "conversation" | "handoff";
    // #489/#490: messages already in the transcript that this run starts
    // with as its first turn -- a message the previous run refused while
    // it was ending, redelivered here without being logged again. They
    // sit before this run_started in the log, so a client counting the
    // turn in flight from run_started adds them. Absent means none.
    carried_messages?: number;
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
  // duration_ms: wall time from the first thinking delta of the block to the
  // batched block itself, measured by the adapter; absent when no delta
  // streamed (older rows, a runner without partial messages).
  payload: { summary: string; duration_ms?: number };
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
    // #532: a call the runner denied -- the chat shows the denial from the
    // code; output_excerpt holds the English message the agent read.
    output_code?: DenyCode;
    output_params?: ChatEventParams;
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
    // English fallback for logs and rows written before #532; the web
    // renders `code` with `params` when present.
    title: string;
    code?: QuestionCode;
    params?: ChatEventParams;
    detail: string;
    options: string[] | null;
    // AskUserQuestion (#492): each dotaz with its own options; absent for
    // every other question and on rows written before it.
    questions?: AskPrompt[];
    decision: QuestionDecision | null;
  };
}

export interface AskPrompt {
  question: string;
  options: string[];
  multi_select: boolean;
}

export interface CompactionEvent {
  kind: "compaction";
  payload: { trigger: "auto" | "manual" };
}

// #378: always server-written now (session-runtime.ts's own suspend
// handshake -- the only thing that ever produced an "agent"-generated one
// here -- is gone), so the payload no longer distinguishes generated_by.
export interface HandoffEvent {
  kind: "handoff";
  payload: { path: string | null; hash: string | null };
}

export interface StateChangedEvent {
  kind: "state_changed";
  // `by` (docs/superpowers/specs/2026-09-12-remote-hosts-and-task-queue-design.md,
  // "Visibility and control"): set only when a stop action (interrupt/
  // suspend/close) was taken by someone other than the session's owner --
  // "the chat shows who stopped it". Absent for every ordinary transition
  // (question opened/answered, run ended), which have no such actor to name.
  payload: { from: string; to: string; waiting: boolean; by?: string };
}

export interface ErrorEvent {
  kind: "error";
  // #532: `code` for a message the runner wrote itself (the web renders
  // it); a provider's own text has no code and is shown as stored.
  payload: { class: ErrorClass; message: string; code?: RunErrorCode; params?: ChatEventParams };
}

// v2 task surface (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md,
// "The context ring"): emitted by the adapter after every provider
// assistant message and every result. used_tokens is what the model's
// context currently holds (input + cache creation + cache read of the
// latest assistant usage); max_tokens is the model's window from the
// latest result, null until one arrived. Persisted like every event, so a
// replay rebuilds the ring; the runtime also folds the latest one onto
// sessions.context_used_tokens / context_max_tokens.
export interface ContextUsageEvent {
  kind: "context_usage";
  payload: {
    run_id: string;
    model: string | null;
    used_tokens: number;
    max_tokens: number | null;
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
  };
}

// The turn-complete signal. A run in streaming-input mode stays alive
// between turns (the CLI waits for the next prompt), so the run being live
// says nothing about whether the agent is working: this event does. Emitted
// by the adapter on a successful provider result; a failed result ends the
// run instead (run_ended with its reason). Persisted like every event so a
// replay knows the last turn is over. Renders nothing.
export interface TurnEndedEvent {
  kind: "turn_ended";
  payload: {
    run_id: string;
    // #490: how many of the messages sent into this run this turn answered.
    // One turn is not one message: the SDK folds sends that arrive close
    // together, or land while a turn is running, into a single turn with a
    // single result ("queued sends may coalesce into fewer turns" --
    // SDKResultMessage, @anthropic-ai/claude-agent-sdk 0.3.270), so
    // counting turn_ended events is not counting answered messages.
    // Absent when the adapter cannot tell: one message then, which is the
    // documented one-result-per-turn default.
    consumed_messages?: number;
  };
}

export type CanonicalEvent =
  | RunStartedEvent
  | RunEndedEvent
  | TurnEndedEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ReasoningEvent
  | ToolCallEvent
  | FileChangeEvent
  | QuestionEvent
  | CompactionEvent
  | HandoffEvent
  | StateChangedEvent
  | ErrorEvent
  | ContextUsageEvent;
