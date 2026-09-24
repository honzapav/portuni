import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toCanonicalEvent,
  sessionStatusChip,
  insertManyBySeq,
  latestQuestionEvent,
  approvalChoices,
  appendDelta,
  clearDeltaBuffer,
  deltaBuffersAfter,
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
  askPrompts,
  togglePick,
  picksComplete,
  askAnswer,
  createAnswerGate,
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

  // #495: a Stop mid-answer ends the turn with text streamed and never
  // finalized; the next turn's answer starts from an empty buffer.
  it("turn_ended clears the run's buffers on both channels, so the next turn's delta starts clean", () => {
    const turnEnded = toCanonicalEvent("turn_ended", { run_id: "R1" });
    let text = appendDelta({}, "R1", "rozepsaná odpověď");
    let reasoning = appendDelta({}, "R1", "rozepsaná úvaha");
    text = deltaBuffersAfter(text, "text", turnEnded, "R1");
    reasoning = deltaBuffersAfter(reasoning, "reasoning", turnEnded, "R1");
    assert.deepEqual(text, {});
    assert.deepEqual(reasoning, {});
    text = appendDelta(text, "R1", "nová odpověď");
    assert.deepEqual(text, { R1: "nová odpověď" });
  });

  it("deltaBuffersAfter clears on the finalized block of its own channel and on run_ended, nothing else", () => {
    const buffers = { R1: "x", R2: "y" };
    assert.deepEqual(deltaBuffersAfter(buffers, "text", toCanonicalEvent("assistant_message", { text: "x" }), "R1"), { R2: "y" });
    assert.equal(deltaBuffersAfter(buffers, "reasoning", toCanonicalEvent("assistant_message", { text: "x" }), "R1"), buffers);
    assert.deepEqual(deltaBuffersAfter(buffers, "reasoning", toCanonicalEvent("reasoning", { summary: "s" }), "R1"), { R2: "y" });
    assert.deepEqual(
      deltaBuffersAfter(buffers, "text", toCanonicalEvent("run_ended", { run_id: "R2", reason: "completed", usage: null }), null),
      { R1: "x" },
    );
    assert.equal(deltaBuffersAfter(buffers, "text", toCanonicalEvent("user_message", { text: "hi", source: "chat" }), "R1"), buffers);
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

describe("insertManyBySeq", () => {
  const ev = (seq: number) => ({ seq, event: { kind: "run_started", payload: { run_id: `r${seq}`, runner: "fake", instance_id: null, resume: null } } }) as ChatEvent;
  it("appends in order, ignores a duplicate seq, and slots a late-arriving lower seq into place", () => {
    let list = insertManyBySeq([], [ev(1)]);
    list = insertManyBySeq(list, [ev(3)]);
    list = insertManyBySeq(list, [ev(3)]);
    list = insertManyBySeq(list, [ev(2)]);
    assert.deepEqual(list.map((e) => e.seq), [1, 2, 3]);
  });
  it("merges a page in one pass, dropping seqs already present or repeated in the page", () => {
    const before = insertManyBySeq([], [ev(1), ev(4)]);
    const after = insertManyBySeq(before, [ev(2), ev(4), ev(3), ev(3), ev(5)]);
    assert.deepEqual(after.map((e) => e.seq), [1, 2, 3, 4, 5]);
  });
  it("returns the same list when a page brings nothing new", () => {
    const list = insertManyBySeq([], [ev(1), ev(2)]);
    assert.equal(insertManyBySeq(list, [ev(2), ev(1)]), list);
    assert.equal(insertManyBySeq(list, []), list);
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
      [runStarted(1), ev(2, "user_message", { text: "hi", source: "chat" }), toolEv(3, "t1", "Read", "started")],
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

  // #495: after a Stop mid-tool the run stays open, waiting for the next
  // message; nothing in it is working, so its trailing group is not live.
  it("after turn_ended the live run's trailing group is not live", () => {
    const events = [
      runStarted(1),
      ev(2, "user_message", { text: "hi", source: "chat" }),
      toolEv(3, "t1", "Bash", "started"),
      ev(4, "turn_ended", { run_id: "R1" }),
    ];
    const rows = deriveTranscriptRows(events, "R1");
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["prompt", "activity"],
    );
    assert.equal((rows[1] as ActivityRow).live, false);
    // The next message opens a new turn: its trailing group is live again.
    const next = deriveTranscriptRows(
      [...events, ev(5, "user_message", { text: "dál", source: "chat" }), toolEv(6, "t2", "Read", "started")],
      "R1",
    );
    assert.equal((next[next.length - 1] as ActivityRow).live, true);
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

  it("drop discards one run+channel's pending frames, leaving the rest to deliver", () => {
    // The finalized assistant_message/reasoning event carries the whole
    // block: whatever of it is still buffered is a stale preview and must
    // never land in a buffer the event just cleared.
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
    c.push({ run_id: "R1", channel: "text", text: "?" });
    c.push({ run_id: "R1", channel: "reasoning", text: "th" });
    c.push({ run_id: "R2", channel: "text", text: "keep" });
    c.drop("R1", "text");
    (tick as unknown as () => void)();
    assert.deepEqual(delivered, [
      [
        { run_id: "R1", channel: "reasoning", text: "th" },
        { run_id: "R2", channel: "text", text: "keep" },
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
  // #489: a message the ending run r0 refused is logged before r1 starts
  // and redelivered as r1's first message; r1's run_started says it carries
  // one, so the chat shows the turn working (Stop, Esc, the working row).
  it("a redelivered message counts from the run that carries it", () => {
    const r0 = ev(1, { kind: "run_started", payload: { run_id: "r0", runner: "claude", instance_id: null, resume: null } });
    const refused = ev(2, { kind: "user_message", payload: { text: "tak co teď?", source: "chat" } });
    const r0End = ev(3, { kind: "run_ended", payload: { run_id: "r0", reason: "limit", usage: null } });
    const r1 = ev(4, {
      kind: "run_started",
      payload: { run_id: "r1", runner: "claude", instance_id: null, resume: "conversation", carried_messages: 1 },
    });
    const r1Said = ev(5, { kind: "assistant_message", payload: { text: "hned" } });
    const r1Ended = ev(6, { kind: "turn_ended", payload: { run_id: "r1" } });
    assert.equal(turnInFlight([r0, refused, r0End, r1], "r1"), true);
    assert.equal(workingPhase([r0, refused, r0End, r1], "r1", null), "thinking");
    assert.equal(turnInFlight([r0, refused, r0End, r1, r1Said], "r1"), true);
    assert.equal(turnInFlight([r0, refused, r0End, r1, r1Said, r1Ended], "r1"), false);
  });
  it("workingPhase shows nothing once the turn ended", () => {
    assert.equal(workingPhase([started, said, ended], "r1", null), null);
    assert.equal(workingPhase([started, said, ended, asked], "r1", null), "thinking");
  });

  // #490: a message written while the agent works queues behind the turn in
  // flight. The turn_ended that lands next ends the FIRST message's turn,
  // not the second's -- the chat keeps showing work and the Stop button
  // until every message sent has been answered.
  it("a message queued mid-turn keeps the turn in flight past the first turn_ended", () => {
    const second = ev(5, { kind: "user_message", payload: { text: "ještě", source: "chat" } });
    const endedAgain = ev(6, { kind: "turn_ended", payload: { run_id: "r1" } });
    assert.equal(turnInFlight([started, asked, second], "r1"), true);
    assert.equal(turnInFlight([started, asked, second, ended], "r1"), true);
    assert.equal(turnInFlight([started, asked, second, ended, endedAgain], "r1"), false);
  });

  it("the working row stays up while the queued message waits", () => {
    const second = ev(5, { kind: "user_message", payload: { text: "ještě", source: "chat" } });
    assert.equal(workingPhase([started, asked, second, ended], "r1", null), "thinking");
  });

  // One turn can answer both messages (the runner folds a send that lands
  // mid-turn into the running turn): the turn_ended says how many it took.
  it("a turn_ended that answered both messages ends the turn at once", () => {
    const second = ev(5, { kind: "user_message", payload: { text: "ještě", source: "chat" } });
    const endedBoth = ev(6, { kind: "turn_ended", payload: { run_id: "r1", consumed_messages: 2 } });
    assert.equal(turnInFlight([started, asked, second, endedBoth], "r1"), false);
  });

  // Nothing before the live run's start belongs to it: a message answered
  // by the previous run never keeps this one working.
  it("counts only what happened after the live run started", () => {
    const olderMessage = ev(0, { kind: "user_message", payload: { text: "staré", source: "chat" } });
    assert.equal(turnInFlight([olderMessage, started], "r1"), false);
    assert.equal(turnInFlight([olderMessage, started, asked], "r1"), true);
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

describe("input questions (#492)", () => {
  const env = { question: "Which environment?", options: ["staging", "production"], multi_select: false };
  const dry = { question: "Dry run first?", options: ["yes", "no"], multi_select: false };
  const base = { request_id: "q", type: "input" as const, tool: "AskUserQuestion", title: "t", decision: null };

  it("askPrompts reads questions, and falls back to the flat detail/options of an older row", () => {
    assert.deepEqual(askPrompts({ ...base, detail: "x", options: null, questions: [env, dry] }), [env, dry]);
    assert.deepEqual(askPrompts({ ...base, detail: "Which environment?", options: ["staging", "production"] }), [env]);
    assert.deepEqual(askPrompts({ ...base, detail: "Free text?", options: null }), []);
  });

  it("Enter in an empty field sends nothing", () => {
    assert.equal(askAnswer([], {}, ""), null);
    assert.equal(askAnswer([], {}, "   "), null);
    assert.equal(askAnswer([env], {}, ""), null);
    assert.equal(askAnswer([env, dry], {}, " "), null);
    assert.equal(askAnswer([env], {}, " moje "), "moje");
  });

  it("one single-choice question answers on the click; several wait for every pick", () => {
    const one = togglePick({}, env, "production");
    assert.equal(picksComplete([env], one), true);
    assert.equal(askAnswer([env], one, ""), "production");

    const first = togglePick({}, env, "staging");
    assert.equal(picksComplete([env, dry], first), false);
    const both = togglePick(first, dry, "no");
    assert.equal(picksComplete([env, dry], both), true);
    assert.deepEqual(askAnswer([env, dry], both, ""), { "Which environment?": "staging", "Dry run first?": "no" });
  });

  it("typed text fills the questions left without a pick; a multi-select joins its picks", () => {
    const multi = { question: "Which features?", options: ["a", "b", "c"], multi_select: true };
    let picks = togglePick({}, multi, "a");
    picks = togglePick(picks, multi, "c");
    picks = togglePick(picks, multi, "a");
    picks = togglePick(picks, multi, "b");
    assert.equal(picksComplete([multi], picks), false, "a multi-select is finished with Odeslat");
    assert.deepEqual(askAnswer([multi, dry], picks, "nevím"), { "Which features?": "c, b", "Dry run first?": "nevím" });
  });

  it("a single multi-select question keeps its picks when a note is typed too", () => {
    const multi = { question: "Which features?", options: ["a", "b", "c"], multi_select: true };
    let picks = togglePick({}, multi, "a");
    picks = togglePick(picks, multi, "c");
    assert.equal(askAnswer([multi], picks, "a ještě d"), "a, c, a ještě d");
    assert.equal(askAnswer([multi], picks, ""), "a, c");
    assert.equal(askAnswer([multi], {}, "jen text"), "jen text");
  });

  it("a second submit of the same question is dropped; a failed one can be retried", () => {
    const gate = createAnswerGate();
    assert.equal(gate.claim("q1"), true);
    assert.equal(gate.claim("q1"), false);
    gate.release("q1");
    assert.equal(gate.claim("q1"), true);
    assert.equal(gate.claim("q2"), true);
  });
});
