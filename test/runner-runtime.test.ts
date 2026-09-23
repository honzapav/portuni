// Session runtime (apps/server/domain/runner/session-runtime.ts): the only
// writer of runs and events. Fake adapter + DbSessionStore on a temp
// libsql :memory: DB, the pattern from test/api-sessions.test.ts for DB
// setup (via test/helpers/shared-db.ts's makeSharedDb).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import {
  SessionHandoffError,
  createSessionRuntime,
  resolveModelAndEffort,
} from "../apps/server/domain/runner/session-runtime.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { createInstance, setOrgDefault } from "../apps/server/domain/runner/instances.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import type { CanonicalEvent, RunnerAdapter, RunHandle, RunStart } from "../apps/server/domain/runner/types.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { claudeProjectSlug } from "../apps/server/domain/session-handoff.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";
import { GatedAdapter } from "./helpers/gated-adapter.js";

afterEach(() => {
  setDbForTesting(null);
  clearTestContentDb();
});

// #456: the transcript, the brief and the inline handoff summary are the
// device's content, in content.db -- a separate store from the record.
// sharedDb() installs a fresh in-memory one per test and leaves it here, so
// every createSessionRuntime call below hands the runtime the same pair the
// production composition roots do.
let content: SessionContentStore;

// getSessionScope/getMirrorPath/writeHandoffAndSuspend all reach through
// the global getDb() singleton (like the rest of the domain layer), not
// through a db this test constructs directly -- route it at the same
// :memory: client makeSharedDb() just built.
async function sharedDb(): Promise<SharedDb> {
  const shared = await makeSharedDb();
  setDbForTesting(shared.db);
  content = (await installTestContentDb()).content;
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

// The first turn is over and the run waits for the next message -- what a
// real run looks like when nobody has written for a while.
const TURN_DONE: FakeScriptStep = { kind: "turn_ended", payload: { run_id: "fake" } };

describe("session runtime: startTask", () => {
  it("persists run_started, then the brief as user_message, with monotonic seq", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run } = await runtime.startTask({
      userId: "U1",
      nodeId,
      brief: "Fix the bug",
      runner: "fake",
      policy: "default",
    });

    const events = await content.listEvents(session.id);
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
      content,
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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    let row = await store.getSession(session.id);
    assert.ok(row?.waiting_since, "waiting_since must be set once the question opens");

    const decision = { by: "U1", value: true, at: new Date().toISOString() };
    await runtime.answer(session.id, "req-1", decision);

    row = await store.getSession(session.id);
    assert.equal(row?.waiting_since, null, "waiting_since must be cleared after answer()");

    const events = await content.listEvents(session.id);
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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

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
    const events = await content.listEvents(session.id);
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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "suspended");
    const summary = (await content.getContent(session.id))?.handoff_inline;
    assert.ok(summary, "a summary must exist after a non-close run end");
    assert.match(summary!, /Poslední zprávy/);
    assert.match(summary!, /Fix the bug|x/); // the brief shows up as the first message

    const runs = await store.listRuns(session.id);
    // The adapter itself reports "completed" (a graceful close it can't
    // explain); withSuspendReason rewrites it since this wasn't an
    // explicit close.
    assert.equal(runs[0].end_reason, "suspended");

    const events = await content.listEvents(session.id);
    const handoffEvent = events.find((e) => e.kind === "handoff");
    assert.ok(handoffEvent, "a handoff/summary event must be appended");
  });

  it("checkIdleRunsOnce ends a run idle for longer than idleMs, tagged 'idle'", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    // Not idle yet (well within the cutoff).
    await runtime.checkIdleRunsOnce(60_000, Date.now());
    assert.equal((await store.getSession(session.id))?.state, "running");

    // Now simulate the cutoff having passed.
    await runtime.checkIdleRunsOnce(60_000, Date.now() + 61_000);

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "suspended");
    const summary = (await content.getContent(session.id))?.handoff_inline ?? null;
    assert.ok(summary);
    const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");
    assert.equal(parseServerHandoffReason(summary), "idle");
  });

  it("checkIdleRunsOnce never ends a run mid-turn: the agent is working, not idle", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(60_000, Date.now() + 61_000);
    assert.equal((await store.getSession(session.id))?.state, "running");
  });

  it("checkIdleRunsOnce ends a run whose open question has waited on the user past idleMs", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({
      script: [
        {
          kind: "question",
          payload: { request_id: "q1", type: "approval", tool: "Bash", title: "Smím?", detail: "", options: null, decision: null },
        },
        { wait: "answer" },
      ],
    });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(60_000, Date.now() + 61_000);
    assert.equal((await store.getSession(session.id))?.state, "suspended");
  });

  it("a run ending on a provider limit suspends the thread with the provider message in its events (#411)", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    // What the Claude adapter reports when the CLI answers with a spend
    // limit: one provider error, then the run ends with reason "limit".
    const adapter = new FakeRunnerAdapter({
      script: [
        { kind: "error", payload: { class: "provider", message: "You've hit your monthly spend limit" } },
        { end: "limit" },
      ],
    });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "suspended");
    assert.ok((await content.getContent(session.id))?.handoff_inline, "a server-written summary must exist");

    const runs = await store.listRuns(session.id);
    // withSuspendReason leaves an adapter-reported limit alone -- that IS
    // the informative reason.
    assert.equal(runs[0].end_reason, "limit");

    const events = await content.listEvents(session.id);
    const error = events.find((e) => e.kind === "error");
    assert.ok(error, "the provider message must be in the transcript");
    assert.equal(JSON.parse(error!.payload).class, "provider");
    assert.match(JSON.parse(error!.payload).message, /spend limit/);
    assert.ok(events.some((e) => e.kind === "handoff"), "a handoff event must be appended");
  });

  it("the run's conversation id is recorded while it runs, not only when it ends", async () => {
    // A run the host loses (a crash, a restart) never reaches its own
    // run_ended, where the id used to be read: such a run left no pointer
    // to its conversation and could only be resumed from a summary.
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [{ kind: "reasoning", payload: { summary: "thinking" } }, { wait: "message" }];
    const adapter = new FakeRunnerAdapter({ script, agentSessionId: "conv-live" });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].id, run.id);
    assert.equal(runs[0].ended_at, null, "the run is still live");
    assert.equal(runs[0].agent_session_id, "conv-live");
  });

  it("checkIdleRunsOnce is a no-op when nothing is live", async () => {
    const { db } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });
    await runtime.checkIdleRunsOnce(1); // must not throw
  });
});

// checkConversationResumable (domain/session-handoff.ts) is cli === "claude"
// only and reads the real OS home directory unless the session's instance
// names a CLAUDE_CONFIG_DIR, which resumeByWriting now threads through: the
// profile test below builds a transcript under a temp one and gets the
// conversation-resume branch. The rest leave cli unset on the fake
// adapter's session and so take the (also real-world-common) "falls back to
// the summary" path.
describe("session runtime: resume by writing (#378)", () => {
  it("sending into a suspended thread starts a new, linked run from the summary", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const script: FakeScriptStep[] = [TURN_DONE, { wait: "message" }];
    const adapter = new FakeRunnerAdapter({ script, agentSessionId: "claude-conv-1" });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run: firstRun } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1); // ends the run -> suspended, summary written
    assert.equal((await store.getSession(session.id))?.state, "suspended");

    await runtime.sendMessage(session.id, "keep going");

    const runs = await store.listRuns(session.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].resumed_from_run_id, firstRun.id);
    // No conversation-resume in this environment (see the block comment
    // above) -- a fresh run from the summary, not --resume.
    assert.equal(adapter.getLastRunStart()?.resume, null);

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "running");

    const events = await content.listEvents(session.id);
    const secondRunStarted = events.find((e) => e.run_id === runs[1].id && e.kind === "run_started");
    assert.ok(secondRunStarted);
    assert.equal(JSON.parse(secondRunStarted!.payload).resume, "handoff");
    assert.ok(
      events.some((e) => e.run_id === runs[1].id && e.kind === "user_message" && JSON.parse(e.payload).text === "keep going"),
    );
  });

  it("a resume under a profile looks for that profile's transcript, not the default one", async () => {
    // The CLI keeps its transcripts under CLAUDE_CONFIG_DIR, so a session
    // run under a profile (a second account) has none where the default
    // location is looked at: every resume fell back to the summary and the
    // fresh agent never saw the start of the thread.
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const dir = await mkdtemp(join(tmpdir(), "portuni-profile-resume-"));
    const previousDataDir = process.env.PORTUNI_DATA_DIR;
    process.env.PORTUNI_DATA_DIR = join(dir, "data");
    try {
      const configDir = join(dir, "claude-profile");
      const cwd = join(dir, "mirror");
      const instance = await createInstance({ name: "JRD", runner: "fake", env: { CLAUDE_CONFIG_DIR: configDir } });
      // The transcript that profile's CLI would have left behind.
      await mkdir(join(configDir, "projects", claudeProjectSlug(cwd)), { recursive: true });
      await writeFile(join(configDir, "projects", claudeProjectSlug(cwd), "conv-1.jsonl"), "{}\n", "utf8");

      const adapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }], agentSessionId: "conv-1" });
      const runtime = createSessionRuntime({
        store,
        content,
        registry: registryOf(adapter),
        provision: stubProvision({ cwd, mirrors: [cwd] }),
      });
      const { session } = await runtime.startTask({
        userId: "U1",
        nodeId,
        brief: "x",
        runner: "fake",
        instanceId: instance.id,
      });
      await db.execute({ sql: "UPDATE sessions SET cli = 'claude' WHERE id = ?", args: [session.id] });
      await runtime.checkIdleRunsOnce(0, Date.now() + 1); // idle -> run ends, session suspends

      await runtime.sendMessage(session.id, "pokračuj");

      const runs = await store.listRuns(session.id);
      assert.equal(runs.length, 2);
      assert.equal(runs[1].agent_session_id, "conv-1", "the new run continues the same conversation");
      const events = await content.listEvents(session.id);
      const started = events.find((e) => e.run_id === runs[1].id && e.kind === "run_started");
      assert.equal(JSON.parse(started!.payload).resume, "conversation");
    } finally {
      if (previousDataDir === undefined) delete process.env.PORTUNI_DATA_DIR;
      else process.env.PORTUNI_DATA_DIR = previousDataDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the new run's orientation carries the previous summary", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);

    // First run: a real FakeRunnerAdapter so startTask/checkIdleRunsOnce
    // can drive it through a normal suspend with a summary written.
    const firstAdapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const registry = { getAdapter: (id: string) => (id === "fake" ? firstAdapter : null) };
    const runtime = createSessionRuntime({ store, content, registry, provision: stubProvision() });
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1);
    const suspended = await store.getSession(session.id);
    assert.equal(suspended?.state, "suspended");
    assert.ok((await content.getContent(session.id))?.handoff_inline);

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
  it("a question the adapter closes itself (a decided question event) clears waiting_since", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const payload = {
      request_id: "req-closed",
      type: "approval" as const,
      tool: "mcp__portuni",
      title: "Potvrzení: portuni",
      detail: "Allow writing?",
      options: null,
    };
    const script: FakeScriptStep[] = [
      { kind: "question", payload: { ...payload, decision: null } },
      { kind: "question", payload: { ...payload, decision: { by: "system", value: false, at: new Date().toISOString() } } },
      { wait: "message" },
    ];
    const adapter = new FakeRunnerAdapter({ script });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    const row = await store.getSession(session.id);
    assert.equal(row?.waiting_since, null, "the closed question must not leave the session waiting");
    const events = await content.listEvents(session.id);
    const stateChanged = events.filter((e) => e.kind === "state_changed").map((e) => JSON.parse(e.payload));
    assert.deepEqual(
      stateChanged.map((s) => s.waiting),
      [true, false],
    );
    await runtime.closeSession(session.id);
  });

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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.answer(session.id, "q1", { by: "U1", value: "a", at: new Date().toISOString() });

    const kinds = (await content.listEvents(session.id)).map((e) => {
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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    assert.deepEqual(seenHeaders, { "X-Portuni-Spawn-Id": session.id });
  });
});

describe("session runtime: close", () => {
  it("closeSession ends a live run via close() (not interrupt) and transitions the session to closed", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session, run } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const closed = await runtime.closeSession(session.id);
    assert.equal(closed.state, "closed");

    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].id, run.id);
    // #378: closeSession goes through close(), and closingSessions keeps
    // handleAdapterEvent from rewriting/auto-summarizing this one -- the
    // adapter's own "completed" (a graceful close) stands.
    assert.equal(runs[0].end_reason, "completed");
    assert.ok(!(await content.getContent(session.id))?.handoff_inline, "Uzavřít does not write a summary");
  });

  // The Relace row, the Práce sidebar and Přehled all learn a state change
  // only from the live channel's session_state broadcast, which
  // sessions-ws.ts fires on state_changed/question/run_ended. A close of
  // a session with NO live run (a suspended one) produces no run_ended, so
  // without an explicit state_changed nothing in the app ever updates.
  it("closeSession publishes state_changed to closed for a suspended session (no live run)", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1);
    assert.equal((await store.getSession(session.id))?.state, "suspended");

    const received: Array<{ kind?: string; payload?: unknown }> = [];
    const unsubscribe = runtime.subscribe("*", (_sessionId, event) => {
      received.push(event as { kind?: string; payload?: unknown });
    });
    const closed = await runtime.closeSession(session.id);
    unsubscribe();
    assert.equal(closed.state, "closed");

    const transitions = received.filter((e) => e.kind === "state_changed");
    assert.deepEqual(
      transitions.map((e) => e.payload),
      [{ from: "suspended", to: "closed", waiting: false }],
    );
    const persisted = (await content.listEvents(session.id)).filter((e) => e.kind === "state_changed");
    assert.ok(
      persisted.some((e) => (JSON.parse(e.payload) as { to?: string }).to === "closed"),
      "the transition is in the event log too",
    );
  });

  it("renameSession writes the name as custom and publishes a session_changed frame, never an event", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const before = (await content.listEvents(session.id)).length;
    const received: Array<{ type?: string; session_id?: string }> = [];
    const unsubscribe = runtime.subscribe("*", (_sessionId, event) => {
      received.push(event as { type?: string; session_id?: string });
    });
    const renamed = await runtime.renameSession(session.id, "  Nový název  ");
    unsubscribe();

    assert.equal(renamed.name, "Nový název");
    assert.equal(renamed.name_is_custom, 1);
    assert.deepEqual(
      received.filter((e) => e.type === "session_changed"),
      [{ type: "session_changed", session_id: session.id }],
    );
    assert.equal((await content.listEvents(session.id)).length, before, "a rename is not a conversation event");
    await assert.rejects(runtime.renameSession(session.id, "   "), /must not be empty/);
  });

  it("closeSession publishes state_changed to closed for a live run as well", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const received: Array<{ kind?: string; payload?: unknown }> = [];
    const unsubscribe = runtime.subscribe("*", (_sessionId, event) => {
      received.push(event as { kind?: string; payload?: unknown });
    });
    await runtime.closeSession(session.id);
    unsubscribe();

    const transitions = received.filter((e) => e.kind === "state_changed").map((e) => e.payload);
    assert.deepEqual(transitions, [{ from: "running", to: "closed", waiting: false }]);
  });

  it("continueSession closes this session (no summary written on it) and starts a new one, seeded", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session: oldSession } = await runtime.startTask({ userId: "U1", nodeId, brief: "the old task", runner: "fake" });
    const { session: newSession, run: newRun } = await runtime.continueSession(oldSession.id);

    const oldRow = await store.getSession(oldSession.id);
    assert.equal(oldRow?.state, "closed");
    assert.equal(
      (await content.getContent(oldSession.id))?.handoff_inline ?? null,
      null,
      "continue does not write a summary onto the OLD session",
    );

    assert.notEqual(newSession.id, oldSession.id);
    assert.equal(newSession.node_id, oldSession.node_id);
    assert.equal(newSession.runner, oldSession.runner);
    assert.equal(newSession.name, oldSession.name);
    assert.equal(newSession.state, "running");

    const newEvents = await content.listEvents(newSession.id);
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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const received: Array<{ kind?: string; type?: string }> = [];
    const unsubscribe = runtime.subscribe("*", (_sessionId, event) => {
      received.push(event as { kind?: string; type?: string });
    });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    unsubscribe();

    assert.ok(received.some((e) => e.type === "delta"));
    assert.ok(received.some((e) => e.kind === "assistant_message"));

    const events = await content.listEvents(session.id);
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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

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
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

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
      content,
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

// #459 "Předat": the owner hands the thread to another machine through its
// handoff file. A personal workspace here (DbSessionStore + the graph db's
// own mirror registry); test/agent-router-sessions.test.ts runs the same
// verb against the fake central server for a team workspace.
describe("session runtime: handoff (#459 Předat)", () => {
  let workspace: string | null = null;

  afterEach(async () => {
    resetLocalDbForTests();
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = null;
  });

  // A node with a real mirror on this device: what the handoff file needs
  // to exist as a file at all (without one the summary stays inline and
  // Předat has nothing to hand over -- the last test below).
  async function withMirror(script: FakeScriptStep[]) {
    const shared = await sharedDb();
    workspace = await mkdtemp(join(tmpdir(), "portuni-runtime-handoff-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    const mirrorRoot = join(workspace, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", shared.nodeId, mirrorRoot);
    const store = new DbSessionStore(shared.db);
    const adapter = new FakeRunnerAdapter({ script });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });
    return { ...shared, store, runtime, mirrorRoot };
  }

  it("a running thread is drained, suspended, and its handoff file registered in the node", async () => {
    const { db, nodeId, store, runtime, mirrorRoot } = await withMirror([{ wait: "message" }]);
    const { session, run } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    const result = await runtime.handoff(session.id);

    assert.equal(result.handoff_path, `wip/sessions/${session.id}-handoff.md`);
    assert.equal(result.session.state, "suspended");
    assert.equal(result.session.handoff_path, result.handoff_path);
    // The run is drained and ended, not left open behind a suspended row.
    const runs = await store.listRuns(session.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, run.id);
    assert.ok(runs[0].ended_at, "the run must be ended, not left live");

    const onDisk = await readFile(join(mirrorRoot, result.handoff_path), "utf8");
    const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");
    assert.equal(parseServerHandoffReason(onDisk), "handoff");
    assert.match(onDisk, /Poslední zprávy/);

    // Registered as a tracked file of the node, so the next sync carries it.
    const files = await db.execute({
      sql: "SELECT filename FROM files WHERE node_id = ?",
      args: [nodeId],
    });
    assert.deepEqual(
      files.rows.map((r) => String(r.filename)),
      [`${session.id}-handoff.md`],
    );
  });

  it("a second Předat on the suspended thread answers the same path and writes nothing new", async () => {
    const { nodeId, store, runtime } = await withMirror([{ wait: "message" }]);
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const first = await runtime.handoff(session.id);
    const eventsAfterFirst = (await content.listEvents(session.id)).length;

    const second = await runtime.handoff(session.id);

    assert.equal(second.handoff_path, first.handoff_path);
    assert.equal(second.session.state, "suspended");
    assert.equal((await content.listEvents(session.id)).length, eventsAfterFirst);
    assert.equal((await store.listRuns(session.id)).length, 1);
  });

  it("a draft and a closed thread are refused with a code and a Czech message", async () => {
    const { nodeId, runtime } = await withMirror([{ wait: "message" }]);
    const draft = await runtime.createDraft({ userId: "U1", nodeId });
    await assert.rejects(
      () => runtime.handoff(draft.id),
      (err: unknown) =>
        err instanceof SessionHandoffError &&
        err.code === "HANDOFF_NOT_ALLOWED" &&
        /Předat lze jen/.test(err.message),
    );

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.closeSession(session.id);
    await assert.rejects(
      () => runtime.handoff(session.id),
      (err: unknown) => err instanceof SessionHandoffError && err.code === "HANDOFF_NOT_ALLOWED",
    );
  });

  // No mirror here: an empty mirror registry in a temp workspace.
  async function withoutMirror(script: FakeScriptStep[]) {
    const shared = await sharedDb();
    workspace = await mkdtemp(join(tmpdir(), "portuni-runtime-handoff-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    const store = new DbSessionStore(shared.db);
    const adapter = new FakeRunnerAdapter({ script });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });
    return { ...shared, store, runtime };
  }

  it("a node with no mirror on this device is refused before anything happens: the run stays live", async () => {
    const { nodeId, store, runtime } = await withoutMirror([{ wait: "message" }]);
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const eventsBefore = (await content.listEvents(session.id)).length;

    await assert.rejects(
      () => runtime.handoff(session.id),
      (err: unknown) =>
        err instanceof SessionHandoffError && err.code === "HANDOFF_NO_MIRROR" && /zrcadlo/.test(err.message),
    );
    // Refused before any side effect: not suspended, the run not ended, no
    // summary written anywhere, nothing appended to the transcript.
    assert.equal((await store.getSession(session.id))?.state, "running");
    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].ended_at, null);
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null);
    assert.equal((await content.listEvents(session.id)).length, eventsBefore);
    await runtime.closeSession(session.id);
  });

  it("a suspended thread with no file but its transcript here gets the file written from it", async () => {
    const { nodeId, store, runtime } = await withoutMirror([TURN_DONE, { wait: "message" }]);
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    // Suspended while the node had no mirror here: the summary is inline.
    await runtime.checkIdleRunsOnce(-1);
    const suspended = await store.getSession(session.id);
    assert.equal(suspended?.state, "suspended");
    assert.equal(suspended?.handoff_path, null);
    const inline = (await content.getContent(session.id))?.handoff_inline;
    assert.ok(inline);

    // The mirror arrives; Předat now writes the file instead of refusing.
    const mirrorRoot = join(workspace!, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", nodeId, mirrorRoot);
    const result = await runtime.handoff(session.id);

    assert.equal(result.handoff_path, `wip/sessions/${session.id}-handoff.md`);
    assert.equal(result.session.state, "suspended");
    assert.equal((await store.getSession(session.id))?.handoff_path, result.handoff_path);
    assert.equal(await readFile(join(mirrorRoot, result.handoff_path), "utf8"), inline);
    // The file is the handoff now; the inline copy is gone.
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null);
  });

  it("a suspended thread whose transcript is on another device is refused, naming the device", async () => {
    const { db, nodeId, store, runtime } = await withoutMirror([]);
    const mirrorRoot = join(workspace!, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", nodeId, mirrorRoot);
    const created = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "fake",
      instance_id: null,
      host_id: "druhy-mac",
    });
    await db.execute({ sql: "UPDATE sessions SET state = 'suspended' WHERE id = ?", args: [created.id] });

    await assert.rejects(
      () => runtime.handoff(created.id),
      (err: unknown) =>
        err instanceof SessionHandoffError &&
        err.code === "HANDOFF_TRANSCRIPT_ELSEWHERE" &&
        /druhy-mac/.test(err.message),
    );
    const after = await store.getSession(created.id);
    assert.equal(after?.state, "suspended");
    assert.equal(after?.handoff_path, null);
  });

  it("a suspended thread that ran here but whose content has not arrived is refused, writing nothing", async () => {
    const { db, nodeId, store, runtime } = await withoutMirror([]);
    const mirrorRoot = join(workspace!, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", nodeId, mirrorRoot);
    const created = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "fake",
      instance_id: null,
      host_id: null,
    });
    await db.execute({ sql: "UPDATE sessions SET state = 'suspended' WHERE id = ?", args: [created.id] });

    await assert.rejects(
      () => runtime.handoff(created.id),
      (err: unknown) => err instanceof SessionHandoffError && err.code === "HANDOFF_NO_CONTENT",
    );
    const after = await store.getSession(created.id);
    assert.equal(after?.state, "suspended");
    assert.equal(after?.handoff_path, null);
  });

  it("a thread whose run is live on another device is refused and stays running", async () => {
    const { nodeId, store, runtime } = await withoutMirror([]);
    const mirrorRoot = join(workspace!, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", nodeId, mirrorRoot);
    const created = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "fake",
      instance_id: null,
      host_id: "druhy-mac",
    });
    const run = await store.createRun({ session_id: created.id, runner: "fake", instance_id: null, host_id: "druhy-mac" });
    assert.equal((await store.getSession(created.id))?.state, "running");

    await assert.rejects(
      () => runtime.handoff(created.id),
      (err: unknown) =>
        err instanceof SessionHandoffError && err.code === "HANDOFF_RUN_ELSEWHERE" && /druhy-mac/.test(err.message),
    );
    assert.equal((await store.getSession(created.id))?.state, "running");
    const runs = await store.listRuns(created.id);
    assert.equal(runs.find((r) => r.id === run.id)?.ended_at, null);
  });
});

// #460 "Navázat na handoff": the other end of Předat -- a handoff file
// (written here or synced in from another machine) starts a NEW thread on
// this device. A personal workspace here; test/agent-router-sessions.test.ts
// runs the same body through the fake central server for a team workspace.
describe("session runtime: startFromHandoff (#460 Navázat na handoff)", () => {
  let workspace: string | null = null;

  afterEach(async () => {
    clearRegistryForTests();
    resetLocalDbForTests();
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = null;
  });

  // Thread A: started, then handed over, so its summary is a real file in
  // the node's mirror -- exactly what a file synced in from another machine
  // would look like here.
  async function handedOverThread() {
    const shared = await sharedDb();
    workspace = await mkdtemp(join(tmpdir(), "portuni-runtime-navazat-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    const mirrorRoot = join(workspace, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", shared.nodeId, mirrorRoot);
    const store = new DbSessionStore(shared.db);
    const source = createSessionRuntime({
      store,
      content,
      registry: registryOf(new FakeRunnerAdapter({ script: [{ wait: "message" }] })),
      provision: stubProvision(),
    });
    const { session } = await source.startTask({ userId: "U1", nodeId: shared.nodeId, brief: "x", runner: "fake" });
    const { handoff_path } = await source.handoff(session.id);
    return { ...shared, store, mirrorRoot, sourceId: session.id, handoffPath: handoff_path };
  }

  // The continuing thread runs under its own adapter: resolveTaskDefaults
  // reads the PROCESS registry (detectAll), so the adapter has to be
  // registered globally too, not only handed to this runtime.
  function continuingRuntime(store: DbSessionStore) {
    const { adapter, getRunStart } = capturingAdapter();
    registerAdapter(adapter);
    const runtime = createSessionRuntime({
      store,
      content,
      registry: registryOf(adapter),
      provision: stubProvision(),
    });
    return { runtime, getRunStart };
  }

  it("a file another thread wrote becomes a new thread's orientation; the source thread is untouched", async () => {
    const { nodeId, store, mirrorRoot, sourceId, handoffPath } = await handedOverThread();
    const fileContent = await readFile(join(mirrorRoot, handoffPath), "utf8");
    const sourceBefore = await store.getSession(sourceId);
    const sourceEventsBefore = await content.listEvents(sourceId);
    const { runtime, getRunStart } = continuingRuntime(store);

    const { session, run } = await runtime.startFromHandoff({ userId: "U1", nodeId, handoffPath });

    assert.notEqual(session.id, sourceId);
    assert.equal(session.node_id, nodeId);
    assert.equal(session.runner, "fake");
    // The name is the summary's own H1 title, and stays enrichable (the
    // user never typed it).
    assert.equal(session.name, sourceBefore!.name);
    assert.equal(session.name_is_custom, 0);

    const started = getRunStart();
    assert.equal(started?.runId, run.id);
    assert.equal(started?.brief, null);
    assert.ok(started!.orientation.includes(fileContent), "the file's content is the new run's orientation");
    assert.match(started!.orientation, /Navázání na handoff/);

    // No events are imported: the transcript starts here.
    const newEvents = await content.listEvents(session.id);
    assert.ok(newEvents.some((e) => e.kind === "run_started"));
    assert.ok(!newEvents.some((e) => e.kind === "user_message"));
    assert.equal(JSON.parse(newEvents[0].payload).resume, "handoff");

    // The source thread is untouched: same record, same transcript.
    const sourceAfter = await store.getSession(sourceId);
    assert.deepEqual(sourceAfter, sourceBefore);
    assert.deepEqual(await content.listEvents(sourceId), sourceEventsBefore);
  });

  it("a handoff file that is not on this device yet is refused and creates no record", async () => {
    const { db, nodeId, store } = await handedOverThread();
    const before = await db.execute("SELECT COUNT(*) AS n FROM sessions");
    const { runtime } = continuingRuntime(store);

    await assert.rejects(
      () =>
        runtime.startFromHandoff({
          userId: "U1",
          nodeId,
          handoffPath: "wip/sessions/01JNOTHERE-handoff.md",
        }),
      (err: unknown) =>
        err instanceof SessionHandoffError &&
        err.code === "HANDOFF_FILE_NOT_HERE" &&
        /ještě není na tomto zařízení/.test(err.message),
    );

    const after = await db.execute("SELECT COUNT(*) AS n FROM sessions");
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n));
  });

  it("a node with no mirror on this device is refused the same way", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const { runtime } = continuingRuntime(store);
    await assert.rejects(
      () => runtime.startFromHandoff({ userId: "U1", nodeId, handoffPath: "wip/sessions/01JX-handoff.md" }),
      (err: unknown) => err instanceof SessionHandoffError && err.code === "HANDOFF_FILE_NOT_HERE",
    );
  });

  it("a path outside wip/sessions is refused before anything is read", async () => {
    const { nodeId, store } = await handedOverThread();
    const { runtime } = continuingRuntime(store);
    await assert.rejects(
      () => runtime.startFromHandoff({ userId: "U1", nodeId, handoffPath: "wip/docs/secret.md" }),
      (err: unknown) => err instanceof SessionHandoffError && err.code === "HANDOFF_PATH_INVALID",
    );
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
    assert.equal(events.filter((e) => e.kind === "handoff").length, 1);
    await runtime.sendMessage(session.id, "still here");
    assert.equal((await store.listRuns(session.id)).length, 2);
    assert.deepEqual(userTexts(await content.listEvents(session.id)), ["x", "keep going", "still here"]);
  });
});
