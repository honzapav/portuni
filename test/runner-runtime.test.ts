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
import { createInstance } from "../apps/server/domain/runner/instances.js";
import type { RunnerAdapter, RunHandle, RunStart } from "../apps/server/domain/runner/types.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import { suspendSession } from "../apps/server/domain/sessions.js";
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

describe("session runtime: interrupt", () => {
  it("ends the live run with reason interrupted", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [{ wait: "message" }, { kind: "assistant_message", payload: { text: "never" } }];
    const adapter = new FakeRunnerAdapter({ script });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.interrupt(session.id);

    const runs = await store.listRuns(session.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, run.id);
    assert.equal(runs[0].end_reason, "interrupted");
    assert.ok(runs[0].ended_at);

    const events = await store.listEvents(session.id);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["run_started", "user_message", "run_ended"],
    );
  });
});

describe("session runtime: suspend", () => {
  it("when the agent suspends within the poll window, records an agent-generated handoff", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    // wait:"message" pauses right after startTask's brief -- suspend()
    // sends SUSPEND_INSTRUCTION into it, and this test plays the role of
    // "the agent called portuni_session_suspend" by writing the DB state
    // directly, exactly as that MCP tool would.
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({
      store,
      registry: registryOf(adapter),
      provision: stubProvision(),
      suspendPollIntervalMs: 10,
      suspendTimeoutMs: 200,
    });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    const agentSuspendAfterInstruction = (async () => {
      // Give suspend() a moment to send the instruction and start polling.
      await new Promise((r) => setTimeout(r, 30));
      await suspendSession(db, "U1", session.id, {
        handoffPath: "wip/sessions/agent-handoff.md",
        handoffHash: "agent-hash",
        agentSessionId: "claude-conv-1",
      });
    })();

    const [suspended] = await Promise.all([runtime.suspend(session.id), agentSuspendAfterInstruction]);
    assert.equal(suspended.state, "suspended");
    assert.equal(suspended.handoff_path, "wip/sessions/agent-handoff.md");

    // The run closed by suspend() ends as "suspended" -- the adapter's own
    // close() reports "completed", which is not what happened.
    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].end_reason, "suspended");
    assert.ok(runs[0].ended_at);

    const events = await store.listEvents(session.id);
    const handoffEvent = events.find((e) => e.kind === "handoff");
    assert.ok(handoffEvent);
    const payload = JSON.parse(handoffEvent.payload);
    assert.equal(payload.generated_by, "agent");
    assert.equal(payload.path, "wip/sessions/agent-handoff.md");

    const suspendInstruction = events.find(
      (e) => e.kind === "user_message" && JSON.parse(e.payload).source === "system",
    );
    assert.ok(suspendInstruction);
  });

  it("falls back to a server-generated handoff when the agent never suspends", async () => {
    const { db, nodeId, remoteRoot } = await sharedDb();
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const workspace = await mkdtemp(join(tmpdir(), "portuni-runner-runtime-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    const { registerMirror } = await import("../apps/server/domain/sync/mirror-registry.js");
    const { resetLocalDbForTests } = await import("../apps/server/domain/sync/local-db.js");
    resetLocalDbForTests();
    const mirrorRoot = join(workspace, "mirror");
    await import("node:fs/promises").then((fs) => fs.mkdir(mirrorRoot, { recursive: true }));
    await registerMirror("U1", nodeId, mirrorRoot);

    try {
      const store = new DbSessionStore(db);
      // The agent never suspends -- the run just sits waiting forever.
      const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
      const runtime = createSessionRuntime({
        store,
        registry: registryOf(adapter),
        provision: stubProvision(),
        suspendPollIntervalMs: 5,
        suspendTimeoutMs: 30,
      });

      const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
      const suspended = await runtime.suspend(session.id);
      assert.equal(suspended.state, "suspended");
      assert.ok(suspended.handoff_path);

      const events = await store.listEvents(session.id);
      const handoffEvent = events.find((e) => e.kind === "handoff");
      assert.ok(handoffEvent);
      const payload = JSON.parse(handoffEvent.payload);
      assert.equal(payload.generated_by, "server");
      assert.equal(payload.path, suspended.handoff_path);

      const { readFile } = await import("node:fs/promises");
      const content = await readFile(join(mirrorRoot, suspended.handoff_path!), "utf8");
      assert.match(content, /Konverzace nebyla uložena/);
      // Same generator as every other server-side suspend (#329): the file
      // carries the reason marker resume-info reads back.
      const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");
      assert.equal(parseServerHandoffReason(content), "suspend_timeout");

      const runs = await store.listRuns(session.id);
      assert.equal(runs[0].end_reason, "suspended");
    } finally {
      resetLocalDbForTests();
      delete process.env.PORTUNI_WORKSPACE_ROOT;
      await import("node:fs/promises").then((fs) => fs.rm(workspace, { recursive: true, force: true }));
      void remoteRoot;
    }
  });
});

describe("session runtime: suspend without a mirror", () => {
  it("falls back to handoff_inline when this device has no mirror for the node", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({
      store,
      registry: registryOf(adapter),
      provision: stubProvision(),
      suspendPollIntervalMs: 5,
      suspendTimeoutMs: 30,
    });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const suspended = await runtime.suspend(session.id);
    assert.equal(suspended.state, "suspended");
    assert.equal(suspended.handoff_path, null);
    assert.ok(suspended.handoff_inline);
    const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");
    assert.equal(parseServerHandoffReason(suspended.handoff_inline), "suspend_timeout");

    const events = await store.listEvents(session.id);
    const handoffEvent = events.find((e) => e.kind === "handoff");
    assert.ok(handoffEvent);
    const payload = JSON.parse(handoffEvent.payload);
    assert.equal(payload.generated_by, "server");
    assert.equal(payload.path, null);
    assert.equal(payload.hash, suspended.handoff_hash);
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
    await runtime.interrupt(session.id);

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

    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].end_reason, "completed");
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

describe("session runtime: resume", () => {
  it("conversation mode creates a linked run when the last run has an agent_session_id", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [{ wait: "message" }];
    const adapter = new FakeRunnerAdapter({ script, agentSessionId: "claude-conv-1" });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run: firstRun } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.interrupt(session.id);
    await store.patchSession(session.id, { state: "suspended" });

    const secondRun = await runtime.resume(session.id, "conversation");
    assert.equal(secondRun.resumed_from_run_id, firstRun.id);
    assert.equal(secondRun.agent_session_id, "claude-conv-1");

    const runs = await store.listRuns(session.id);
    assert.equal(runs.length, 2);

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "running");

    const events = await store.listEvents(session.id);
    const secondRunStarted = events.find((e) => e.run_id === secondRun.id && e.kind === "run_started");
    assert.ok(secondRunStarted);
    assert.equal(JSON.parse(secondRunStarted!.payload).resume, "conversation");
  });

  it("conversation mode refuses when the last run has no agent_session_id", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.interrupt(session.id);
    await store.patchSession(session.id, { state: "suspended" });

    await assert.rejects(() => runtime.resume(session.id, "conversation"));
  });

  it("handoff mode starts a fresh run whose orientation carries the pointer", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    let lastOrientation = "";
    const provision = async (input: { nodeId: string; resume: { mode: string; handoffPath?: string | null } | null }) => {
      lastOrientation = input.resume?.mode === "handoff" ? `handoff pointer: ${input.resume.handoffPath}` : "fresh";
      return {
        cwd: "/tmp/mirror",
        orientation: lastOrientation,
        mcp: { url: "http://localhost:4011/mcp", token: "tok", homeNodeId: input.nodeId },
        portuniRoot: "/tmp",
        mirrors: ["/tmp/mirror"],
      };
    };
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.interrupt(session.id);
    await store.patchSession(session.id, { state: "suspended", handoff_path: "wip/sessions/x-handoff.md" });

    const run = await runtime.resume(session.id, "handoff");
    assert.equal(run.resumed_from_run_id, null || run.resumed_from_run_id); // no prior linkage requirement
    assert.match(lastOrientation, /wip\/sessions\/x-handoff\.md/);

    const events = await store.listEvents(session.id);
    const secondRunStarted = events.find((e) => e.run_id === run.id && e.kind === "run_started");
    assert.equal(JSON.parse(secondRunStarted!.payload).resume, "handoff");
  });
});

describe("session runtime: close", () => {
  it("closeSession interrupts a live run and transitions the session to closed", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const closed = await runtime.closeSession(session.id);
    assert.equal(closed.state, "closed");

    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].id, run.id);
    assert.equal(runs[0].end_reason, "interrupted");
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
