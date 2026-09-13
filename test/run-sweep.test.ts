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
import { sweepOrphanedRuns } from "../apps/server/domain/runner/run-sweep.js";
import { writePidFile, readPidFile } from "../apps/server/domain/runner/pid-file.js";
import { isProcessAlive } from "../apps/server/domain/runner/process-liveness.js";
import { getSession } from "../apps/server/domain/sessions.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";

afterEach(() => {
  setDbForTesting(null);
});

async function sharedDb(): Promise<SharedDb> {
  const shared = await makeSharedDb();
  setDbForTesting(shared.db);
  return shared;
}

async function startSessionAndRun(db: SharedDb["db"]) {
  const store = new DbSessionStore(db);
  const session = await store.createSession({
    node_id: null,
    user_id: "U1",
    brief: "Fix the bug",
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
  it("kills the orphaned child, marks the run host_lost, and suspends the session with a handoff event", async () => {
    const shared = await sharedDb();
    const dataDir = await mkdtemp(join(tmpdir(), "portuni-run-sweep-"));
    const { store, session, run } = await startSessionAndRun(shared.db);
    const child = await spawnSleeper();
    await writePidFile(dataDir, run.id, child.pid!);

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

    const events = await store.listEvents(session.id);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["run_ended", "handoff"],
    );
    const handoffPayload = JSON.parse(events[1].payload);
    assert.equal(handoffPayload.generated_by, "server");

    assert.equal(await readPidFile(join(dataDir, "runs", `${run.id}.pid`)), null);
  });

  it("removes the pid file without touching the session when the run already ended", async () => {
    const shared = await sharedDb();
    const dataDir = await mkdtemp(join(tmpdir(), "portuni-run-sweep-"));
    const { store, session, run } = await startSessionAndRun(shared.db);
    await store.patchRun(run.id, { ended_at: new Date().toISOString(), end_reason: "completed" });
    await writePidFile(dataDir, run.id, 999_999_999);

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
    await writePidFile(dataDir, run.id, 999_999_999);

    const result = await sweepOrphanedRuns(shared.db, dataDir, { sigtermGraceMs: 10 });

    assert.equal(result.killed, 0);
    assert.equal(result.cleaned, 1);

    const endedRun = (await store.listRuns(session.id))[0];
    assert.equal(endedRun.end_reason, "host_lost");

    const suspended = await getSession(shared.db, session.id);
    assert.equal(suspended?.state, "suspended");
  });
});
