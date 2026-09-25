// Session runtime: Předat (#459) and Navázat na handoff (#460) in a
// personal workspace. Split from runner-runtime.test.ts so each file stays
// inside the per-file test timeout on the slower PGlite driver. Same setup:
// fake adapters + DbSessionStore on a shared in-memory db, and a real mirror
// in a temp workspace where the handoff file needs one.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { SessionHandoffError, createSessionRuntime } from "../apps/server/domain/runner/session-runtime.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import type { RunHandle, RunStart, RunnerAdapter } from "../apps/server/domain/runner/types.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";

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

// A bespoke adapter (not FakeRunnerAdapter) that captures the RunStart
// session-runtime.ts actually handed it.
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

// The first turn is over and the run waits for the next message.
const TURN_DONE: FakeScriptStep = { kind: "turn_ended", payload: { run_id: "fake" } };

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

  // #497 item 4: a resume with no conversation, no Předat file, no
  // transcript and no content here gives the same refusals Předat does,
  // before any run is created.
  it("writing into a suspended thread whose transcript is on another device is refused, naming the device", async () => {
    const { db, nodeId, store, runtime } = await withoutMirror([{ wait: "message" }]);
    const created = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "fake",
      instance_id: null,
      host_id: "druhy-mac",
    });
    await db.execute({ sql: "UPDATE sessions SET state = 'suspended' WHERE id = ?", args: [created.id] });

    await assert.rejects(
      () => runtime.sendMessage(created.id, "pokračuj"),
      (err: unknown) =>
        err instanceof SessionHandoffError &&
        err.code === "HANDOFF_TRANSCRIPT_ELSEWHERE" &&
        /druhy-mac/.test(err.message),
    );
    assert.equal((await store.getSession(created.id))?.state, "suspended");
    assert.equal((await store.listRuns(created.id)).length, 0);
    assert.equal((await content.listEvents(created.id)).length, 0);
  });

  it("writing into a suspended thread that ran here but whose content has not arrived is refused", async () => {
    const { db, nodeId, store, runtime } = await withoutMirror([{ wait: "message" }]);
    const created = await store.createSession({
      node_id: nodeId,
      user_id: "U1",
      runner: "fake",
      instance_id: null,
      host_id: null,
    });
    await db.execute({ sql: "UPDATE sessions SET state = 'suspended' WHERE id = ?", args: [created.id] });

    await assert.rejects(
      () => runtime.sendMessage(created.id, "pokračuj"),
      (err: unknown) => err instanceof SessionHandoffError && err.code === "HANDOFF_NO_CONTENT",
    );
    assert.equal((await store.listRuns(created.id)).length, 0);
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
