// Session runtime (apps/server/domain/runner/session-runtime.ts): the only
// writer of runs and events. Fake adapter + DbSessionStore on a temp
// libsql :memory: DB, the pattern from test/api-sessions.test.ts for DB
// setup (via test/helpers/shared-db.ts's makeSharedDb).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, setDbForTesting } from "../apps/server/infra/db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import {
  SessionHandoffError,
  createSessionRuntime,
  resolveModelAndEffort,
} from "../apps/server/domain/runner/session-runtime.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { createInstance, instanceClaudeConfigDir, setOrgDefault } from "../apps/server/domain/runner/instances.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import type { CanonicalEvent, RunnerAdapter, RunHandle, RunStart } from "../apps/server/domain/runner/types.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import {
  claudeProjectSlug,
  createSuspendServerSide,
  localSuspendDeps,
} from "../apps/server/domain/session-handoff.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { RunnerMcpTokenMissingError } from "../apps/server/domain/write-scope.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";
import { GatedAdapter } from "./helpers/gated-adapter.js";
import { TeardownAdapter } from "./helpers/teardown-adapter.js";

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
        // the suspend path -- the transition the suspend made (#494), and
        // no handoff event: only Předat writes a summary (#497).
        [4, "state_changed"],
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

    // The waiting transitions only; the run's end adds running -> suspended (#494).
    const stateChanged = events
      .filter((e) => e.kind === "state_changed")
      .map((e) => JSON.parse(e.payload))
      .filter((s) => s.to === "running");
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
  it("a run that ends on its own (nobody closed it) suspends the session and writes no summary (#497)", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    // An empty script auto-completes right away -- nobody called close(),
    // so this is exactly "a run ended other than by Uzavřít".
    const adapter = new FakeRunnerAdapter({ script: [] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "suspended");
    assert.equal(row?.handoff_path, null, "no handoff file is recorded");
    assert.equal(row?.handoff_hash, null);
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null, "no inline summary either");

    const runs = await store.listRuns(session.id);
    // The adapter itself reports "completed" (a graceful close it can't
    // explain); withSuspendReason rewrites it since this wasn't an
    // explicit close.
    assert.equal(runs[0].end_reason, "suspended");

    const events = await content.listEvents(session.id);
    assert.equal(events.some((e) => e.kind === "handoff"), false, "no handoff event: only Předat writes one");
    assert.equal(events.at(-1)?.kind, "state_changed");
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
    // #497: the idle suspend is a record flip only.
    assert.equal(row?.handoff_path, null);
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null);
    assert.equal((await content.listEvents(session.id)).some((e) => e.kind === "handoff"), false);
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
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null, "no summary is written (#497)");

    const runs = await store.listRuns(session.id);
    // withSuspendReason leaves an adapter-reported limit alone -- that IS
    // the informative reason.
    assert.equal(runs[0].end_reason, "limit");

    const events = await content.listEvents(session.id);
    const error = events.find((e) => e.kind === "error");
    assert.ok(error, "the provider message must be in the transcript");
    assert.equal(JSON.parse(error!.payload).class, "provider");
    assert.match(JSON.parse(error!.payload).message, /spend limit/);
    assert.equal(events.some((e) => e.kind === "handoff"), false, "no handoff event (#497)");
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

  // #508: the resume under a profile when `sessions.cli` was never filled
  // in -- the run's own MCP handshake is what writes it, and a run whose
  // Portuni connection failed (#507) never did. The runner that wrote the
  // transcript is the last run's, so a "claude" runner is enough.
  async function profileResume(opts: { transcript: boolean }) {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const dir = await mkdtemp(join(tmpdir(), "portuni-profile-resume-"));
    const previousDataDir = process.env.PORTUNI_DATA_DIR;
    process.env.PORTUNI_DATA_DIR = join(dir, "data");
    try {
      // Outside ~/.claude on purpose: the default location has nothing.
      const configDir = join(dir, "claude-tempo");
      const cwd = join(dir, "mirror");
      const instance = await createInstance({ name: "Tempo", runner: "claude", env: { CLAUDE_CONFIG_DIR: configDir } });
      if (opts.transcript) {
        await mkdir(join(configDir, "projects", claudeProjectSlug(cwd)), { recursive: true });
        await writeFile(join(configDir, "projects", claudeProjectSlug(cwd), "conv-tempo.jsonl"), "{}\n", "utf8");
      }
      const fake = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }], agentSessionId: "conv-tempo" });
      // The fake adapter under the claude runner's id.
      const claude: RunnerAdapter = {
        id: "claude",
        detect: () => fake.detect(),
        start: (run, sink) => fake.start(run, sink),
        models: () => fake.models(),
      };
      const runtime = createSessionRuntime({
        store,
        content,
        registry: registryOf(claude),
        provision: stubProvision({ cwd, mirrors: [cwd] }),
      });
      const { session } = await runtime.startTask({
        userId: "U1",
        nodeId,
        brief: "zadání",
        runner: "claude",
        instanceId: instance.id,
      });
      assert.equal((await store.getSession(session.id))?.cli ?? null, null, "no handshake ever named the CLI");
      await runtime.checkIdleRunsOnce(0, Date.now() + 1);
      assert.equal((await store.getSession(session.id))?.state, "suspended");

      await runtime.sendMessage(session.id, "pokračuj");

      const runs = await store.listRuns(session.id);
      const events = await content.listEvents(session.id);
      const started = events.find((e) => e.run_id === runs[1]?.id && e.kind === "run_started");
      return { runs, lastStart: fake.getLastRunStart(), resumeMode: JSON.parse(started!.payload).resume };
    } finally {
      if (previousDataDir === undefined) delete process.env.PORTUNI_DATA_DIR;
      else process.env.PORTUNI_DATA_DIR = previousDataDir;
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("a resume finds the transcript in the instance's CLAUDE_CONFIG_DIR with no cli on the record (#508)", async () => {
    const { runs, lastStart, resumeMode } = await profileResume({ transcript: true });
    assert.equal(runs.length, 2);
    assert.deepEqual(lastStart?.resume, { agentSessionId: "conv-tempo" });
    assert.equal(runs[1].agent_session_id, "conv-tempo", "the new run continues the same conversation");
    assert.equal(resumeMode, "conversation");
  });

  it("a resume with no transcript anywhere starts from the summary (#508)", async () => {
    const { runs, lastStart, resumeMode } = await profileResume({ transcript: false });
    assert.equal(runs.length, 2);
    assert.equal(lastStart?.resume, null);
    assert.match(lastStart?.orientation ?? "", /Předání \(obnovení ze shrnutí\)/);
    assert.equal(resumeMode, "handoff");
  });

  it("a resume without the conversation gets a summary built from the transcript then (#497)", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);

    // First run: a real FakeRunnerAdapter so startTask/checkIdleRunsOnce
    // can drive it through a normal suspend -- which writes no summary.
    const firstAdapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const registry = { getAdapter: (id: string) => (id === "fake" ? firstAdapter : null) };
    const runtime = createSessionRuntime({ store, content, registry, provision: stubProvision() });
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(0, Date.now() + 1);
    const suspended = await store.getSession(session.id);
    assert.equal(suspended?.state, "suspended");
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null);
    assert.equal(suspended?.handoff_path, null);

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
    // Built from this device's transcript at resume: the first run's brief.
    assert.match(capturedOrientation!, /\*\*Uživatel:\*\* x/);
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null, "and nothing is stored");
  });
});

describe("instanceClaudeConfigDir (#508)", () => {
  it("is the instance's CLAUDE_CONFIG_DIR, and null for none or a blank one", () => {
    assert.equal(instanceClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/Users/x/.claude-tempo" }), "/Users/x/.claude-tempo");
    assert.equal(instanceClaudeConfigDir({}), null);
    assert.equal(instanceClaudeConfigDir({ CLAUDE_CONFIG_DIR: "  " }), null);
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
    // The waiting transitions only; the run's end adds running -> suspended (#494).
    const stateChanged = events
      .filter((e) => e.kind === "state_changed")
      .map((e) => JSON.parse(e.payload))
      .filter((s) => s.to === "running");
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
    // Suspended by the idle sweep: no summary anywhere (#497).
    await runtime.checkIdleRunsOnce(-1);
    const suspended = await store.getSession(session.id);
    assert.equal(suspended?.state, "suspended");
    assert.equal(suspended?.handoff_path, null);
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null);

    // The mirror arrives; Předat now writes the file instead of refusing.
    const mirrorRoot = join(workspace!, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", nodeId, mirrorRoot);
    const result = await runtime.handoff(session.id);

    assert.equal(result.handoff_path, `wip/sessions/${session.id}-handoff.md`);
    assert.equal(result.session.state, "suspended");
    assert.equal((await store.getSession(session.id))?.handoff_path, result.handoff_path);
    // Built from the transcript now, by Předat.
    const onDisk = await readFile(join(mirrorRoot, result.handoff_path), "utf8");
    const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");
    assert.equal(parseServerHandoffReason(onDisk), "handoff");
    assert.match(onDisk, /\*\*Uživatel:\*\* x/);
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null);
  });

  // #497: nothing refreshes handoff_inline at suspend any more, so an inline
  // summary on the device can be older than the transcript. Předat builds
  // the file from the transcript whenever it is here.
  it("Předat on a suspended thread builds the file from the transcript, not from an older inline summary", async () => {
    const { nodeId, runtime } = await withoutMirror([TURN_DONE, { wait: "message" }]);
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(-1);
    await content.setContent(session.id, { handoff_inline: "# Staré shrnutí\n\nZ doby před další prací." });

    const mirrorRoot = join(workspace!, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", nodeId, mirrorRoot);
    const result = await runtime.handoff(session.id);

    const onDisk = await readFile(join(mirrorRoot, result.handoff_path), "utf8");
    assert.doesNotMatch(onDisk, /Staré shrnutí/);
    assert.match(onDisk, /\*\*Uživatel:\*\* x/);
  });

  it("an idle suspend with a mirror here writes no file, tracks nothing and appends no handoff event (#497)", async () => {
    const { db, nodeId, store, runtime, mirrorRoot } = await withMirror([TURN_DONE, { wait: "message" }]);
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.checkIdleRunsOnce(-1);

    const row = await store.getSession(session.id);
    assert.equal(row?.state, "suspended");
    assert.equal(row?.handoff_path, null);
    assert.equal(row?.handoff_hash, null);
    await assert.rejects(() => readFile(join(mirrorRoot, `wip/sessions/${session.id}-handoff.md`), "utf8"));
    const files = await db.execute({ sql: "SELECT filename FROM files WHERE node_id = ?", args: [nodeId] });
    assert.equal(files.rows.length, 0, "nothing registered in the node");
    const kinds = (await content.listEvents(session.id)).map((e) => e.kind);
    assert.equal(kinds.includes("handoff"), false);
    assert.equal((await content.getContent(session.id))?.handoff_inline ?? null, null);
  });

  it("an idle suspend after an earlier Předat drops the stale handoff from the record (#497)", async () => {
    const { nodeId, store, runtime } = await withMirror([TURN_DONE, { wait: "message" }]);
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.handoff(session.id);
    assert.ok((await store.getSession(session.id))?.handoff_path);

    // Resumed, then left alone: the record no longer points at the file the
    // transcript has since outgrown.
    await runtime.sendMessage(session.id, "dál");
    await runtime.checkIdleRunsOnce(-1);
    const row = await store.getSession(session.id);
    assert.equal(row?.state, "suspended");
    assert.equal(row?.handoff_path, null);
  });

  it("Pokračovat v nové session writes the old thread's handoff file and the new orientation points at it (#497)", async () => {
    const shared = await sharedDb();
    workspace = await mkdtemp(join(tmpdir(), "portuni-runtime-handoff-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    const mirrorRoot = join(workspace, "mirror");
    await mkdir(mirrorRoot, { recursive: true });
    await registerMirror("U1", shared.nodeId, mirrorRoot);
    const store = new DbSessionStore(shared.db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });

    const { session: oldSession } = await runtime.startTask({
      userId: "U1",
      nodeId: shared.nodeId,
      brief: "the old task",
      runner: "fake",
    });
    const { session: newSession } = await runtime.continueSession(oldSession.id);

    const relPath = `wip/sessions/${oldSession.id}-handoff.md`;
    const oldRow = await store.getSession(oldSession.id);
    assert.equal(oldRow?.state, "closed");
    assert.equal(oldRow?.handoff_path, relPath);
    const onDisk = await readFile(join(mirrorRoot, relPath), "utf8");
    const { parseServerHandoffReason } = await import("../apps/server/domain/session-handoff.js");
    assert.equal(parseServerHandoffReason(onDisk), "continue");
    assert.match(onDisk, /the old task/);
    const files = await shared.db.execute({
      sql: "SELECT filename FROM files WHERE node_id = ?",
      args: [shared.nodeId],
    });
    assert.deepEqual(
      files.rows.map((r) => String(r.filename)),
      [`${oldSession.id}-handoff.md`],
    );

    const orientation = adapter.getLastRunStart()?.orientation ?? "";
    assert.match(orientation, /Pokračování z předchozí session/);
    assert.ok(orientation.includes(`(\`${relPath}\`)`), "the new thread's orientation names the file");
    assert.ok(orientation.includes(onDisk), "and carries its content");
    await runtime.closeSession(newSession.id);
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
