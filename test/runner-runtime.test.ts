// Session runtime (apps/server/domain/runner/session-runtime.ts): the only
// writer of runs and events. Fake adapter + DbSessionStore on a temp
// libsql :memory: DB, the pattern from test/api-sessions.test.ts for DB
// setup (via test/helpers/shared-db.ts's makeSharedDb).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { createSessionRuntime, resolveModelAndEffort } from "../apps/server/domain/runner/session-runtime.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { createInstance, setOrgDefault } from "../apps/server/domain/runner/instances.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import type { RunnerAdapter, RunHandle, RunStart } from "../apps/server/domain/runner/types.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";

afterEach(() => {
  setDbForTesting(null);
});

// getSessionScope/getMirrorPath/writeHandoffAndSuspend all reach through
// the global getDb() singleton (like the rest of the domain layer), not
// through a db this test constructs directly -- route it at the same
// :memory: client makeSharedDb() just built.
async function sharedDb(): Promise<SharedDb> {
  const shared = await makeSharedDb();
  setDbForTesting(shared.db);
  return shared;
}

function stubProvision(overrides: Partial<ProvisionRunResult> = {}) {
  return async (input: { nodeId: string }): Promise<ProvisionRunResult> => ({
    cwd: "/tmp/mirror",
    orientation: "orientation text",
    mcp: { url: "http://localhost:4011/mcp", token: "tok", homeNodeId: input.nodeId },
    portuniRoot: "/tmp",
    mirrors: ["/tmp/mirror"],
    ...overrides,
  });
}

function registryOf(adapter: RunnerAdapter) {
  return { getAdapter: (id: string) => (id === adapter.id ? adapter : null) };
}

describe("session runtime: startTask", () => {
  it("persists run_started, then the brief as user_message, with monotonic seq", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run } = await runtime.startTask({
      userId: "U1",
      nodeId,
      brief: "Fix the bug",
      runner: "fake",
      policy: "default",
    });

    const events = await store.listEvents(session.id);
    assert.deepEqual(
      events.map((e) => [e.seq, e.kind]),
      [
        [1, "run_started"],
        [2, "user_message"],
        [3, "run_ended"], // the fake's empty script auto-completes
        // #378: nobody closed this run explicitly, so it falls through to
        // the auto-summary/suspend path and gets its handoff event too.
        [4, "handoff"],
      ],
    );
    assert.equal(JSON.parse(events[0].payload).run_id, run.id);
    assert.deepEqual(JSON.parse(events[1].payload), { text: "Fix the bug", source: "chat" });
    assert.equal(events.every((e) => e.run_id === run.id), true);
  });

  it("throws for an unregistered runner", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const runtime = createSessionRuntime({
      store,
      registry: { getAdapter: () => null },
      provision: stubProvision(),
    });
    await assert.rejects(() =>
      runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "nonexistent" }),
    );
  });
});

describe("session runtime: question / answer", () => {
  it("a scripted question sets waiting_since; answer clears it and records the decision", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [
      {
        kind: "question",
        payload: {
          request_id: "req-1",
          type: "approval",
          tool: "mcp__portuni__portuni_expand_scope",
          title: "Rozšířit rozsah?",
          detail: "detail",
          options: null,
          decision: null,
        },
      },
      { wait: "answer" },
      { kind: "assistant_message", payload: { text: "done" } },
    ];
    const adapter = new FakeRunnerAdapter({ script });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    let row = await store.getSession(session.id);
    assert.ok(row?.waiting_since, "waiting_since must be set once the question opens");

    const decision = { by: "U1", value: true, at: new Date().toISOString() };
    await runtime.answer(session.id, "req-1", decision);

    row = await store.getSession(session.id);
    assert.equal(row?.waiting_since, null, "waiting_since must be cleared after answer()");

    const events = await store.listEvents(session.id);
    const questionEvents = events.filter((e) => e.kind === "question");
    assert.equal(questionEvents.length, 2, "the question is re-appended with the decision filled in");
    const answered = JSON.parse(questionEvents[1].payload);
    assert.deepEqual(answered.decision, decision);
    assert.equal(answered.request_id, "req-1");

    const stateChanged = events.filter((e) => e.kind === "state_changed").map((e) => JSON.parse(e.payload));
    assert.deepEqual(
      stateChanged.map((s) => s.waiting),
      [true, false],
    );
  });
});

describe("session runtime: interrupt (#378)", () => {
  it("leaves the run live -- a message right after is accepted as an ordinary one", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [{ wait: "message" }];
    const adapter = new FakeRunnerAdapter({ script });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.interrupt(session.id);

    // The run is still live: no run_ended, and the session is still running.
    const runs = await store.listRuns(session.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, run.id);
    assert.equal(runs[0].ended_at, null);
    const row = await store.getSession(session.id);
    assert.equal(row?.state, "running");

    // A message right after interrupt() is accepted as an ordinary one --
    // it does NOT throw "has no live run".
    await runtime.sendMessage(session.id, "still here?");
    const events = await store.listEvents(session.id);
    assert.ok(events.some((e) => e.kind === "user_message" && JSON.parse(e.payload).text === "still here?"));
  });
});

describe("session runtime: auto-summary on a non-close run end (#378)", () => {
  it("a run that ends on its own (nobody closed it) writes a summary and suspends the session", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    // An empty script auto-completes right away -- nobody called close(),
    // so this is exactly "a run ended other than by Uzavřít".
    const adapter = new FakeRunnerAdapter({ script: [] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "suspended");
    assert.ok(row?.handoff_inline, "a summary must exist after a non-close run end");
    assert.match(row!.handoff_inline!, /Poslední zprávy/);
    assert.match(row!.handoff_inline!, /Fix the bug|x/); // the brief shows up as the first message

    const runs = await store.listRuns(session.id);
    // The adapter itself reports "completed" (a graceful close it can't
    // explain); withSuspendReason rewrites it since this wasn't an
    // explicit close.
    assert.equal(runs[0].end_reason, "suspended");

    const events = await store.listEvents(session.id);
    const handoffEvent = events.find((e) => e.kind === "handoff");
    assert.ok(handoffEvent, "a handoff/summary event must be appended");
  });

  it("checkIdleRunsOnce ends a run idle for longer than idleMs, tagged 'idle'", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    // Not idle yet (well within the cutoff).
    await runtime.checkIdleRunsOnce(60_000, Date.now());
    assert.equal((await store.getSession(session.id))?.state, "running");

    // Now simulate the cutoff having passed.
    await runtime.checkIdleRunsOnce(60_000, Date.now() + 61_000);

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "suspended");
    assert.ok(row?.handoff_inline);
    const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");
    assert.equal(parseServerHandoffReason(row!.handoff_inline), "idle");
  });

  it("checkIdleRunsOnce is a no-op when nothing is live", async () => {
    const { db } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });
    await runtime.checkIdleRunsOnce(1); // must not throw
  });
});

// checkConversationResumable (domain/session-handoff.ts) is cli === "claude"
// only, and reads the real OS home directory when no configDir override is
// given -- resumeByWriting doesn't thread one through, so "still resumable"
// is not safely fabricatable at this level without touching the real
// filesystem HOME. That branch is covered by session-handoff.test.ts's own
// checkConversationResumable suite; here, the fake adapter's session never
// has cli: "claude" set, so every one of these exercises the (also
// real-world-common) "falls back to the summary" path.
describe("session runtime: resume by writing (#378)", () => {
  it("sending into a suspended thread starts a new, linked run from the summary", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [{ wait: "message" }];
    const adapter = new FakeRunnerAdapter({ script, agentSessionId: "claude-conv-1" });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run: firstRun } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1); // ends the run -> suspended, summary written
    assert.equal((await store.getSession(session.id))?.state, "suspended");

    await runtime.sendMessage(session.id, "keep going");

    const runs = await store.listRuns(session.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].resumed_from_run_id, firstRun.id);
    // No conversation-resume in this environment (see the block comment
    // above) -- a fresh run from the summary, not --resume.
    assert.equal(runs[1].agent_session_id, null);

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "running");

    const events = await store.listEvents(session.id);
    const secondRunStarted = events.find((e) => e.run_id === runs[1].id && e.kind === "run_started");
    assert.ok(secondRunStarted);
    assert.equal(JSON.parse(secondRunStarted!.payload).resume, "handoff");
    assert.ok(
      events.some((e) => e.run_id === runs[1].id && e.kind === "user_message" && JSON.parse(e.payload).text === "keep going"),
    );
  });

  it("the new run's orientation carries the previous summary", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);

    // First run: a real FakeRunnerAdapter so startTask/checkIdleRunsOnce
    // can drive it through a normal suspend with a summary written.
    const firstAdapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const registry = { getAdapter: (id: string) => (id === "fake" ? firstAdapter : null) };
    const runtime = createSessionRuntime({ store, registry, provision: stubProvision() });
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1);
    const suspended = await store.getSession(session.id);
    assert.ok(suspended?.handoff_inline);

    // Swap in a capturing adapter for the resume run so the RunStart it
    // actually receives is observable.
    let capturedOrientation: string | undefined;
    registry.getAdapter = (id: string) =>
      id === "fake"
        ? {
            id: "fake",
            async detect() {
              return { installed: true, version: null, logged_in: true, instances_supported: false };
            },
            async start(run, sink) {
              capturedOrientation = run.orientation;
              sink({ kind: "run_ended", payload: { run_id: run.runId, reason: "completed", usage: null } });
              return {
                async send() {
                  // unused by this test
                },
                async answer() {
                  // unused by this test
                },
                async interrupt() {
                  // unused by this test
                },
                async close() {
                  // unused by this test
                },
                async setModel() {
                  // unused by this test
                },
                agentSessionId: () => null,
                pid: () => null,
              };
            },
          }
        : null;

    await runtime.sendMessage(session.id, "keep going");

    assert.ok(capturedOrientation);
    assert.match(capturedOrientation!, /Předání \(obnovení ze shrnutí\)/);
    assert.match(capturedOrientation!, /Poslední zprávy/); // the summary content itself
  });
});

describe("session runtime: event ordering", () => {
  it("records the answered question before anything the adapter emits in reaction to the answer", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [
      {
        kind: "question",
        payload: {
          request_id: "q1",
          type: "input",
          tool: "AskUserQuestion",
          title: "Otázka",
          detail: "Which one?",
          options: ["a", "b"],
          decision: null,
        },
      },
      { wait: "answer" },
      { kind: "assistant_message", payload: { text: "ok, a" } },
    ];
    const adapter = new FakeRunnerAdapter({ script });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.answer(session.id, "q1", { by: "U1", value: "a", at: new Date().toISOString() });

    const kinds = (await store.listEvents(session.id)).map((e) => {
      const payload = JSON.parse(e.payload);
      if (e.kind === "question") return payload.decision ? "question:answered" : "question";
      if (e.kind === "state_changed") return `state_changed:${payload.waiting}`;
      return e.kind;
    });
    const answered = kinds.indexOf("question:answered");
    const reaction = kinds.indexOf("assistant_message");
    assert.ok(answered !== -1 && reaction !== -1, kinds.join(","));
    assert.ok(answered < reaction, `answered question must precede the reaction: ${kinds.join(",")}`);
    assert.equal(kinds[answered + 1], "state_changed:false");

    // #378: the script has no trailing wait, so it auto-completes right
    // after the reaction -- nobody explicitly closed it, so this is the
    // same "run ended other than by Uzavřít" auto-suspend path.
    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].end_reason, "suspended");
    assert.equal((await store.getSession(session.id))?.state, "suspended");
  });

  it("hands the spawn id to the adapter as an MCP header", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    let seenHeaders: Record<string, string> | null = null;
    const inner = new FakeRunnerAdapter({ script: [] });
    const adapter: RunnerAdapter = {
      id: "fake",
      detect: () => inner.detect(),
      start: (run, sink) => {
        seenHeaders = run.mcp.headers;
        return inner.start(run, sink);
      },
    };
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    assert.deepEqual(seenHeaders, { "X-Portuni-Spawn-Id": session.id });
  });
});

describe("session runtime: close", () => {
  it("closeSession ends a live run via close() (not interrupt) and transitions the session to closed", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const closed = await runtime.closeSession(session.id);
    assert.equal(closed.state, "closed");

    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].id, run.id);
    // #378: closeSession goes through close(), and closingSessions keeps
    // handleAdapterEvent from rewriting/auto-summarizing this one -- the
    // adapter's own "completed" (a graceful close) stands.
    assert.equal(runs[0].end_reason, "completed");
    assert.ok(!(await store.getSession(session.id))?.handoff_inline, "Uzavřít does not write a summary");
  });

  it("continueSession closes this session (no summary written on it) and starts a new one, seeded", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session: oldSession } = await runtime.startTask({ userId: "U1", nodeId, brief: "the old task", runner: "fake" });
    const { session: newSession, run: newRun } = await runtime.continueSession(oldSession.id);

    const oldRow = await store.getSession(oldSession.id);
    assert.equal(oldRow?.state, "closed");
    assert.equal(oldRow?.handoff_inline, null, "continue does not write a summary onto the OLD session");

    assert.notEqual(newSession.id, oldSession.id);
    assert.equal(newSession.node_id, oldSession.node_id);
    assert.equal(newSession.runner, oldSession.runner);
    assert.equal(newSession.name, oldSession.name);
    assert.equal(newSession.state, "running");

    const newEvents = await store.listEvents(newSession.id);
    assert.ok(newEvents.some((e) => e.run_id === newRun.id && e.kind === "run_started"));
    assert.ok(!newEvents.some((e) => e.kind === "user_message"), "continue carries no brief of its own");
  });
});

describe("session runtime: subscribers vs. store", () => {
  it("subscribers receive delta frames, but the store never persists them", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [
      { type: "delta", run_id: "will-be-overwritten", channel: "text", text: "chunk-1" },
      { kind: "assistant_message", payload: { text: "final" } },
    ];
    const adapter = new FakeRunnerAdapter({ script });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const received: Array<{ kind?: string; type?: string }> = [];
    const unsubscribe = runtime.subscribe("*", (_sessionId, event) => {
      received.push(event as { kind?: string; type?: string });
    });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    unsubscribe();

    assert.ok(received.some((e) => e.type === "delta"));
    assert.ok(received.some((e) => e.kind === "assistant_message"));

    const events = await store.listEvents(session.id);
    assert.equal(
      events.some((e) => e.kind === ("delta" as unknown)),
      false,
    );
    // Every persisted event has a real canonical kind, never a delta frame.
    for (const e of events) {
      assert.notEqual(e.kind, "delta");
    }
  });
});

describe("session runtime: sessionSignals", () => {
  it("reports the write/read set sizes and a run age once a run is live", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const signals = await runtime.sessionSignals(session.id);
    assert.equal(typeof signals.runAgeMs, "number");
    assert.ok((signals.runAgeMs ?? -1) >= 0);
    assert.equal(signals.writeSetSize, 0);
    assert.equal(signals.readSetSize, 0);
    assert.equal(signals.expansionsSinceRunStart, 0);
  });

  it("reports null runAgeMs when there is no live run", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const signals = await runtime.sessionSignals(session.id);
    assert.equal(signals.runAgeMs, null);
  });
});

describe("resolveModelAndEffort", () => {
  it("prefers the session's own value over the instance's defaults", () => {
    const r = resolveModelAndEffort(
      { model: "claude-opus-4-8", effort: "high" },
      { model: "claude-sonnet-5", effort: "low" },
    );
    assert.deepEqual(r, { model: "claude-opus-4-8", effort: "high" });
  });

  it("falls back to the instance's defaults when the session has none", () => {
    const r = resolveModelAndEffort({ model: null, effort: null }, { model: "claude-sonnet-5", effort: "low" });
    assert.deepEqual(r, { model: "claude-sonnet-5", effort: "low" });
  });

  it("is null/null when neither the session nor the instance has anything", () => {
    assert.deepEqual(resolveModelAndEffort({ model: null, effort: null }, null), { model: null, effort: null });
    assert.deepEqual(resolveModelAndEffort({ model: null, effort: null }, {}), { model: null, effort: null });
  });

  it("resolves each field independently", () => {
    const r = resolveModelAndEffort({ model: "claude-opus-4-8", effort: null }, { model: "claude-sonnet-5", effort: "xhigh" });
    assert.deepEqual(r, { model: "claude-opus-4-8", effort: "xhigh" });
  });
});

// #375: end-to-end through startTask -- a bespoke adapter (not
// FakeRunnerAdapter, which never exposes the RunStart it received)
// captures what session-runtime.ts actually resolved onto RunStart.
function capturingAdapter() {
  let captured: RunStart | undefined;
  const handle: RunHandle = {
    async send() {
      /* unused by these tests */
    },
    async answer() {
      /* unused by these tests */
    },
    async interrupt() {
      /* unused by these tests */
    },
    async close() {
      /* unused by these tests */
    },
    async setModel() {
      /* unused by these tests */
    },
    agentSessionId: () => null,
    pid: () => null,
  };
  const adapter: RunnerAdapter = {
    id: "fake",
    async detect() {
      return { installed: true, version: null, logged_in: true, instances_supported: false };
    },
    async start(run, sink) {
      captured = run;
      sink({ kind: "run_ended", payload: { run_id: run.runId, reason: "completed", usage: null } });
      return handle;
    },
  };
  return { adapter, getRunStart: () => captured };
}

describe("session runtime: model/effort resolution end-to-end (startTask)", () => {
  let dataDir: string;
  const originalDataDir = process.env.PORTUNI_DATA_DIR;

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.PORTUNI_DATA_DIR;
    else process.env.PORTUNI_DATA_DIR = originalDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("resolves the instance's defaults onto RunStart when the task carries none of its own", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-model-effort-"));
    process.env.PORTUNI_DATA_DIR = dataDir;
    const instance = await createInstance({
      name: "Team account",
      runner: "fake",
      defaults: { model: "claude-sonnet-5", effort: "low" },
    });

    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const { adapter, getRunStart } = capturingAdapter();
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake", instanceId: instance.id });

    assert.equal(getRunStart()?.model, "claude-sonnet-5");
    assert.equal(getRunStart()?.effort, "low");
  });

  it("the task's own model/effort wins over the instance's defaults", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-model-effort-"));
    process.env.PORTUNI_DATA_DIR = dataDir;
    const instance = await createInstance({
      name: "Team account",
      runner: "fake",
      defaults: { model: "claude-sonnet-5", effort: "low" },
    });

    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const { adapter, getRunStart } = capturingAdapter();
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    await runtime.startTask({
      userId: "U1",
      nodeId,
      brief: "x",
      runner: "fake",
      instanceId: instance.id,
      model: "claude-opus-4-8",
      effort: "max",
    });

    assert.equal(getRunStart()?.model, "claude-opus-4-8");
    assert.equal(getRunStart()?.effort, "max");
  });

  it("is null/null with no instance and no task-level override", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-model-effort-"));
    process.env.PORTUNI_DATA_DIR = dataDir;

    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const { adapter, getRunStart } = capturingAdapter();
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    assert.equal(getRunStart()?.model, null);
    assert.equal(getRunStart()?.effort, null);
  });
});


// #407: promoting a draft resolves the node's organization and, with it,
// the organization's default runner instance -- in central mode through an
// injected resolver (CentralClient.nodeOrganizationId), since there is no
// graph db on the device to read the belongs_to edge from.
describe("session runtime: organization default instance on draft promotion", () => {
  let dataDir: string;
  const originalDataDir = process.env.PORTUNI_DATA_DIR;

  afterEach(async () => {
    clearRegistryForTests();
    if (originalDataDir === undefined) delete process.env.PORTUNI_DATA_DIR;
    else process.env.PORTUNI_DATA_DIR = originalDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  // Two instances for the same runner, the second one the org default --
  // "the runner's own default" (no instance at all) must be visibly wrong.
  async function twoInstances(orgId: string): Promise<{ other: string; orgDefault: string }> {
    dataDir = await mkdtemp(join(tmpdir(), "portuni-org-default-"));
    process.env.PORTUNI_DATA_DIR = dataDir;
    const other = await createInstance({ name: "Osobní", runner: "fake" });
    const orgDefault = await createInstance({ name: "Tempo", runner: "fake" });
    await setOrgDefault(orgId, orgDefault.id);
    return { other: other.id, orgDefault: orgDefault.id };
  }

  async function promote(
    deps: { store: DbSessionStore; nodeId: string; resolveNodeOrgId?: (nodeId: string) => Promise<string | null> },
  ): Promise<string | null> {
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    registerAdapter(adapter);
    const runtime = createSessionRuntime({
      store: deps.store,
      registry: registryOf(adapter),
      provision: stubProvision(),
      resolveNodeOrgId: deps.resolveNodeOrgId,
    });
    const draft = await runtime.createDraft({ userId: "U1", nodeId: deps.nodeId });
    await runtime.sendMessage(draft.id, "Udělej to");
    const row = await deps.store.getSession(draft.id);
    return row?.instance_id ?? null;
  }

  it("picks the organization's default instance from the local graph db", async () => {
    const { db, nodeId, orgId } = await sharedDb();
    const { orgDefault } = await twoInstances(orgId);
    const instanceId = await promote({ store: new DbSessionStore(db), nodeId });
    assert.equal(instanceId, orgDefault);
  });

  it("picks it from an injected (central-mode) resolver too", async () => {
    const { db, nodeId, orgId } = await sharedDb();
    const { orgDefault } = await twoInstances(orgId);
    const instanceId = await promote({
      store: new DbSessionStore(db),
      nodeId,
      resolveNodeOrgId: async () => orgId,
    });
    assert.equal(instanceId, orgDefault);
  });

  it("leaves the instance unset for a node with no organization", async () => {
    const { db, nodeId, orgId } = await sharedDb();
    await twoInstances(orgId);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      const instanceId = await promote({
        store: new DbSessionStore(db),
        nodeId,
        resolveNodeOrgId: async () => null,
      });
      assert.equal(instanceId, null);
    } finally {
      console.warn = originalWarn;
    }
    // A node that genuinely has no organization is not a fallback worth
    // logging about.
    assert.deepEqual(warnings, []);
  });

  it("degrades to no instance and warns once when the resolver fails", async () => {
    const { db, nodeId, orgId } = await sharedDb();
    await twoInstances(orgId);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    let instanceId: string | null = "unset";
    try {
      instanceId = await promote({
        store: new DbSessionStore(db),
        nodeId,
        resolveNodeOrgId: async () => {
          throw new Error("central unreachable");
        },
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(instanceId, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /central unreachable/);
    assert.match(warnings[0], new RegExp(nodeId));
  });
});
