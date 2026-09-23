import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toCanonicalEvent,
  sessionStatusChip,
  insertBySeq,
  latestQuestionEvent,
  approvalChoices,
  appendDelta,
  clearDeltaBuffer,
  collapseToolCalls,
  deriveTranscriptRows,
  activitySummary,
  workingPhase,
  turnInFlight,
  runIsLiveFor,
  createDeltaCoalescer,
  transcriptElsewhere,
  type ActivityItem,
  type ActivityRow,
  type ChatEvent,
} from "../apps/web/src/lib/session-chat.js";

function ev(seq: number, kind: string, payload: unknown): ChatEvent {
  return { seq, event: toCanonicalEvent(kind, payload) };
}

describe("sessionStatusChip", () => {
  it("running with no open question is 'Běží', pulsing", () => {
    const chip = sessionStatusChip("running", null);
    assert.equal(chip.label, "Běží");
    assert.equal(chip.pulsing, true);
  });

  it("running WITH waiting_since is 'Čeká na mě', overriding the plain running label", () => {
    const chip = sessionStatusChip("running", "2026-09-13 10:00:00");
    assert.equal(chip.label, "Čeká na mě");
  });

  it("suspended is never 'Čeká na mě' even if waiting_since is stale/set", () => {
    const chip = sessionStatusChip("suspended", "2026-09-13 10:00:00");
    assert.equal(chip.label, "Pozastaveno");
    assert.equal(chip.pulsing, false);
  });

  it("closed and archived are not pulsing", () => {
    assert.equal(sessionStatusChip("closed", null).pulsing, false);
    assert.equal(sessionStatusChip("archived", null).pulsing, false);
  });
});

describe("latestQuestionEvent", () => {
  it("returns null when no question event exists", () => {
    const events = [ev(1, "user_message", { text: "hi", source: "chat" })];
    assert.equal(latestQuestionEvent(events), null);
  });

  it("returns the most recent question event, not the first", () => {
    const events = [
      ev(1, "question", { request_id: "q1", type: "input", tool: "AskUserQuestion", title: "old", detail: "", options: null, decision: { by: "U1", value: "x", at: "t" } }),
      ev(2, "assistant_message", { text: "..." }),
      ev(3, "question", { request_id: "q2", type: "approval", tool: "Bash", title: "new", detail: "rm -rf", options: null, decision: null }),
    ];
    const q = latestQuestionEvent(events);
    assert.equal(q?.payload.request_id, "q2");
    assert.equal(q?.payload.title, "new");
  });
});

describe("approvalChoices", () => {
  it("the default Ano/Ne pair answers with booleans, so Ne is a refusal, not a text answer", () => {
    assert.deepEqual(approvalChoices(null), [
      { label: "Ano", value: true },
      { label: "Ne", value: false },
    ]);
  });

  it("explicit options answer with their own label", () => {
    assert.deepEqual(approvalChoices(["Jednou", "Vždy"]), [
      { label: "Jednou", value: "Jednou" },
      { label: "Vždy", value: "Vždy" },
    ]);
  });
});

describe("delta buffers", () => {
  it("appendDelta accumulates text per run_id without touching other runs", () => {
    let buffers = appendDelta({}, "R1", "Hello");
    buffers = appendDelta(buffers, "R1", ", world");
    buffers = appendDelta(buffers, "R2", "other run");
    assert.equal(buffers.R1, "Hello, world");
    assert.equal(buffers.R2, "other run");
  });

  it("clearDeltaBuffer removes only the given run_id's buffer", () => {
    const buffers = { R1: "text", R2: "other" };
    const cleared = clearDeltaBuffer(buffers, "R1");
    assert.equal("R1" in cleared, false);
    assert.equal(cleared.R2, "other");
  });

  it("clearDeltaBuffer is a no-op (same reference-safe shape) for an unknown run_id", () => {
    const buffers = { R1: "text" };
    const cleared = clearDeltaBuffer(buffers, "unknown");
    assert.deepEqual(cleared, buffers);
  });
});

describe("collapseToolCalls", () => {
  it("collapses a started->completed pair for the same tool_use_id into the completed row", () => {
    const events: ChatEvent[] = [
      ev(1, "user_message", { text: "do it", source: "chat" }),
      ev(2, "tool_call", {
        tool_use_id: "t1", tool: "Bash", category: "command", title: "ls", input_summary: "ls",
        status: "started", output_excerpt: null, truncated: false,
      }),
      ev(3, "tool_call", {
        tool_use_id: "t1", tool: "Bash", category: "command", title: "ls", input_summary: "ls",
        status: "completed", output_excerpt: "a.txt\n", truncated: false,
      }),
      ev(4, "assistant_message", { text: "done" }),
    ];
    const collapsed = collapseToolCalls(events);
    assert.equal(collapsed.length, 3);
    assert.equal(collapsed[1].seq, 3, "the completed row survives, not the started one");
    assert.equal((collapsed[1].event as { kind: "tool_call"; payload: { status: string } }).payload.status, "completed");
  });

  it("does not collapse tool calls with different tool_use_id", () => {
    const events: ChatEvent[] = [
      ev(1, "tool_call", { tool_use_id: "t1", tool: "Bash", category: "command", title: "ls", input_summary: "", status: "started", output_excerpt: null, truncated: false }),
      ev(2, "tool_call", { tool_use_id: "t2", tool: "Read", category: "file_read", title: "read", input_summary: "", status: "started", output_excerpt: null, truncated: false }),
    ];
    assert.equal(collapseToolCalls(events).length, 2);
  });

  it("leaves non-tool_call events untouched and in order", () => {
    const events: ChatEvent[] = [
      ev(1, "user_message", { text: "a", source: "chat" }),
      ev(2, "assistant_message", { text: "b" }),
    ];
    assert.deepEqual(collapseToolCalls(events), events);
  });
});

describe("insertBySeq", () => {
  const ev = (seq: number) => ({ seq, event: { kind: "run_started", payload: { run_id: `r${seq}`, runner: "fake", instance_id: null, resume: null } } }) as ChatEvent;
  it("appends in order, ignores a duplicate seq, and slots a late-arriving lower seq into place", () => {
    let list = insertBySeq([], ev(1));
    list = insertBySeq(list, ev(3));
    list = insertBySeq(list, ev(3));
    list = insertBySeq(list, ev(2));
    assert.deepEqual(list.map((e) => e.seq), [1, 2, 3]);
  });
});

// --------------------------------------------------------------- v2
// The activity model (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md):
// rows from events, the group's sentence, the working row, delta batching.

function toolEv(seq: number, id: string, tool: string, status: "started" | "completed" | "failed", title = tool): ChatEvent {
  return ev(seq, "tool_call", {
    tool_use_id: id,
    tool,
    category: "other",
    title,
    input_summary: "{}",
    status,
    output_excerpt: null,
    truncated: false,
  });
}
const runStarted = (seq: number, runId = "R1") =>
  ev(seq, "run_started", { run_id: runId, runner: "claude", instance_id: null, resume: null });

describe("deriveTranscriptRows", () => {
  it("a run with two answers yields two activity groups; bookkeeping yields nothing", () => {
    const rows = deriveTranscriptRows(
      [
        ev(1, "user_message", { text: "hi", source: "chat" }),
        runStarted(2),
        ev(3, "reasoning", { summary: "think" }),
        toolEv(4, "t1", "Read", "started"),
        toolEv(5, "t1", "Read", "completed"),
        ev(6, "assistant_message", { text: "first" }),
        toolEv(7, "t2", "Bash", "failed"),
        ev(8, "assistant_message", { text: "second" }),
        ev(9, "run_ended", { run_id: "R1", reason: "completed", usage: null }),
        ev(10, "state_changed", { from: "running", to: "suspended", waiting: false }),
      ],
      null,
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["prompt", "activity", "answer", "activity", "answer"],
    );
    const g1 = rows[1] as ActivityRow;
    assert.deepEqual(
      g1.items.map((i) => i.kind),
      ["reasoning", "tool"],
    );
    assert.equal((g1.items[1] as { call: { status: string } }).call.status, "completed");
    assert.equal(g1.live, false);
  });

  it("the trailing group of the live run is live; a non-completed run end is an error row", () => {
    const rows = deriveTranscriptRows(
      [ev(1, "user_message", { text: "hi", source: "chat" }), runStarted(2), toolEv(3, "t1", "Read", "started")],
      "R1",
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["prompt", "activity"],
    );
    assert.equal((rows[1] as ActivityRow).live, true);

    const notLive = deriveTranscriptRows([runStarted(1), toolEv(2, "t1", "Read", "completed")], "R2");
    assert.equal((notLive[0] as ActivityRow).live, false);

    const ended = deriveTranscriptRows([runStarted(1), ev(2, "run_ended", { run_id: "R1", reason: "error", usage: null })], null);
    assert.deepEqual(
      ended.map((r) => r.kind),
      ["error"],
    );
    assert.match((ended[0] as { message: string }).message, /chyba/);
    // The ordinary ends are not errors: suspended is every idle/natural end
    // in this runtime, so it yields no row; an interrupt is a neutral note.
    const suspended = deriveTranscriptRows([runStarted(1), ev(2, "run_ended", { run_id: "R1", reason: "suspended", usage: null })], null);
    assert.deepEqual(suspended, []);
    const interrupted = deriveTranscriptRows([runStarted(1), ev(2, "run_ended", { run_id: "R1", reason: "interrupted", usage: null })], null);
    assert.deepEqual(
      interrupted.map((r) => r.kind),
      ["note"],
    );
  });

  it("question, compaction and handoff keep their markers", () => {
    const rows = deriveTranscriptRows(
      [
        ev(1, "question", { request_id: "q", type: "approval", tool: "x", title: "Smím?", detail: "", options: null, decision: null }),
        ev(2, "compaction", { trigger: "auto" }),
        ev(3, "handoff", { path: null, hash: null }),
      ],
      null,
    );
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["question", "compaction", "summary"],
    );
  });
});

describe("activitySummary", () => {
  const items = (calls: [string, "completed" | "failed"][]): ActivityItem[] =>
    calls.map(([tool, status], i) => ({
      kind: "tool" as const,
      seq: i,
      call: { tool_use_id: String(i), tool, category: "other" as const, title: tool, input_summary: "{}", status, output_excerpt: null, truncated: false },
    }));

  const reasoning = (seq: number, durationMs: number | null): ActivityItem => ({ kind: "reasoning", seq, summary: "…", durationMs });

  it("builds the sentence from verb counts; the seconds add up the reasoning blocks' duration_ms", () => {
    const r = activitySummary([
      reasoning(100, 7_400),
      ...items([["Read", "completed"], ["Grep", "completed"], ["Glob", "completed"], ["Edit", "completed"], ["Bash", "completed"], ["Bash", "completed"]]),
      reasoning(101, 4_900),
    ]);
    assert.equal(r.text, "Přečteno 3 soubory · upraveno 1 · 2 příkazy · uvažoval 12 s");
    assert.equal(r.failed, 0);
  });

  it("a reasoning block without a duration adds no seconds; a sub-second one rounds up to 1 s", () => {
    assert.equal(activitySummary([reasoning(1, null), ...items([["Read", "completed"], ["Read", "completed"]])]).text, "Přečteno 2 soubory");
    assert.equal(activitySummary([reasoning(1, 300), ...items([["Bash", "completed"]])]).text, "1 příkaz · uvažoval 1 s");
  });

  it("a single call shows its title; failures are counted", () => {
    assert.equal(activitySummary(items([["Bash", "completed"]])).text, "Bash");
    assert.equal(activitySummary(items([["Bash", "failed"]])).text, "Bash · selhal");
    const r = activitySummary(items([["Bash", "failed"], ["Read", "completed"]]));
    assert.equal(r.failed, 1);
    assert.match(r.text, /1 selhal/);
  });

  it("an unknown tool falls back to its own name; a reasoning-only group says so", () => {
    assert.equal(
      activitySummary(items([["mcp__portuni__portuni_get_node", "completed"], ["mcp__portuni__portuni_get_node", "completed"]])).text,
      "2 × mcp__portuni__portuni_get_node",
    );
    assert.equal(activitySummary([{ kind: "reasoning", seq: 1, summary: "x", durationMs: null }]).text, "Uvažoval");
    assert.equal(activitySummary([{ kind: "reasoning", seq: 1, summary: "x", durationMs: 2_000 }]).text, "Uvažoval 2 s");
  });
});

describe("runIsLiveFor", () => {
  it("is live only with a dangling run_started AND a running session -- a suspended one never is", () => {
    assert.equal(runIsLiveFor("R1", "running"), true);
    assert.equal(runIsLiveFor("R1", "suspended"), false);
    assert.equal(runIsLiveFor(null, "running"), false);
    assert.equal(runIsLiveFor("R1", "closed"), false);
  });
});

describe("workingPhase", () => {
  it("is null with no live run and no message in flight", () => {
    assert.equal(workingPhase([], null, null), null);
  });
  it("starting between send and run_started, thinking after it, continuing after a tool completes", () => {
    // The brief lands as a user_message right after run_started; that is
    // what opens the turn.
    const brief = ev(2, "user_message", { text: "go", source: "chat" });
    assert.equal(workingPhase([], null, Date.now()), "starting");
    assert.equal(workingPhase([runStarted(1), brief], "R1", null), "thinking");
    assert.equal(workingPhase([runStarted(1), brief, toolEv(3, "t1", "Read", "completed")], "R1", null), "continuing");
    assert.equal(workingPhase([runStarted(1), brief, ev(3, "assistant_message", { text: "a" })], "R1", null), "continuing");
    // A running tool has its own live row; the working row steps aside.
    assert.equal(workingPhase([runStarted(1), brief, toolEv(3, "t1", "Read", "started")], "R1", null), null);
  });
});

describe("createDeltaCoalescer", () => {
  it("N frames in one tick deliver as one batch with the text concatenated per channel", () => {
    let tick: (() => void) | null = null;
    const delivered: unknown[] = [];
    const c = createDeltaCoalescer(
      (b) => delivered.push(b),
      (cb) => {
        tick = cb;
        return () => {
          tick = null;
        };
      },
    );
    c.push({ run_id: "R1", channel: "text", text: "ab" });
    c.push({ run_id: "R1", channel: "text", text: "cd" });
    c.push({ run_id: "R1", channel: "reasoning", text: "th" });
    assert.equal(delivered.length, 0);
    (tick as unknown as () => void)();
    assert.deepEqual(delivered, [
      [
        { run_id: "R1", channel: "text", text: "abcd" },
        { run_id: "R1", channel: "reasoning", text: "th" },
      ],
    ]);
  });

  it("flush delivers immediately and cancels the tick; clear drops without delivering", () => {
    let cancelled = 0;
    const delivered: unknown[] = [];
    const c = createDeltaCoalescer(
      (b) => delivered.push(b),
      () => () => {
        cancelled++;
      },
    );
    c.push({ run_id: "R1", channel: "text", text: "x" });
    c.flush();
    assert.equal(delivered.length, 1);
    assert.equal(cancelled, 1);
    c.push({ run_id: "R1", channel: "text", text: "y" });
    c.clear();
    c.flush();
    assert.equal(delivered.length, 1);
  });
});

describe("turnInFlight", () => {
  const ev = (seq: number, event: unknown) => ({ seq, event }) as ChatEvent;
  const started = ev(1, { kind: "run_started", payload: { run_id: "r1", runner: "claude", instance_id: null, resume: null } });
  const said = ev(2, { kind: "assistant_message", payload: { text: "hi" } });
  const ended = ev(3, { kind: "turn_ended", payload: { run_id: "r1" } });
  const asked = ev(4, { kind: "user_message", payload: { text: "more", source: "chat" } });

  it("a turn opens with a message, not with the run start", () => {
    // Navázat / a resume start the process with no prompt: the run waits
    // for the first message and nothing is in flight until it lands.
    assert.equal(turnInFlight([], "r1"), false);
    assert.equal(turnInFlight([started], "r1"), false);
    assert.equal(turnInFlight([started, asked], "r1"), true);
    assert.equal(turnInFlight([started, asked, said], "r1"), true);
  });
  it("workingPhase shows nothing for a run waiting for its first message", () => {
    assert.equal(workingPhase([started], "r1", null), null);
    assert.equal(workingPhase([started, asked], "r1", null), "thinking");
  });
  it("turn_ended for the live run ends the turn", () => {
    assert.equal(turnInFlight([started, asked, said, ended], "r1"), false);
  });
  it("the next message starts a turn again", () => {
    assert.equal(turnInFlight([started, said, ended, asked], "r1"), true);
  });
  it("a turn_ended of another run does not count", () => {
    const other = ev(3, { kind: "turn_ended", payload: { run_id: "r0" } });
    assert.equal(turnInFlight([started, asked, said, other], "r1"), true);
  });
  it("bookkeeping after turn_ended keeps the turn idle", () => {
    const usage = ev(5, { kind: "context_usage", payload: { run_id: "r1", model: null, used_tokens: 1, max_tokens: null, input_tokens: 1, cached_tokens: 0, output_tokens: 0 } });
    assert.equal(turnInFlight([started, said, ended, usage], "r1"), false);
  });
  it("no live run is never in flight", () => {
    assert.equal(turnInFlight([started, asked, said], null), false);
  });
  it("workingPhase shows nothing once the turn ended", () => {
    assert.equal(workingPhase([started, said, ended], "r1", null), null);
    assert.equal(workingPhase([started, said, ended, asked], "r1", null), "thinking");
  });
});

// #461: the conversation lives on the device that ran it, so a second
// device holds the record and nothing else. `transcriptElsewhere` is what
// the chat asks before it decides to show an empty transcript.
describe("transcriptElsewhere", () => {
  it("is nothing when the events route named no other host", () => {
    assert.equal(transcriptElsewhere(null, 0), null);
    assert.equal(transcriptElsewhere(null, 12), null);
  });

  it("names the machine holding the transcript when this one has none of it", () => {
    const state = transcriptElsewhere("MacBook Pro", 0);
    assert.ok(state);
    assert.equal(state.host, "MacBook Pro");
    assert.equal(state.title, "Transkript je na zařízení MacBook Pro");
    assert.match(state.hint, /Předat/);
    assert.match(state.hint, /MacBook Pro/);
  });

  it("stands down as soon as the transcript is here after all", () => {
    // A run that started writing on this device between the header call
    // and the replay: the log wins, the notice goes.
    assert.equal(transcriptElsewhere("MacBook Pro", 1), null);
  });
});
