// Session runtime lifecycle (apps/server/domain/runner/session-runtime.ts):
// one start per thread (#488), the turn count (#490), messages into a run
// that is ending (#489), the idle sweep's re-check (#491) and a run that
// cannot be provisioned (#507). Split from runner-runtime.test.ts so each
// file stays inside the per-file test timeout on the slower PGlite driver.
// Same setup: fake adapters + DbSessionStore on a shared in-memory db.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getDb, setDbForTesting } from "../apps/server/infra/db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { createSessionRuntime } from "../apps/server/domain/runner/session-runtime.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import type { CanonicalEvent, RunnerAdapter } from "../apps/server/domain/runner/types.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { createSuspendServerSide, localSuspendDeps } from "../apps/server/domain/session-handoff.js";
import { RunnerMcpTokenMissingError } from "../apps/server/domain/write-scope.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";
import { GatedAdapter } from "./helpers/gated-adapter.js";
import { TeardownAdapter } from "./helpers/teardown-adapter.js";

afterEach(() => {
  setDbForTesting(null);
  clearTestContentDb();
});

let content: SessionContentStore;

async function sharedDb(): Promise<SharedDb> {
  const shared = await makeSharedDb();
  setDbForTesting(shared.db);
  content = (await installTestContentDb()).content;
  return shared;
}

function stubProvision() {
  return async (input: { nodeId: string }): Promise<ProvisionRunResult> => ({
    cwd: "/tmp/mirror",
    orientation: "orientation text",
    mcp: { url: "http://localhost:4011/mcp", token: "tok", homeNodeId: input.nodeId },
    portuniRoot: "/tmp",
    mirrors: ["/tmp/mirror"],
  });
}

function registryOf(adapter: RunnerAdapter) {
  return { getAdapter: (id: string) => (id === adapter.id ? adapter : null) };
}

// The first turn is over and the run waits for the next message.
const TURN_DONE: FakeScriptStep = { kind: "turn_ended", payload: { run_id: "fake" } };

// #507: a run that cannot be provisioned (no front-door token) is refused
// before anything is created -- no record, no first message, no closed
// source thread.
describe("session runtime: a run that cannot be provisioned", () => {
  const refusingProvision = async (): Promise<ProvisionRunResult> => {
    throw new RunnerMcpTokenMissingError();
  };

  async function sessionCount(db: SharedDb["db"]): Promise<number> {
    const res = await db.execute("SELECT COUNT(*) AS n FROM sessions");
    return Number(res.rows[0].n);
  }

  it("startTask creates no thread and no first message", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: refusingProvision });

    const before = await sessionCount(db);
    await assert.rejects(
      runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" }),
      RunnerMcpTokenMissingError,
    );
    assert.equal(await sessionCount(db), before, "no session row");
  });

  it("a draft's first message leaves the draft a draft", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    clearRegistryForTests();
    registerAdapter(adapter);
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: refusingProvision });

    try {
      const draft = await runtime.createDraft({ userId: "U1", nodeId });
      await assert.rejects(runtime.sendMessage(draft.id, "ahoj"), RunnerMcpTokenMissingError);
      assert.equal((await store.getSession(draft.id))?.state, "draft");
      assert.equal((await content.getContent(draft.id))?.brief ?? null, null);
      assert.equal((await content.listEvents(draft.id)).length, 0);
    } finally {
      clearRegistryForTests();
    }
  });

  it("Pokračovat v nové session leaves the old thread running and creates no new one", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    let refuse = false;
    const runtime = createSessionRuntime({
      store,
      content,
      registry: registryOf(adapter),
      provision: async (input) => (refuse ? refusingProvision() : stubProvision()(input)),
    });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const before = await sessionCount(db);
    refuse = true;
    await assert.rejects(runtime.continueSession(session.id), RunnerMcpTokenMissingError);
    assert.equal((await store.getSession(session.id))?.state, "running");
    assert.equal(await sessionCount(db), before);
    await runtime.closeSession(session.id);
  });
});

function userTexts(events: { kind: string; payload: string }[]): string[] {
  return events.filter((e) => e.kind === "user_message").map((e) => JSON.parse(e.payload).text as string);
}

describe("session runtime: one start per thread (#488)", () => {
  it("two quick messages into a suspended thread start one run, and the second is an ordinary message", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const firstAdapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const registry = { getAdapter: (id: string) => (id === "fake" ? (firstAdapter as RunnerAdapter) : null) };
    const runtime = createSessionRuntime({ store, content, registry, provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1);
    assert.equal((await store.getSession(session.id))?.state, "suspended");

    const gated = new GatedAdapter(new FakeRunnerAdapter({ script: [{ wait: "message" }] }));
    registry.getAdapter = (id: string) => (id === "fake" ? (gated as RunnerAdapter) : null);

    const first = runtime.sendMessage(session.id, "one");
    const second = runtime.sendMessage(session.id, "two");
    await gated.entered;
    gated.open();
    await first;
    await second;

    // One resume run, not two: the second message waited for the start the
    // first one had in flight and went into its run.
    assert.equal(gated.startCount, 1);
    assert.equal((await store.listRuns(session.id)).length, 2);
    const events = await content.listEvents(session.id);
    assert.deepEqual(userTexts(events), ["x", "one", "two"]);
    assert.equal((await store.getSession(session.id))?.state, "running");
  });

  it("a message sent while a draft's first run is starting reaches that run", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    clearRegistryForTests();
    const gated = new GatedAdapter(new FakeRunnerAdapter({ script: [{ wait: "message" }] }));
    registerAdapter(gated);
    const runtime = createSessionRuntime({ store, content, registry: registryOf(gated), provision: stubProvision() });

    const draft = await runtime.createDraft({ userId: "U1", nodeId });
    const first = runtime.sendMessage(draft.id, "one");
    const second = runtime.sendMessage(draft.id, "two");
    await gated.entered;
    gated.open();
    await first;
    // No "has no live run": the second message waited for the start.
    await second;

    assert.equal(gated.startCount, 1);
    assert.equal((await store.listRuns(draft.id)).length, 1);
    assert.deepEqual(userTexts(await content.listEvents(draft.id)), ["one", "two"]);
    clearRegistryForTests();
  });

  it("Uzavřít during a start waits for it and ends the run it produced", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    clearRegistryForTests();
    const gated = new GatedAdapter(new FakeRunnerAdapter({ script: [{ wait: "message" }] }));
    registerAdapter(gated);
    const runtime = createSessionRuntime({ store, content, registry: registryOf(gated), provision: stubProvision() });

    const draft = await runtime.createDraft({ userId: "U1", nodeId });
    const send = runtime.sendMessage(draft.id, "one");
    const close = runtime.closeSession(draft.id);
    await gated.entered;
    gated.open();
    await send;
    const closed = await close;

    assert.equal(closed.state, "closed");
    // The process that the start produced is the one that was closed --
    // without the wait the close saw no live run and left it running.
    assert.equal(gated.closeCount, 1);
    const runs = await store.listRuns(draft.id);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].ended_at);
    clearRegistryForTests();
  });

  it("Stop and an answer during a start wait for it and act on the run it produced", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const inner = new TeardownAdapter();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const interrupts: string[] = [];
    const answers: string[] = [];
    const adapter: RunnerAdapter = {
      id: "fake",
      detect: () => inner.detect(),
      models: () => inner.models(),
      async start(run, sink) {
        markEntered();
        await gate;
        const handle = await inner.start(run, sink);
        return {
          ...handle,
          interrupt: async () => {
            interrupts.push(run.runId);
          },
          answer: async (requestId: string) => {
            answers.push(requestId);
          },
        };
      },
    };
    clearRegistryForTests();
    registerAdapter(adapter);
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    try {
      const draft = await runtime.createDraft({ userId: "U1", nodeId });
      const send = runtime.sendMessage(draft.id, "one");
      await entered;
      const stop = runtime.interrupt(draft.id);
      const answered = runtime.answer(draft.id, "req-1", { by: "U1", value: true, at: new Date().toISOString() });
      openGate();
      await send;
      await stop;
      await answered;

      assert.deepEqual(interrupts, [inner.last.start.runId], "Stop reached the run the start produced");
      assert.deepEqual(answers, ["req-1"], "the answer reached it too, instead of 'has no live run'");
      await runtime.closeSession(draft.id);
    } finally {
      clearRegistryForTests();
    }
  });

  it("a stray run_ended arriving while the next run is still starting leaves that start alone", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const sinks: ((event: CanonicalEvent) => void)[] = [];
    const inner = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const first: RunnerAdapter = {
      id: "fake",
      detect: () => inner.detect(),
      models: () => inner.models(),
      async start(run, sink) {
        sinks.push(sink);
        return inner.start(run, sink);
      },
    };
    const registry = { getAdapter: (id: string) => (id === "fake" ? first : null) };
    const runtime = createSessionRuntime({ store, content, registry, provision: stubProvision() });

    const { session, run: firstRun } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1);
    assert.equal((await store.getSession(session.id))?.state, "suspended");

    const gated = new GatedAdapter(new FakeRunnerAdapter({ script: [{ wait: "message" }] }));
    registry.getAdapter = (id: string) => (id === "fake" ? (gated as RunnerAdapter) : null);
    const send = runtime.sendMessage(session.id, "pokračuj");
    await gated.entered;
    // The resume run has a row and the thread says running, but no live
    // handle yet: the dead first run's late run_ended lands in that window.
    // The event queue is serial, so once a marker emitted after it is
    // published, the run_ended has been handled in full -- still inside
    // the window.
    const marker = new Promise<void>((resolve) => {
      const off = runtime.subscribe(session.id, (_id, event) => {
        if ("kind" in event && event.kind === "turn_ended") {
          off();
          resolve();
        }
      });
    });
    sinks[0]({ kind: "run_ended", payload: { run_id: firstRun.id, reason: "completed", usage: null } });
    sinks[0]({ kind: "turn_ended", payload: { run_id: firstRun.id } });
    await marker;
    gated.open();
    await send;

    assert.equal((await store.getSession(session.id))?.state, "running", "the start was not suspended under it");
    const runs = await store.listRuns(session.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].ended_at, null, "the new run is still open");
    await runtime.sendMessage(session.id, "ještě");
    assert.equal((await store.listRuns(session.id)).length, 2, "the next message went to the live run");
    await runtime.closeSession(session.id);
  });

  it("a run_ended from a run that is no longer live leaves the live run alone", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    // Every sink the adapter is handed, in start order: sinks[0] belongs to
    // the first run, sinks[1] to the resume run.
    const sinks: ((event: CanonicalEvent) => void)[] = [];
    const inner = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const adapter: RunnerAdapter = {
      id: "fake",
      detect: () => inner.detect(),
      models: () => inner.models(),
      async start(run, sink) {
        sinks.push(sink);
        return inner.start(run, sink);
      },
    };
    const runtime = createSessionRuntime({
      store,
      content,
      registry: registryOf(adapter),
      provision: stubProvision(),
    });

    const { session, run: firstRun } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1);
    await runtime.sendMessage(session.id, "keep going");
    const afterResume = await store.listRuns(session.id);
    assert.equal(afterResume.length, 2);

    // The dead first run emits one more run_ended, after the resume run is
    // already the live one. interrupt() drains the event queue.
    sinks[0]({ kind: "run_ended", payload: { run_id: firstRun.id, reason: "completed", usage: null } });
    await runtime.interrupt(session.id);

    // The live run is untouched: still running, still holding its handle,
    // no second suspend written on top of it.
    assert.equal((await store.getSession(session.id))?.state, "running");
    const events = await content.listEvents(session.id);
    const suspends = events.filter((e) => e.kind === "state_changed" && JSON.parse(e.payload).to === "suspended");
    assert.equal(suspends.length, 1);
    await runtime.sendMessage(session.id, "still here");
    assert.equal((await store.listRuns(session.id)).length, 2);
    assert.deepEqual(userTexts(await content.listEvents(session.id)), ["x", "keep going", "still here"]);
  });
});

describe("session runtime: a message queued mid-turn (#490)", () => {
  // The count, not a flag: the second message is written while the agent is
  // still on the first, so the turn_ended that lands next ends the FIRST
  // turn only. Until the second one is answered the run is working and the
  // idle sweep must leave it alone.
  it("checkIdleRunsOnce leaves a run whose second message is still unanswered", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter();
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "první", runner: "fake" });
    const run = adapter.last;
    await runtime.sendMessage(session.id, "druhá");
    assert.deepEqual(run.delivered, ["druhá"]);

    // The first turn ends; the second message has not been answered yet.
    run.emit({ kind: "turn_ended", payload: { run_id: run.start.runId } });
    // interrupt() is a no-op on this adapter and drains the event queue, so
    // the sweep below sees the turn_ended already accounted for.
    await runtime.interrupt(session.id);
    await runtime.checkIdleRunsOnce(0, Date.now() + 61_000);
    assert.equal((await store.getSession(session.id))?.state, "running", "the agent is working on the second message");

    // The second turn ends: nothing is in flight any more.
    run.emit({ kind: "turn_ended", payload: { run_id: run.start.runId } });
    await runtime.interrupt(session.id);
    await runtime.checkIdleRunsOnce(0, Date.now() + 61_000);
    assert.equal((await store.getSession(session.id))?.state, "suspended");
  });

  // One turn can answer both messages -- the SDK folds a send that lands
  // mid-turn into the running turn and reports one result for the pair
  // (turn_ended's consumed_messages). Counting turn_ended events alone
  // would leave the run "working" forever and the idle sweep would never
  // end it.
  it("a turn that answered both messages ends the wait for both", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter();
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "první", runner: "fake" });
    const run = adapter.last;
    await runtime.sendMessage(session.id, "druhá");

    run.emit({ kind: "turn_ended", payload: { run_id: run.start.runId, consumed_messages: 2 } });
    await runtime.interrupt(session.id);
    await runtime.checkIdleRunsOnce(0, Date.now() + 61_000);
    assert.equal((await store.getSession(session.id))?.state, "suspended");
  });

  // run_ended zeroes the count: no turn of a run that is over can still be
  // in flight, so the next run never starts with work it does not have.
  it("the next run is not born mid-turn: run_ended zeroes the count", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter();
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "první", runner: "fake" });
    const first = adapter.last;
    await runtime.sendMessage(session.id, "druhá");
    // The run dies with both messages unanswered (a provider error), so the
    // thread suspends; writing into it starts the next run.
    first.endRun("error");
    await runtime.sendMessage(session.id, "a dál?");
    const second = adapter.last;
    assert.equal(adapter.runs.length, 2);

    second.emit({ kind: "turn_ended", payload: { run_id: second.start.runId } });
    await runtime.interrupt(session.id);
    await runtime.checkIdleRunsOnce(0, Date.now() + 61_000);
    assert.equal((await store.getSession(session.id))?.state, "suspended");
  });
});

// #490: the count of messages a run owes an answer is given back when the
// message never reached the run -- a send or a start that failed -- so the
// idle sweep still ends the run once its real turns are answered.
describe("session runtime: a failed send or start owes no turn (#490)", () => {
  it("a send that fails for another reason than a run end gives its count back", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const inner = new TeardownAdapter();
    const adapter: RunnerAdapter = {
      id: "fake",
      detect: () => inner.detect(),
      models: () => inner.models(),
      async start(run, sink) {
        const handle = await inner.start(run, sink);
        return {
          ...handle,
          send: async () => {
            throw new Error("the prompt pipe is broken");
          },
        };
      },
    };
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    inner.last.emit({ kind: "turn_ended", payload: { run_id: inner.last.start.runId } });
    await assert.rejects(runtime.sendMessage(session.id, "druhá"), /prompt pipe/);

    await runtime.checkIdleRunsOnce(0, Date.now() + 61_000);
    assert.equal((await store.getSession(session.id))?.state, "suspended", "no turn is owed for a message the run never took");
  });

  it("a start that fails gives the brief's count back, so the next run of the thread can go idle", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const inner = new TeardownAdapter();
    let failNextStart = false;
    const adapter: RunnerAdapter = {
      id: "fake",
      detect: () => inner.detect(),
      models: () => inner.models(),
      async start(run, sink) {
        if (failNextStart) {
          failNextStart = false;
          throw new Error("the CLI would not start");
        }
        return inner.start(run, sink);
      },
    };
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    inner.last.endRun("error");
    await runtime.interrupt(session.id);
    assert.equal((await store.getSession(session.id))?.state, "suspended");

    // The resume's start fails: its brief never reached a run.
    failNextStart = true;
    await assert.rejects(runtime.sendMessage(session.id, "pokračuj"), /would not start/);
    // Whatever suspends the stranded thread (a Předat, the boot sweep),
    // the next message resumes it and its turn ends.
    await createSuspendServerSide(localSuspendDeps(getDb(), content))(session.id, "boot_sweep");
    await runtime.sendMessage(session.id, "znovu");
    inner.last.emit({ kind: "turn_ended", payload: { run_id: inner.last.start.runId } });
    await runtime.interrupt(session.id);

    await runtime.checkIdleRunsOnce(0, Date.now() + 61_000);
    assert.equal((await store.getSession(session.id))?.state, "suspended");
  });
});

describe("session runtime: a message into a run that is ending (#489)", () => {
  // The run that is ending never takes the message; the runtime waits for
  // its end (and the suspend that follows), then delivers the message as
  // the next run's first message -- written to the transcript exactly once.
  it("a message a provider-failure teardown refuses is delivered to the next run, once in the log", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter();
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const first = adapter.last;

    // What the Claude adapter does on a spend limit: the provider's message
    // goes into the transcript and the teardown starts; run_ended follows
    // only once the child is gone.
    first.emit({ kind: "error", payload: { class: "provider", message: "You've hit your monthly spend limit" } });
    first.beginTeardown();

    const send = runtime.sendMessage(session.id, "tak co teď?");
    await first.refused;
    first.endRun("limit");
    await send;

    assert.deepEqual(first.refusedTexts, ["tak co teď?"]);
    assert.equal(adapter.runs.length, 2, "the message started the next run");
    assert.equal(adapter.runs[1].start.brief, "tak co teď?", "and it is that run's first message");

    const runs = await store.listRuns(session.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].end_reason, "limit");
    assert.equal(runs[1].resumed_from_run_id, runs[0].id);
    assert.equal((await store.getSession(session.id))?.state, "running");

    const events = await content.listEvents(session.id);
    assert.deepEqual(userTexts(events), ["x", "tak co teď?"], "the message is in the log exactly once");
    // The message sits before the next run's run_started in the log; that
    // run_started says the run carries it, which is what the web counts
    // the turn in flight from (#490).
    const secondStart = events.find((e) => e.kind === "run_started" && JSON.parse(e.payload).run_id === runs[1].id);
    assert.equal(JSON.parse(secondStart!.payload).carried_messages, 1);
    const firstStart = events.find((e) => e.kind === "run_started" && JSON.parse(e.payload).run_id === runs[0].id);
    assert.equal(JSON.parse(firstStart!.payload).carried_messages, undefined, "a brief logged by its own run carries nothing");
  });

  it("a message sent while the idle sweep is ending the run is delivered to the next run", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter({ holdClose: true });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const first = adapter.last;

    // The turn has to be over for the sweep to consider the run idle at all;
    // interrupt() (a no-op on this adapter) drains the event queue, so the
    // sweep below sees the turn_ended already accounted for.
    first.emit({ kind: "turn_ended", payload: { run_id: "fake" } });
    await runtime.interrupt(session.id);

    const ending = runtime.checkIdleRunsOnce(0, Date.now() + 1);
    await first.closing;
    const send = runtime.sendMessage(session.id, "ještě jedna věc");
    await first.refused;
    first.releaseClose();
    await ending;
    await send;

    assert.equal(adapter.runs.length, 2);
    assert.equal(adapter.runs[1].start.brief, "ještě jedna věc");
    assert.equal((await store.getSession(session.id))?.state, "running");
    assert.deepEqual(userTexts(await content.listEvents(session.id)), ["x", "ještě jedna věc"]);

    // The idle end suspended the thread once, and the resume built on it.
    const suspends = (await content.listEvents(session.id)).filter(
      (e) => e.kind === "state_changed" && JSON.parse(e.payload).to === "suspended",
    );
    assert.equal(suspends.length, 1);
  });

  it("a message between run_ended and the suspend write is not refused", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter();

    // The window: run_ended has landed (no live run any more, the row still
    // says running) and the suspend it triggers has not been written yet.
    let markEntered!: () => void;
    const enteredSuspend = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseSuspend!: () => void;
    const suspendGate = new Promise<void>((resolve) => {
      releaseSuspend = resolve;
    });
    const realSuspend = createSuspendServerSide(localSuspendDeps(getDb(), content));
    const runtime = createSessionRuntime({
      store,
      content,
      registry: registryOf(adapter),
      provision: stubProvision(),
      suspendFallback: async (sessionId, reason, opts) => {
        markEntered();
        await suspendGate;
        return realSuspend(sessionId, reason, opts);
      },
    });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    adapter.last.endRun("completed");
    await enteredSuspend;

    // Used to throw "has no live run" -- the row says running, the handle
    // is already gone.
    const send = runtime.sendMessage(session.id, "pokračuj");
    releaseSuspend();
    await send;

    assert.equal(adapter.runs.length, 2);
    assert.equal(adapter.runs[1].start.brief, "pokračuj");
    assert.equal((await store.getSession(session.id))?.state, "running");
    assert.deepEqual(userTexts(await content.listEvents(session.id)), ["x", "pokračuj"]);
    assert.equal((await store.listRuns(session.id)).length, 2);
  });

  // A run_ended the content store cannot record must not wedge the thread:
  // the message waiting for that end is delivered, and the lifecycle verbs
  // queued behind it (Uzavřít here) still run. The timeout only turns the
  // old hang into a failure; nothing in the test waits on a clock.
  it("a run_ended whose log write fails still ends the run and releases the waiting message", { timeout: 10_000 }, async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter();
    const flaky = failingRunEndedWrites(content);
    const runtime = createSessionRuntime({
      store,
      content: flaky,
      registry: registryOf(adapter),
      provision: stubProvision(),
      suspendFallback: createSuspendServerSide(localSuspendDeps(getDb(), flaky)),
    });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const first = adapter.last;
    first.beginTeardown();
    const send = runtime.sendMessage(session.id, "pokračuj");
    await first.refused;
    first.endRun("error");
    await send;

    assert.equal(adapter.runs.length, 2, "the refused message started the next run");
    assert.equal(adapter.runs[1].start.brief, "pokračuj");
    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].end_reason, "error", "the first run's row is ended even though its log write failed");

    const closed = await runtime.closeSession(session.id);
    assert.equal(closed.state, "closed");
  });
});

// The content store with every write that carries a run_ended refused, the
// way a full disk would refuse it.
function failingRunEndedWrites(inner: SessionContentStore): SessionContentStore {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "appendEvents") {
        return async (...args: Parameters<SessionContentStore["appendEvents"]>) => {
          if (args[2].some((e) => e.kind === "run_ended")) throw new Error("disk full");
          return target.appendEvents(...args);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("session runtime: the idle sweep re-checks before it ends (#491)", () => {
  // The sweep computes its list once and then ends the runs on it one at a
  // time; ending one takes seconds. A message written into the next session
  // on the list in the meantime makes it busy, so the sweep has to skip it.
  it("a message into the next session on the list keeps it running", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter({ holdClose: true });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const first = await runtime.startTask({ userId: "U1", nodeId, brief: "první", runner: "fake" });
    const firstRun = adapter.last;
    const second = await runtime.startTask({ userId: "U1", nodeId, brief: "druhá", runner: "fake" });
    const secondRun = adapter.last;

    // Both turns are over, so both runs are on the sweep's list. interrupt()
    // is a no-op on this adapter and drains the event queue.
    for (const run of [firstRun, secondRun]) {
      run.emit({ kind: "turn_ended", payload: { run_id: run.start.runId } });
    }
    await runtime.interrupt(first.session.id);
    await runtime.interrupt(second.session.id);

    const ending = runtime.checkIdleRunsOnce(0, Date.now() + 61_000);
    await firstRun.closing;
    // The user goes back to the second thread while the first one is ending.
    await runtime.sendMessage(second.session.id, "ještě počkej");
    firstRun.releaseClose();
    secondRun.releaseClose(); // never awaited if the sweep skips it
    await ending;

    assert.equal((await store.getSession(first.session.id))?.state, "suspended", "the idle one ended");
    assert.equal((await store.getSession(second.session.id))?.state, "running", "the one written into stayed");
    assert.equal(secondRun.closeCount, 0, "the sweep never closed the second run");
    assert.deepEqual(secondRun.delivered, ["ještě počkej"]);
  });

  // Not only a message: answering the question the sweep picked the session
  // up FOR is activity too, and it can land in the same millisecond the
  // session was picked in -- so the re-check counts activity, it does not
  // compare clocks.
  it("answering the open question during the sweep keeps that session running", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new TeardownAdapter({ holdClose: true });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const first = await runtime.startTask({ userId: "U1", nodeId, brief: "první", runner: "fake" });
    const firstRun = adapter.last;
    const second = await runtime.startTask({ userId: "U1", nodeId, brief: "druhá", runner: "fake" });
    const secondRun = adapter.last;

    firstRun.emit({ kind: "turn_ended", payload: { run_id: firstRun.start.runId } });
    // The second thread waits on the user: an open question is the one turn
    // in flight the sweep is allowed to end.
    secondRun.emit({
      kind: "question",
      payload: { request_id: "q1", type: "approval", tool: "Bash", title: "Smím?", detail: "", options: null, decision: null },
    });
    // interrupt() is a no-op on this adapter and drains the event queue.
    await runtime.interrupt(first.session.id);
    await runtime.interrupt(second.session.id);
    assert.equal(runtime.pendingQuestion(second.session.id)?.request_id, "q1");

    const ending = runtime.checkIdleRunsOnce(0, Date.now() + 61_000);
    await firstRun.closing;
    await runtime.answer(second.session.id, "q1", { by: "U1", value: "allow", at: new Date().toISOString() });
    firstRun.releaseClose();
    secondRun.releaseClose(); // never awaited if the sweep skips it
    await ending;

    assert.equal((await store.getSession(first.session.id))?.state, "suspended");
    assert.equal((await store.getSession(second.session.id))?.state, "running", "the answered thread stayed");
    assert.equal(secondRun.closeCount, 0, "the sweep never closed the answered run");
  });
});
