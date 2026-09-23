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
  payload: { class: ErrorClass; message: string };
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
  payload: { run_id: string };
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

export type CanonicalEventKind = CanonicalEvent["kind"];

// Streamed text, never persisted (rule 3: "Events are the record; deltas
// are not"). Carried only on the live channel (the WebSocket issue).
// `channel` says which persisted event this delta is a live preview of --
// "text" builds up towards an assistant_message, "reasoning" towards a
// reasoning event -- so a client can buffer and render the two separately.
export interface DeltaFrame {
  type: "delta";
  run_id: string;
  channel: "text" | "reasoning";
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

// Reasoning effort (#375, phase 4 of docs/superpowers/specs/2026-09-15-
// task-surface-design.md): mirrors @anthropic-ai/claude-agent-sdk's own
// EffortLevel exactly, duplicated here (not imported) so this adapter-
// agnostic types file has no dependency on a specific runner's SDK package
// -- the Claude adapter is the only one that currently reads it.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface RunnerAvailability {
  installed: boolean;
  version: string | null;
  logged_in: boolean;
  instances_supported: boolean;
}

// #376: one entry in a runner's model picker (GET /runners/:runner/models).
// `id` is what a caller sends back as `model` on POST/PATCH /sessions.
export interface RunnerModel {
  id: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  effortLevels: readonly EffortLevel[];
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
  // permissions.ts's decidePermission needs these to classify a write tool's
  // target path (classifyWrite) -- provision.ts/provision-central.ts already
  // compute both, they just weren't threaded onto RunStart until the Claude
  // adapter (#324) needed them.
  portuniRoot: string;
  mirrors: readonly string[];
  // #375: resolved once by session-runtime.ts (the thread's own value, else
  // the runner instance's defaults, else unset) -- the adapter never reads
  // config itself. null means "the runner's own default", not "off".
  model: string | null;
  effort: EffortLevel | null;
}

// #489: what send() throws when the run behind the handle is over or in
// teardown. Pushing the message into a prompt stream nobody reads any more
// would drop it silently -- the message is already in the chat by then, so
// the runtime has to learn that this run never got it and deliver it to the
// next one instead.
export class RunEndedError extends Error {
  constructor(message = "the run has ended") {
    super(message);
    this.name = "RunEndedError";
  }
}

export function isRunEndedError(e: unknown): boolean {
  return e instanceof RunEndedError || (e instanceof Error && e.name === "RunEndedError");
}

export interface RunHandle {
  // Next user message (queued mid-turn if the runner is still working).
  // Throws RunEndedError when the run is already over or tearing down --
  // never drops the message silently (#489).
  send(text: string): Promise<void>;
  answer(requestId: string, decision: QuestionDecision): Promise<void>;
  interrupt(): Promise<void>;
  // Graceful end of the run's process.
  close(): Promise<void>;
  // #375: changes the model on the LIVE query, no restart -- the one
  // setting the SDK allows to change mid-run. null resets to the runner's
  // own default. Reasoning effort has no equivalent live setter (SDK
  // limitation); it only ever applies from the next run.
  setModel(model: string | null): Promise<void>;
  agentSessionId(): string | null;
  // The runner's own child process id, or null when the adapter has none
  // (the fake adapter, or a real one that hasn't captured it yet) -- the
  // pid-file boot sweep (#325) uses this to notice and clean up a run whose
  // process outlived the sidecar that started it.
  pid(): number | null;
}

export type EventSink = (event: CanonicalEvent | DeltaFrame) => void;

export interface RunnerAdapter {
  // e.g. "claude", "fake" -- string rather than a literal union so the
  // registry (a later issue) can hold a heterogeneous set of adapters.
  id: string;
  detect(): Promise<RunnerAvailability>;
  start(run: RunStart, sink: EventSink): Promise<RunHandle>;
  // #376: the picker's list. Never starts a process just to build it --
  // an adapter that hasn't run anything yet in this process returns a
  // documented fallback (aliases plus free text) rather than throwing or
  // blocking.
  models(): Promise<RunnerModel[]>;
}
