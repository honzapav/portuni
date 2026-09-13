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
  // `by` (docs/superpowers/specs/2026-09-12-remote-hosts-and-task-queue-design.md,
  // "Visibility and control"): set only when a stop action (interrupt/
  // suspend/close) was taken by someone other than the session's owner --
  // "the chat shows who stopped it". Absent for every ordinary transition
  // (question opened/answered, run ended), which have no such actor to name.
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

// Streamed text, never persisted (rule 3: "Events are the record; deltas
// are not"). Carried only on the live channel (the WebSocket issue).
export interface DeltaFrame {
  type: "delta";
  run_id: string;
  text: string;
}

// --- Runner interface (spec: "Runner interface") -------------------------
// The contract every adapter (adapters/claude.ts, adapters/fake.ts, and
// later Codex/OpenCode) implements, and the shape session-runtime.ts drives
// them through. Deliberately free of any SDK type -- an adapter translates
// its own provider's shapes into this one, not the other way around.

// "default" enforces the write tiers and asks before an mcp__portuni__
// portuni_expand_scope call (permissions.ts); "auto" allows scope expansion
// without asking -- everything else (write tiers, AskUserQuestion,
// ExitPlanMode) is unaffected by the policy.
export type PermissionPolicy = "default" | "auto";

export interface RunnerAvailability {
  installed: boolean;
  version: string | null;
  logged_in: boolean;
  instances_supported: boolean;
}

export interface RunStart {
  sessionId: string;
  runId: string;
  cwd: string;
  // First user message on a fresh run; null on a resume (the conversation
  // already has the context).
  brief: string | null;
  resume: null | { agentSessionId: string; at?: string };
  // Appended to the runner's own system prompt.
  orientation: string;
  instance: { id: string | null; env: Record<string, string> };
  // headers always carries X-Portuni-Spawn-Id: <sessionId> so the runner's
  // MCP handshake binds to the session row the runtime already created
  // (the REST/MCP issue makes the transport honour it).
  mcp: { url: string; token: string; homeNodeId: string; headers: Record<string, string> };
  policy: PermissionPolicy;
}

export interface RunHandle {
  // Next user message (queued mid-turn if the runner is still working).
  send(text: string): Promise<void>;
  answer(requestId: string, decision: QuestionDecision): Promise<void>;
  interrupt(): Promise<void>;
  // Graceful end of the run's process.
  close(): Promise<void>;
  agentSessionId(): string | null;
}

export type EventSink = (event: CanonicalEvent | DeltaFrame) => void;

export interface RunnerAdapter {
  // e.g. "claude", "fake" -- string rather than a literal union so the
  // registry (a later issue) can hold a heterogeneous set of adapters.
  id: string;
  detect(): Promise<RunnerAvailability>;
  start(run: RunStart, sink: EventSink): Promise<RunHandle>;
}
