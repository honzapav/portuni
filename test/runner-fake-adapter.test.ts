// FakeRunnerAdapter (apps/server/domain/runner/adapters/fake.ts): the
// scripted adapter every other runner-batch test (runtime, REST, live
// channel) drives instead of a real CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import type { CanonicalEvent, DeltaFrame, RunStart } from "../apps/server/domain/runner/types.js";

function noopSink(): void {
  /* these tests only care about the returned RunHandle, not emitted events */
}

function run(overrides: Partial<RunStart> = {}): RunStart {
  return {
    sessionId: "S1",
    runId: "R1",
    cwd: "/mirror",
    brief: "do the thing",
    resume: null,
    orientation: "",
    instance: { id: null, env: {} },
    mcp: { url: "http://localhost:1", token: "t", homeNodeId: "N1" },
    policy: "default",
    ...overrides,
  };
}

const userMsg: CanonicalEvent = { kind: "user_message", payload: { text: "hi", source: "chat" } };
const assistantMsg: CanonicalEvent = { kind: "assistant_message", payload: { text: "hello" } };
const delta: DeltaFrame = { type: "delta", run_id: "R1", channel: "text", text: "chunk" };

describe("FakeRunnerAdapter", () => {
  it("detect reports installed and logged in by default", async () => {
    const adapter = new FakeRunnerAdapter({ script: [] });
    const availability = await adapter.detect();
    assert.equal(availability.installed, true);
    assert.equal(availability.logged_in, true);
  });

  it("agentSessionId returns the value given at construction, or null by default", async () => {
    const withId = new FakeRunnerAdapter({ script: [], agentSessionId: "claude-conv-1" });
    const handleWithId = await withId.start(run(), noopSink);
    assert.equal(handleWithId.agentSessionId(), "claude-conv-1");

    const withoutId = new FakeRunnerAdapter({ script: [] });
    const handleWithoutId = await withoutId.start(run(), noopSink);
    assert.equal(handleWithoutId.agentSessionId(), null);
  });

  it("replays a wait-free script in order, then appends run_ended completed", async () => {
    const script: FakeScriptStep[] = [userMsg, delta, assistantMsg];
    const adapter = new FakeRunnerAdapter({ script });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    await adapter.start(run(), (e) => events.push(e));

    assert.deepEqual(events, [
      userMsg,
      delta,
      assistantMsg,
      { kind: "run_ended", payload: { run_id: "R1", reason: "completed", usage: null } },
    ]);
  });

  it("pauses at a wait:'message' step until send() is called", async () => {
    const script: FakeScriptStep[] = [userMsg, { wait: "message" }, assistantMsg];
    const adapter = new FakeRunnerAdapter({ script });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(run(), (e) => events.push(e));

    assert.deepEqual(events, [userMsg]);

    await handle.send("continue");

    assert.deepEqual(events, [
      userMsg,
      assistantMsg,
      { kind: "run_ended", payload: { run_id: "R1", reason: "completed", usage: null } },
    ]);
  });

  it("pauses at a wait:'answer' step until answer() is called", async () => {
    const script: FakeScriptStep[] = [{ wait: "answer" }, assistantMsg];
    const adapter = new FakeRunnerAdapter({ script });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(run(), (e) => events.push(e));

    assert.deepEqual(events, []);
    // send() must not resolve an 'answer' wait -- only answer() does.
    await handle.send("not the right kind of resume");
    assert.deepEqual(events, []);

    await handle.answer("req-1", { by: "U1", value: true, at: new Date().toISOString() });
    assert.deepEqual(events, [
      assistantMsg,
      { kind: "run_ended", payload: { run_id: "R1", reason: "completed", usage: null } },
    ]);
  });

  it("interrupt mid-script stops further steps and emits run_ended interrupted", async () => {
    const script: FakeScriptStep[] = [userMsg, { wait: "message" }, assistantMsg];
    const adapter = new FakeRunnerAdapter({ script });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(run(), (e) => events.push(e));

    assert.deepEqual(events, [userMsg]);

    await handle.interrupt();

    assert.deepEqual(events, [
      userMsg,
      { kind: "run_ended", payload: { run_id: "R1", reason: "interrupted", usage: null } },
    ]);

    // A resume attempt after interrupt is a no-op -- the script is over.
    await handle.send("too late");
    assert.deepEqual(events, [
      userMsg,
      { kind: "run_ended", payload: { run_id: "R1", reason: "interrupted", usage: null } },
    ]);
  });

  it("close() ends the run with completed unless it already ended", async () => {
    const script: FakeScriptStep[] = [{ wait: "message" }];
    const adapter = new FakeRunnerAdapter({ script });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(run(), (e) => events.push(e));

    await handle.close();
    assert.deepEqual(events, [{ kind: "run_ended", payload: { run_id: "R1", reason: "completed", usage: null } }]);

    // Idempotent: closing again (or interrupting) after the run already
    // ended must not append a second run_ended.
    await handle.close();
    await handle.interrupt();
    assert.equal(events.length, 1);
  });

  it("a script that runs to completion on its own is not double-ended by close()", async () => {
    const adapter = new FakeRunnerAdapter({ script: [userMsg] });
    const events: (CanonicalEvent | DeltaFrame)[] = [];
    const handle = await adapter.start(run(), (e) => events.push(e));

    assert.deepEqual(events, [
      userMsg,
      { kind: "run_ended", payload: { run_id: "R1", reason: "completed", usage: null } },
    ]);

    await handle.close();
    assert.equal(events.length, 2);
  });
});
