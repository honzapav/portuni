// Session runtime (apps/server/domain/runner/session-runtime.ts): the only
// writer of runs and events. Fake adapter + DbSessionStore on a temp
// libsql :memory: DB, the pattern from test/api-sessions.test.ts for DB
// setup (via test/helpers/shared-db.ts's makeSharedDb).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import {
  createSessionRuntime,
  resolveModelAndEffort,
} from "../apps/server/domain/runner/session-runtime.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { createInstance, instanceClaudeConfigDir, setOrgDefault } from "../apps/server/domain/runner/instances.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import type { RunnerAdapter, RunHandle, RunStart } from "../apps/server/domain/runner/types.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { claudeProjectSlug } from "../apps/server/domain/session-handoff.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";

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

// #498: Uzavřít is "done, off the active lists", not "never again" --
// writing into a closed thread reopens it the way it reopens a suspended
// one: the same history, the conversation when it still exists, else a
// summary from this device's transcript.
describe("session runtime: writing into a closed thread reopens it (#498)", () => {
  it("resumes the conversation when its transcript still exists", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const dir = await mkdtemp(join(tmpdir(), "portuni-closed-resume-"));
    const previousDataDir = process.env.PORTUNI_DATA_DIR;
    process.env.PORTUNI_DATA_DIR = join(dir, "data");
    try {
      const configDir = join(dir, "claude-profile");
      const cwd = join(dir, "mirror");
      const instance = await createInstance({ name: "JRD", runner: "fake", env: { CLAUDE_CONFIG_DIR: configDir } });
      await mkdir(join(configDir, "projects", claudeProjectSlug(cwd)), { recursive: true });
      await writeFile(join(configDir, "projects", claudeProjectSlug(cwd), "conv-closed.jsonl"), "{}\n", "utf8");

      const adapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }], agentSessionId: "conv-closed" });
      const runtime = createSessionRuntime({
        store,
        content,
        registry: registryOf(adapter),
        provision: stubProvision({ cwd, mirrors: [cwd] }),
      });
      const { session, run: firstRun } = await runtime.startTask({
        userId: "U1",
        nodeId,
        brief: "x",
        runner: "fake",
        instanceId: instance.id,
      });
      await db.execute({ sql: "UPDATE sessions SET cli = 'claude' WHERE id = ?", args: [session.id] });
      await runtime.closeSession(session.id);
      assert.equal((await store.getSession(session.id))?.state, "closed");

      const frames: Array<{ from: unknown; to: unknown }> = [];
      runtime.subscribe(session.id, (_id, event) => {
        if ("kind" in event && event.kind === "state_changed") frames.push({ from: event.payload.from, to: event.payload.to });
      });
      await runtime.sendMessage(session.id, "ještě jedna věc");

      const row = await store.getSession(session.id);
      assert.equal(row?.state, "running");
      assert.equal(row?.closed_at, null);
      const runs = await store.listRuns(session.id);
      assert.equal(runs.length, 2);
      assert.equal(runs[1].resumed_from_run_id, firstRun.id);
      assert.equal(runs[1].agent_session_id, "conv-closed", "the new run continues the same conversation");
      assert.deepEqual(adapter.getLastRunStart()?.resume, { agentSessionId: "conv-closed" });
      assert.deepEqual(frames, [{ from: "closed", to: "running" }]);
      const events = await content.listEvents(session.id);
      const started = events.find((e) => e.run_id === runs[1].id && e.kind === "run_started");
      assert.equal(JSON.parse(started!.payload).resume, "conversation");
      assert.ok(
        events.some((e) => e.run_id === runs[1].id && e.kind === "user_message" && JSON.parse(e.payload).text === "ještě jedna věc"),
      );
    } finally {
      if (previousDataDir === undefined) delete process.env.PORTUNI_DATA_DIR;
      else process.env.PORTUNI_DATA_DIR = previousDataDir;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("without the conversation starts from a summary of this device's transcript", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "první zadání", runner: "fake" });
    await runtime.closeSession(session.id);

    await runtime.sendMessage(session.id, "pokračuj");

    assert.equal((await store.getSession(session.id))?.state, "running");
    assert.equal((await store.listRuns(session.id)).length, 2);
    const start = adapter.getLastRunStart();
    assert.equal(start?.resume, null);
    assert.match(start?.orientation ?? "", /Předání \(obnovení ze shrnutí\)/);
    assert.match(start?.orientation ?? "", /\*\*Uživatel:\*\* první zadání/);
    assert.equal(start?.brief, "pokračuj");
  });

  it("an archived thread still has no composer: the message is refused", async () => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [TURN_DONE, { wait: "message" }] });
    const runtime = createSessionRuntime({ store, content, registry: registryOf(adapter), provision: stubProvision() });
    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    await runtime.closeSession(session.id);
    await store.patchSession(session.id, { state: "archived" });

    await assert.rejects(runtime.sendMessage(session.id, "haló"), /has no live run/);
    assert.equal((await store.listRuns(session.id)).length, 1);
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

describe("session runtime: continueSession when the handoff file cannot be written", () => {
  it("closes the old thread and seeds the new one with the summary inline", async (t) => {
    const { db, nodeId } = await sharedDb();
    const store = new DbSessionStore(db);
    const adapter = new FakeRunnerAdapter({ script: [{ wait: "message" }] });
    const runtime = createSessionRuntime({
      store,
      content,
      registry: registryOf(adapter),
      provision: stubProvision(),
      handoffs: {
        summarize: async () => "# Shrnutí vlákna\n\nCo se udělalo.",
        writeFile: async () => {
          throw new Error("EROFS: read-only file system");
        },
      },
    });
    t.mock.method(console, "error", () => undefined);

    const { session } = await runtime.startTask({ userId: "U1", nodeId, brief: "x", runner: "fake" });
    const { session: next } = await runtime.continueSession(session.id);

    const old = await store.getSession(session.id);
    assert.equal(old?.state, "closed");
    assert.equal(old?.handoff_path, null);
    assert.equal(next.state, "running");
    assert.match(adapter.getLastRunStart()?.orientation ?? "", /Co se udělalo\./);
    await runtime.closeSession(next.id);
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
