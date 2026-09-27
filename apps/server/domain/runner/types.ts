// Canonical event model for the runner batch (docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md, "Events"). session_events is the
// record the chat renders from after a reload -- streamed text deltas
// (DeltaFrame, defined by the live-channel issue) never persist. This file
// grows the RunnerAdapter/RunHandle/RunStart interface as later runner-batch
// issues land (#318 adds them); for now it holds only what the storage layer
// (store.ts) needs to type and cap event payloads.

import type { ModelDescriptionCode } from "../../shared/chat-event-codes.js";
import type { CanonicalEvent, QuestionDecision } from "../../shared/session-events.js";

// The event types themselves live in shared/session-events.ts so the web
// types the same union; re-exported here for every server import.
export type {
  RunEndReason,
  ToolCallCategory,
  QuestionDecision,
  CanonicalEvent,
} from "../../shared/session-events.js";

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
  // The provider's own text; empty when description_code is set (#532).
  description: string;
  description_code?: ModelDescriptionCode;
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
