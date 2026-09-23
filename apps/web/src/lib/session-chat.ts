// Pure, testable logic for SessionChat (#342, docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md "Web: Práce, New task") -- event
// grouping, status-chip derivation, the open-question panel, streamed-delta
// buffering. Dependency-free (no React) so
// test/session-chat-helpers.test.ts can exercise it directly against
// fixture event arrays, same convention as lib/sessions.ts.
//
// CanonicalEvent mirrors apps/server/domain/runner/types.ts's own union
// exactly. domain/runner/types.ts is server-only (not under shared/, which
// exists precisely so the web can type REST responses without importing
// server domain code) -- this is a deliberate parallel definition of the
// wire shape, not an import across that boundary.

import type { SessionState } from "../types";
import { sessionRowChip } from "./session-views";

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
// #378: always server-written now -- no more generated_by to distinguish.
export interface HandoffEvent {
  kind: "handoff";
  payload: { path: string | null; hash: string | null };
}
export interface StateChangedEvent {
  kind: "state_changed";
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

// The turn-complete signal (server: TurnEndedEvent). A live run is not a
// working agent: between turns the process only waits for the next
// message, and this is the event that says the last turn is over.
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

// Inserts an event into a seq-ordered list, ignoring a seq already present:
// a subscribe replay and a live frame published during it can both carry
// the same event, and a resubscribe after a reconnect replays from the
// last seq seen, so an event never lands twice and never out of order.
export function insertBySeq(list: readonly ChatEvent[], item: ChatEvent): ChatEvent[] {
  if (list.some((p) => p.seq === item.seq)) return list as ChatEvent[];
  const last = list[list.length - 1];
  if (!last || last.seq < item.seq) return [...list, item];
  const idx = list.findIndex((p) => p.seq > item.seq);
  return [...list.slice(0, idx), item, ...list.slice(idx)];
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

// The header chip: the row chip's wording variant (lib/session-views.ts
// owns the table).
export function sessionStatusChip(state: SessionState, waitingSince: string | null): StatusChip {
  return sessionRowChip(state, waitingSince, "header");
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

// The buttons of an approval question. Without explicit options it is a
// yes/no decision: the runner reads true as allow and false as a refusal,
// while any string is an answer and therefore allows.
export function approvalChoices(
  options: readonly string[] | null,
): { label: string; value: string | boolean }[] {
  if (options === null) {
    return [
      { label: "Ano", value: true },
      { label: "Ne", value: false },
    ];
  }
  return options.map((label) => ({ label, value: label }));
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

// --- Naming (#374) -----------------------------------------------------------

const THREAD_NAME_MAX_LENGTH = 60;

// A thread names itself from its first message: first line, trimmed,
// whitespace collapsed, cut at ~60 characters on a word boundary with an
// ellipsis. The server (domain/sessions.ts's threadNameFromFirstMessage)
// is what actually writes the name when a draft is promoted -- this copy
// exists for the composer's own optimistic display and is exercised by the
// same test suite, duplicated rather than imported across the server/web
// boundary like this file's CanonicalEvent mirror.
export function threadNameFromFirstMessage(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  if (collapsed.length <= THREAD_NAME_MAX_LENGTH) return collapsed;
  const truncated = collapsed.slice(0, THREAD_NAME_MAX_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut}…`;
}

// --- Transcript rows (v2 spec, "The activity model") -------------------------
// The transcript is a list of rows derived from the canonical events: the
// prompt and the answer at full weight, everything between two answers of
// one run folded into one activity group, run bookkeeping into nothing.

export type ActivityItem =
  | { kind: "reasoning"; seq: number; summary: string; durationMs: number | null }
  | { kind: "tool"; seq: number; call: ToolCallEvent["payload"] }
  | { kind: "file_change"; seq: number; path: string; op: FileChangeOp };

export type ActivityRow = { kind: "activity"; key: string; runId: string | null; items: ActivityItem[]; live: boolean };

export type TranscriptRow =
  | { kind: "prompt"; key: string; text: string }
  | { kind: "answer"; key: string; text: string }
  | ActivityRow
  | { kind: "question"; key: string; title: string }
  | { kind: "compaction"; key: string }
  | { kind: "summary"; key: string }
  | { kind: "note"; key: string; text: string }
  | { kind: "error"; key: string; message: string };

export function runEndReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    completed: "dokončeno",
    interrupted: "přerušeno",
    suspended: "pozastaveno",
    error: "chyba",
    limit: "limit",
    host_lost: "proces osiřel",
  };
  return labels[reason] ?? reason;
}

// `liveRunId` says which run is live: its trailing activity group (after
// the last answer) is marked live, so the renderer keeps it expanded on
// the running tool. run_started and state_changed yield nothing. A
// run_ended yields nothing for `completed` and `suspended` (the ordinary
// ends -- the notice bar already says the process is gone), a neutral
// note for `interrupted`, and an error row for `error`, `limit` and
// `host_lost`.
export function deriveTranscriptRows(events: readonly ChatEvent[], liveRunId: string | null): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  // Held in an object so the closures below can reset it -- a plain `let`
  // narrows to `null` for the reader after the loop.
  const group: { open: ActivityRow | null } = { open: null };
  let currentRun: string | null = null;
  const close = (): void => {
    group.open = null;
  };
  const push = (item: ActivityItem): void => {
    if (!group.open) {
      group.open = { kind: "activity", key: `a${item.seq}`, runId: currentRun, items: [], live: false };
      rows.push(group.open);
    }
    group.open.items.push(item);
  };
  for (const { seq, event } of collapseToolCalls(events)) {
    switch (event.kind) {
      case "user_message":
        close();
        rows.push({ kind: "prompt", key: `e${seq}`, text: event.payload.text });
        break;
      case "assistant_message":
        close();
        rows.push({ kind: "answer", key: `e${seq}`, text: event.payload.text });
        break;
      case "reasoning":
        push({ kind: "reasoning", seq, summary: event.payload.summary, durationMs: event.payload.duration_ms ?? null });
        break;
      case "tool_call":
        push({ kind: "tool", seq, call: event.payload });
        break;
      case "file_change":
        push({ kind: "file_change", seq, path: event.payload.path, op: event.payload.op });
        break;
      case "run_started":
        currentRun = event.payload.run_id;
        close();
        break;
      case "run_ended":
        close();
        if (event.payload.reason === "interrupted") {
          rows.push({ kind: "note", key: `e${seq}`, text: "Přerušeno" });
        } else if (event.payload.reason !== "completed" && event.payload.reason !== "suspended") {
          rows.push({ kind: "error", key: `e${seq}`, message: `Běh skončil: ${runEndReasonLabel(event.payload.reason)}` });
        }
        currentRun = null;
        break;
      case "question":
        close();
        rows.push({ kind: "question", key: `e${seq}`, title: event.payload.title });
        break;
      case "compaction":
        close();
        rows.push({ kind: "compaction", key: `e${seq}` });
        break;
      case "handoff":
        close();
        rows.push({ kind: "summary", key: `e${seq}` });
        break;
      case "error":
        close();
        rows.push({ kind: "error", key: `e${seq}`, message: event.payload.message });
        break;
      default:
        break;
    }
  }
  const trailing = group.open;
  if (trailing && liveRunId !== null && trailing.runId === liveRunId) trailing.live = true;
  return rows;
}

// --- The activity sentence ---------------------------------------------------
// "Přečteno 3 soubory · upraveno 1 · 2 příkazy · uvažoval 12 s". The verb
// table covers Claude's tool names; another runner's tools fall back to
// their own names (spec, known gaps). The seconds are the group's
// reasoning blocks' `duration_ms` added up; a block without one (no
// delta streamed) counts as reasoning but adds no time.

type ToolVerb = "read" | "edited" | "created" | "command";
const TOOL_VERBS: Record<string, ToolVerb> = {
  Read: "read",
  Glob: "read",
  Grep: "read",
  LS: "read",
  WebFetch: "read",
  WebSearch: "read",
  Edit: "edited",
  MultiEdit: "edited",
  NotebookEdit: "edited",
  Write: "created",
  Bash: "command",
};

export function toolVerbCounts(items: readonly ActivityItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const key = TOOL_VERBS[item.call.tool] ?? `tool:${item.call.tool}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function czechCount(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

export function reasoningSeconds(items: readonly ActivityItem[]): number {
  let ms = 0;
  for (const item of items) if (item.kind === "reasoning" && item.durationMs !== null) ms += item.durationMs;
  return ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0;
}

export function activitySummary(items: readonly ActivityItem[]): { text: string; failed: number } {
  const seconds = reasoningSeconds(items);
  const tools = items.filter((i): i is Extract<ActivityItem, { kind: "tool" }> => i.kind === "tool");
  const failed = tools.filter((t) => t.call.status === "failed").length;
  // A group with a single call shows that call's title instead of a sentence.
  if (tools.length === 1 && !seconds) {
    const t = tools[0];
    const title = t.call.title || t.call.tool;
    return { text: failed ? `${title} · selhal` : title, failed };
  }
  const parts: string[] = [];
  const counts = toolVerbCounts(items);
  const read = counts.get("read");
  if (read) parts.push(`přečteno ${read} ${czechCount(read, "soubor", "soubory", "souborů")}`);
  const edited = counts.get("edited");
  if (edited) parts.push(`upraveno ${edited}`);
  const created = counts.get("created");
  if (created) parts.push(`vytvořeno ${created}`);
  const cmd = counts.get("command");
  if (cmd) parts.push(`${cmd} ${czechCount(cmd, "příkaz", "příkazy", "příkazů")}`);
  for (const [key, n] of counts) if (key.startsWith("tool:")) parts.push(`${n} × ${key.slice(5)}`);
  if (seconds) parts.push(`uvažoval ${seconds} s`);
  if (failed) parts.push(`${failed} ${czechCount(failed, "selhal", "selhaly", "selhalo")}`);
  if (parts.length === 0 && items.some((i) => i.kind === "reasoning")) parts.push("uvažoval");
  const text = parts.join(" · ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed };
}

// Whether the thread has a live run for the UI's purposes (working row,
// stop button, composer). The replayed log says "a run_started with no
// run_ended yet"; the server's own state says whether the session is
// running at all. A suspended session with a dangling run_started (a log
// older than the server-side suspend writing run_ended) is not live.
export function runIsLiveFor(liveRunId: string | null, state: SessionState): boolean {
  return liveRunId !== null && state === "running";
}

// Whether the live run is in the middle of a turn: the working row, the
// stop button and Escape apply only then. A turn opens with a
// user_message and closes with the run's turn_ended; the run start alone
// opens none -- a promotion writes the first message as a user_message right
// after it, while Navázat and a resume start the process with no prompt
// and wait for the first message. Walks back from the newest event;
// bookkeeping events in between decide nothing.
export function turnInFlight(events: readonly ChatEvent[], liveRunId: string | null): boolean {
  if (liveRunId === null) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event;
    if (e.kind === "turn_ended") {
      if (e.payload.run_id === liveRunId) return false;
      continue;
    }
    if (e.kind === "user_message") return true;
    if (e.kind === "run_started" && e.payload.run_id === liveRunId) return false;
  }
  return false;
}

// --- The working row -----------------------------------------------------------
// Rule 2: something is always on screen while a turn is in flight. When
// neither streaming text nor a running tool is, this row is, labelled by
// the last thing that happened. Between turns (turn_ended) nothing is.

export type WorkingPhase = "starting" | "thinking" | "continuing";
export const WORKING_LABEL: Record<WorkingPhase, string> = {
  starting: "Spouštím…",
  thinking: "Přemýšlím…",
  continuing: "Pokračuji…",
};

// null = nothing to show: no run and no send in flight, or the run's last
// event is a still-running tool (the live activity row shows that one).
export function workingPhase(
  events: readonly ChatEvent[],
  liveRunId: string | null,
  sentAt: number | null,
): WorkingPhase | null {
  if (liveRunId === null) return sentAt !== null ? "starting" : null;
  if (!turnInFlight(events, liveRunId)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event;
    if (e.kind === "run_started" && e.payload.run_id === liveRunId) return "thinking";
    // A message into a live run opens a new turn: nothing has happened in
    // it yet, whatever the previous turn ended with.
    if (e.kind === "user_message") return "thinking";
    if (e.kind === "tool_call") return e.payload.status === "started" ? null : "continuing";
    if (e.kind === "assistant_message" || e.kind === "reasoning") return "continuing";
  }
  return "thinking";
}

// --- The send clock (`sentAt`) -------------------------------------------------
// #466, spec docs/superpowers/specs/2026-09-22-web-session-state-design.md
// ("`SessionChat`"): the composer sets the clock before the send is awaited
// -- run_started, and a run_ended right behind it, can arrive while the
// reply is still in flight -- and three things clear it: run_started (the
// run it announced is here), run_ended (the run it announced is over,
// an error at start included) and a send that failed. Pure, so the rule is
// held by a test (scenario 7) and not by the order of setState calls.

export type SendClockInput =
  // The composer sent a message. A live run needs no clock: its
  // run_started already happened, so nothing is "starting".
  | { kind: "send"; liveRunId: string | null; now: number }
  | { kind: "send_failed" }
  | { kind: "event"; event: CanonicalEvent }
  // A fresh subscribe (a different thread, a re-subscribe): nothing is in
  // flight that this window knows of.
  | { kind: "reset" };

export function nextSentAt(current: number | null, input: SendClockInput): number | null {
  switch (input.kind) {
    case "send":
      return input.liveRunId === null ? input.now : current;
    case "send_failed":
    case "reset":
      return null;
    case "event":
      return input.event.kind === "run_started" || input.event.kind === "run_ended" ? null : current;
  }
}

// --- Delta coalescing (v2 spec, "Streaming") ----------------------------------
// A burst of delta frames costs one render: frames are buffered per
// (run, channel) and delivered once per scheduler tick. The desktop bridge
// forwards frames unchanged; this is the webview's own batching.

export type StreamDelta = { run_id: string; channel: "text" | "reasoning"; text: string };

export interface DeltaCoalescer {
  push(delta: StreamDelta): void;
  // Deliver what is buffered now (a run_ended, an unmount) and cancel the tick.
  flush(): void;
  // Drop what is buffered without delivering.
  clear(): void;
}

export function createDeltaCoalescer(
  deliver: (batch: StreamDelta[]) => void,
  schedule: (cb: () => void) => () => void,
): DeltaCoalescer {
  const buffer = new Map<string, StreamDelta>();
  let cancel: (() => void) | null = null;
  const drain = (): void => {
    cancel = null;
    if (buffer.size === 0) return;
    const batch = [...buffer.values()];
    buffer.clear();
    deliver(batch);
  };
  return {
    push(delta) {
      const key = `${delta.run_id}\u0000${delta.channel}`;
      const prev = buffer.get(key);
      buffer.set(key, prev ? { ...prev, text: prev.text + delta.text } : { ...delta });
      if (!cancel) cancel = schedule(drain);
    },
    flush() {
      if (cancel) {
        cancel();
        cancel = null;
      }
      drain();
    },
    clear() {
      buffer.clear();
      if (cancel) {
        cancel();
        cancel = null;
      }
    },
  };
}

// --- The transcript is on another machine (#461) ----------------------
//
// A thread's content lives on the device that ran it and is never copied
// to the central server, so a thread opened from a second device of the
// same person has a record here and no transcript. The events route says
// so itself: `transcript_host` is set only when that device has no rows
// for the thread and the record names a different machine
// (`transcriptHostLabel`, apps/server/domain/runner/hosts.ts). This is the
// pure form of what the chat then shows instead of an empty conversation.
//
// `eventCount` is the transcript the chat actually holds: the live channel
// replays from the same content db, so a non-empty log means the content
// is here after all and the header is stale (a race with a run that just
// started writing here).
export interface TranscriptElsewhere {
  host: string;
  title: string;
  hint: string;
}

export function transcriptElsewhere(host: string | null, eventCount: number): TranscriptElsewhere | null {
  if (!host || eventCount > 0) return null;
  return {
    host,
    title: `Transkript je na zařízení ${host}`,
    hint:
      `Vlákno běželo na zařízení ${host} a jeho obsah zůstává tam — Portuni konverzace nikam nekopíruje. ` +
      `Chceš-li v něm pokračovat tady, použij tam akci Předat a na vzniklý soubor handoffu navaž v záložce Relace.`,
  };
}
