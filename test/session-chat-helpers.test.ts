import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toCanonicalEvent,
  sessionStatusChip,
  insertBySeq,
  latestQuestionEvent,
  appendDelta,
  clearDeltaBuffer,
  collapseToolCalls,
  formatRestartHint,
  deriveTranscriptRows,
  activitySummary,
  workingPhase,
  createDeltaCoalescer,
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

describe("formatRestartHint", () => {
  it("returns null when there is no live run", () => {
    assert.equal(formatRestartHint({ runAgeMs: null, writeSetSize: 0, readSetSize: 0, expansionsSinceRunStart: 0 }), null);
  });

  it("formats age/write/read counts, omitting the growth clause when nothing expanded", () => {
    const text = formatRestartHint({ runAgeMs: 5 * 60_000, writeSetSize: 2, readSetSize: 10, expansionsSinceRunStart: 0 });
    assert.equal(text, "Běží 5 min · zápis 2 · čtení 10");
  });

  it("includes the growth clause when the read set has grown since the run started", () => {
    const text = formatRestartHint({ runAgeMs: 90_000, writeSetSize: 1, readSetSize: 8, expansionsSinceRunStart: 3 });
    assert.equal(text, "Běží 2 min · zápis 1 · čtení 8 (+3 od startu běhu)");
  });

  it("rounds a sub-minute run age to 'méně než minutu'", () => {
    const text = formatRestartHint({ runAgeMs: 10_000, writeSetSize: 0, readSetSize: 0, expansionsSinceRunStart: 0 });
    assert.equal(text, "Běží méně než minutu · zápis 0 · čtení 0");
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

  it("builds the sentence from verb counts", () => {
    const r = activitySummary(
      items([["Read", "completed"], ["Grep", "completed"], ["Glob", "completed"], ["Edit", "completed"], ["Bash", "completed"], ["Bash", "completed"]]),
      12,
    );
    assert.equal(r.text, "Přečteno 3 soubory · upraveno 1 · 2 příkazy · uvažoval 12 s");
    assert.equal(r.failed, 0);
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
    assert.equal(activitySummary([{ kind: "reasoning", seq: 1, summary: "x" }]).text, "Uvažoval");
  });
});

describe("workingPhase", () => {
  it("is null with no live run and no message in flight", () => {
    assert.equal(workingPhase([], null, null), null);
  });
  it("starting between send and run_started, thinking after it, continuing after a tool completes", () => {
    assert.equal(workingPhase([], null, Date.now()), "starting");
    assert.equal(workingPhase([runStarted(1)], "R1", null), "thinking");
    assert.equal(workingPhase([runStarted(1), toolEv(2, "t1", "Read", "completed")], "R1", null), "continuing");
    assert.equal(workingPhase([runStarted(1), ev(2, "assistant_message", { text: "a" })], "R1", null), "continuing");
    // A running tool has its own live row; the working row steps aside.
    assert.equal(workingPhase([runStarted(1), toolEv(2, "t1", "Read", "started")], "R1", null), null);
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
