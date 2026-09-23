// Boot orphaned-run sweep (apps/server/domain/runner/run-sweep.ts, #325).
// DbSessionStore + a :memory: libsql db, the pattern from
// test/runner-runtime.test.ts. Real child processes (spawned via
// node:child_process) stand in for "an orphaned claude process" -- the
// `execFile`/`isAlive`/`sleep` deps are overridden so the test controls
// exactly what "looks like claude" and never waits out the real 5s grace.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import {
  centralRunSweepBackend,
  isOurChild,
  parseProcessIdentity,
  sweepOrphanedRuns,
  sweepOrphanedRunsOn,
} from "../apps/server/domain/runner/run-sweep.js";
import { writePidFile, readPidFile } from "../apps/server/domain/runner/pid-file.js";
import { isProcessAlive } from "../apps/server/domain/runner/process-liveness.js";
import { getSession } from "../apps/server/domain/sessions.js";
import { CentralSessionStore } from "../apps/server/domain/runner/store-central.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { PatchRunInput, PatchSessionInput } from "../apps/server/domain/runner/store.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";
import type { SessionContentStore } from "../apps/server/domain/runner/store-content.js";

afterEach(() => {
  setDbForTesting(null);
  clearTestContentDb();
});

// #456: the run_ended and handoff events the sweep appends are content and
// land in this device's content.db, not on the record.
let content: SessionContentStore;

async function sharedDb(): Promise<SharedDb> {
  const shared = await makeSharedDb();
  setDbForTesting(shared.db);
  content = (await installTestContentDb()).content;
  return shared;
}

// The record half of a team workspace: a CentralClient whose reads and
// writes go to the test's own db (standing in for the central server's
// graph db) and which REFUSES anything content-shaped -- the central server
// has no transcript, no brief and no summary after #456/#458.
class FakeCentralRecords {
  readonly patches: Array<[string, PatchSessionInput]> = [];
  readonly summaries: string[] = [];
  readonly client: CentralClient;

  constructor(db: SharedDb["db"]) {
    const store = new DbSessionStore(db);
    this.client = {
      getSessionRecord: (id: string) => store.getSession(id),
      patchSessionRecord: (id: string, patch: PatchSessionInput) => {
        const carried = patch as { brief?: unknown; handoff_inline?: unknown };
        if (carried.brief !== undefined || carried.handoff_inline !== undefined) {
          this.summaries.push(id);
          throw new Error("the central server must never receive session content");
        }
        this.patches.push([id, patch]);
        return store.patchSession(id, patch);
      },
      listSessionRuns: (sessionId: string) => store.listRuns(sessionId),
      patchSessionRun: (_sessionId: string, runId: string, patch: PatchRunInput) => store.patchRun(runId, patch),
    } as unknown as CentralClient;
  }
}

async function startSessionAndRun(db: SharedDb["db"]) {
  const store = new DbSessionStore(db);
  const session = await store.createSession({
    node_id: null,
    user_id: "U1",
    runner: "claude",
    instance_id: null,
    host_id: null,
  });
  const run = await store.createRun({ session_id: session.id, runner: "claude", instance_id: null, host_id: null });
  return { store, session, run };
}

function spawnSleeper(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("sleep", ["300"]);
    child.once("error", reject);
    child.once("spawn", () => resolve(child));
  });
}

describe("sweepOrphanedRuns (#325)", () => {
  it("kills the orphaned child, marks the run host_lost, and suspends the session with no handoff", async () => {
    const shared = await sharedDb();
    const dataDir = await mkdtemp(join(tmpdir(), "portuni-run-sweep-"));
    const { store, session, run } = await startSessionAndRun(shared.db);
    const child = await spawnSleeper();
    await writePidFile(dataDir, run.id, child.pid!, session.id);

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    // The real "ps -o command=" for a plain "sleep 300" never contains
    // "claude" -- fake the check so the test doesn't depend on renaming the
    // spawned process to prove the sweep's kill path.
    const fakeExecFile = ((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
      cb(null, "claude");
    }) as unknown as typeof import("node:child_process").execFile;

    const result = await sweepOrphanedRuns(shared.db, dataDir, {
      execFile: fakeExecFile,
      sigtermGraceMs: 20,
    });

    assert.equal(result.killed, 1);
    assert.equal(result.cleaned, 1);
    await exited;
    assert.equal(isProcessAlive(child.pid!), false);

    const endedRun = (await store.listRuns(session.id))[0];
    assert.equal(endedRun.end_reason, "host_lost");
    assert.ok(endedRun.ended_at);

    const suspended = await getSession(shared.db, session.id);
    assert.equal(suspended?.state, "suspended");
    // #458: the process that could have summarised this run is the one that
    // died -- the sweep suspends the record and writes no handoff at all.
    assert.equal(suspended?.handoff_path, null);
    assert.equal(suspended?.handoff_hash, null);

    const events = await content.listEvents(session.id);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["run_ended"],
    );

    assert.equal(await readPidFile(join(dataDir, "runs", `${run.id}.pid`)), null);
  });

  it("removes the pid file without touching the session when the run already ended", async () => {
    const shared = await sharedDb();
    const dataDir = await mkdtemp(join(tmpdir(), "portuni-run-sweep-"));
    const { store, session, run } = await startSessionAndRun(shared.db);
    await store.patchRun(run.id, { ended_at: new Date().toISOString(), end_reason: "completed" });
    await writePidFile(dataDir, run.id, 999_999_999, session.id);

    const result = await sweepOrphanedRuns(shared.db, dataDir);

    assert.equal(result.staleFilesRemoved, 1);
    assert.equal(result.cleaned, 0);
    assert.equal(result.killed, 0);
    assert.equal(await readPidFile(join(dataDir, "runs", `${run.id}.pid`)), null);
    const untouched = await getSession(shared.db, session.id);
    assert.equal(untouched?.state, "running");
  });

  it("closes the run without signaling anything when the pid does not exist", async () => {
    const shared = await sharedDb();
    const dataDir = await mkdtemp(join(tmpdir(), "portuni-run-sweep-"));
    const { store, session, run } = await startSessionAndRun(shared.db);
    await writePidFile(dataDir, run.id, 999_999_999, session.id);

    const result = await sweepOrphanedRuns(shared.db, dataDir, { sigtermGraceMs: 10 });

    assert.equal(result.killed, 0);
    assert.equal(result.cleaned, 1);

    const endedRun = (await store.listRuns(session.id))[0];
    assert.equal(endedRun.end_reason, "host_lost");

    const suspended = await getSession(shared.db, session.id);
    assert.equal(suspended?.state, "suspended");
  });
});

describe("run sweep: pid identity (a reused pid is never killed)", () => {
  it("parses ps's lstart + command row", () => {
    const id = parseProcessIdentity("Sat Sep 13 20:15:03 2026 /usr/local/bin/claude --print\n");
    assert.equal(id.commandLine, "/usr/local/bin/claude --print");
    assert.equal(id.startedAt?.getFullYear(), 2026);
    // No parseable stamp: the whole row is the command line, start unknown.
    const bare = parseProcessIdentity("claude");
    assert.equal(bare.startedAt, null);
    assert.equal(bare.commandLine, "claude");
  });

  it("a claude process that started AFTER the pid file was written is someone else's", () => {
    const fileWritten = "2026-09-13T18:15:03.000Z";
    assert.equal(isOurChild({ commandLine: "claude", startedAt: new Date("2026-09-13T18:15:02.000Z") }, fileWritten), true);
    assert.equal(isOurChild({ commandLine: "claude", startedAt: new Date("2026-09-13T18:20:00.000Z") }, fileWritten), false);
    assert.equal(isOurChild({ commandLine: "sleep 300", startedAt: new Date("2026-09-13T18:15:02.000Z") }, fileWritten), false);
    assert.equal(isOurChild({ commandLine: "claude", startedAt: null }, fileWritten), true);
    assert.equal(isOurChild(null, fileWritten), false);
  });

  it("leaves a live pid alone when ps says it started after the pid file, and still closes the run", async () => {
    const shared = await sharedDb();
    const dataDir = await mkdtemp(join(tmpdir(), "portuni-run-sweep-"));
    const { store, session, run } = await startSessionAndRun(shared.db);
    const child = await spawnSleeper();
    await writePidFile(dataDir, run.id, child.pid!, session.id);
    // ps reports a claude process that started well after the file: a
    // reused pid, e.g. the user's own interactive Claude Code.
    const later = new Date(Date.now() + 60_000);
    const fakeExecFile = ((_cmd: string, _args: string[], cb: (err: Error | null, stdout: string) => void) => {
      // Real lstart shape: "Sat Sep 13 20:15:03 2026".
      const d = later.toDateString().split(" ");
      cb(null, `${d[0]} ${d[1]} ${d[2]} ${later.toTimeString().slice(0, 8)} ${d[3]} claude`);
    }) as unknown as typeof import("node:child_process").execFile;

    const result = await sweepOrphanedRuns(shared.db, dataDir, { execFile: fakeExecFile, sigtermGraceMs: 10 });
    assert.equal(result.killed, 0);
    assert.equal(result.cleaned, 1);
    assert.equal(isProcessAlive(child.pid!), true, "a reused pid must not be signalled");
    child.kill("SIGKILL");
    const endedRun = (await store.listRuns(session.id))[0];
    assert.equal(endedRun.end_reason, "host_lost");
  });
});

// #393: the same pid files are left behind by a central-mode sidecar, which
// has no graph db at all -- the run and session records live on central and
// are reached through the SessionStore. The backend is the only difference;
// the killing, the run_ended event and the suspend are the same code.
//
// #458: the fake CentralClient below is the proof that nothing content-
// shaped reaches the central server -- it refuses a record patch carrying a
// summary, and there is no central summary fallback left to write one. The
// transcript (run_ended) lands in this device's content.db.
describe("sweepOrphanedRuns in central mode (#393, #458)", () => {
  it("marks the run host_lost, suspends the record with no handoff and keeps the transcript local", async () => {
    const shared = await sharedDb();
    const dataDir = await mkdtemp(join(tmpdir(), "portuni-run-sweep-central-"));
    const { store: localStore, session, run } = await startSessionAndRun(shared.db);
    await writePidFile(dataDir, run.id, 999_999_999, session.id);

    const central = new FakeCentralRecords(shared.db);
    const store = new CentralSessionStore(central.client);
    const result = await sweepOrphanedRunsOn(centralRunSweepBackend(store, content), dataDir, {
      isAlive: () => false,
    });
    assert.equal(result.cleaned, 1);
    assert.equal(result.killed, 0);

    // The record half went to central: the run is host_lost, the session is
    // suspended, and no summary rode along with either patch.
    const patched = central.patches.find(([id]) => id === session.id);
    assert.ok(patched, "the record patch must go to the central server");
    assert.equal(patched![1].state, "suspended");
    assert.equal(patched![1].handoff_path, undefined, "a lost device leaves no handoff");
    assert.deepEqual(central.summaries, [], "the central server never receives a summary");

    const runs = await localStore.listRuns(session.id);
    assert.equal(runs[0].end_reason, "host_lost");
    assert.notEqual(runs[0].ended_at, null);
    const suspended = await getSession(shared.db, session.id);
    assert.equal(suspended?.state, "suspended");
    assert.equal(suspended?.handoff_path, null);

    // The transcript is this device's, in content.db.
    const events = await content.listEvents(session.id);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["run_ended"],
    );
    assert.equal(JSON.parse(events[0].payload).reason, "host_lost");
    assert.equal(await readPidFile(join(dataDir, "runs", `${run.id}.pid`)), null);
  });

  it("removes a pid file that names no session, since there is nothing to resolve it from", async () => {
    const shared = await sharedDb();
    const dataDir = await mkdtemp(join(tmpdir(), "portuni-run-sweep-legacy-"));
    const { store, session, run } = await startSessionAndRun(shared.db);
    // A file written before the session id was recorded (#393).
    await writePidFile(dataDir, run.id, 999_999_999, session.id);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dataDir, "runs", `${run.id}.pid`),
      JSON.stringify({ pid: 999_999_999, started_at: new Date().toISOString() }),
      "utf8",
    );

    const central = new FakeCentralRecords(shared.db);
    const backend = centralRunSweepBackend(new CentralSessionStore(central.client), content);
    const result = await sweepOrphanedRunsOn(backend, dataDir, { isAlive: () => false });
    assert.equal(result.cleaned, 0);
    assert.equal(result.staleFilesRemoved, 0);
    assert.equal(await readPidFile(join(dataDir, "runs", `${run.id}.pid`)), null);

    // The run is untouched -- this path removes the file, nothing else.
    const runs = await store.listRuns(session.id);
    assert.equal(runs[0].ended_at, null);
  });
});
