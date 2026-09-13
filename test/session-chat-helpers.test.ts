import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toCanonicalEvent,
  sessionStatusChip,
  latestQuestionEvent,
  appendDelta,
  clearDeltaBuffer,
  collapseToolCalls,
  formatRestartHint,
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
