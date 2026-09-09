// Background sync job (#273): POST /sync/jobs starts a multi-node sync run
// that survives the caller not waiting on it (the whole point -- "Synchronizovat
// vše" no longer blocks a client-side loop); GET /sync/jobs/:id and
// GET /sync/jobs/current poll its progress.

process.env.PORT = "14934";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { startSyncJob, getSyncJob, getCurrentSyncJob } from "../apps/server/domain/sync/sync-jobs.js";
import { runNodeSync } from "../apps/server/domain/sync/sync-run.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";
import type { Client } from "@libsql/client";
import type { SyncRunResponse } from "../apps/server/shared/api-types.js";

// The domain-level tests below drive startSyncJob directly (not through the
// REST handler), so they supply the same runNode callback
// handleStartSyncJob wires up for local mode.
function runNodeFor(db: Client) {
  return (nodeId: string) => runNodeSync(db, { userId: SOLO_USER, nodeId });
}

const BASE = "http://127.0.0.1:14934";

let handle: HttpServerHandle;
let workspace: string;

before(async () => {
  handle = startHttpServer({ port: 14934, host: "127.0.0.1", registerSigint: false });
  await new Promise((res) => setImmediate(res));
});

after(async () => {
  await handle.shutdown();
});

beforeEach(async () => {
  resetGateCachesForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-sync-jobs-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});

afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  await rm(workspace, { recursive: true, force: true });
});

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await delay(10);
  }
  throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
}

describe("startSyncJob / getSyncJob / getCurrentSyncJob (domain)", () => {
  it("runs every requested node and reports done with each result", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "a.md"), "unsynced");

    const started = startSyncJob({ userId: SOLO_USER, nodeIds: [shared.nodeId], runNode: runNodeFor(shared.db) });
    assert.equal(started.total, 1);
    assert.ok(["running", "done"].includes(started.status));

    await waitUntil(() => getSyncJob(SOLO_USER, started.id)?.status === "done");
    const finished = getSyncJob(SOLO_USER, started.id);
    assert.ok(finished);
    assert.equal(finished!.completed, 1);
    assert.equal(finished!.errored, 0);
    assert.equal(finished!.nodes[0].status, "done");
    // "a.md" was written straight into the mirror, never registered -- the
    // run's untracked-adoption pass picks it up (registerLocalFile + push),
    // not the push_candidates loop (that's for files already tracked).
    assert.ok(finished!.nodes[0].result?.adopted.some((f) => f.filename === "a.md"));
    assert.ok(finished!.finished_at);
  });

  it("getCurrentSyncJob reattaches to a running job, then returns null once it finishes", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "b.md"), "unsynced");

    const started = startSyncJob({ userId: SOLO_USER, nodeIds: [shared.nodeId], runNode: runNodeFor(shared.db) });
    const current = getCurrentSyncJob(SOLO_USER);
    assert.equal(current?.id, started.id);

    await waitUntil(() => getSyncJob(SOLO_USER, started.id)?.status === "done");
    assert.equal(getCurrentSyncJob(SOLO_USER), null, "no longer 'current' once finished");
    // Still fetchable by id within its retention window.
    assert.ok(getSyncJob(SOLO_USER, started.id));
  });

  it("a reattaching start appends the nodes the running job does not already cover", async () => {
    // Reattaching must not silently swallow the caller's node set: a 202 for
    // nodes that then never sync is worse than a duplicate job.
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runNode = async (nodeId: string): Promise<SyncRunResponse> => {
      seen.push(nodeId);
      if (nodeId === "NODE-A") await gate;
      return {} as SyncRunResponse;
    };

    const first = startSyncJob({ userId: SOLO_USER, nodeIds: ["NODE-A"], runNode });
    const second = startSyncJob({ userId: SOLO_USER, nodeIds: ["NODE-A", "NODE-B"], runNode });
    assert.equal(second.id, first.id, "reattaches rather than racing a duplicate");
    assert.deepEqual(
      second.nodes.map((n) => n.node_id),
      ["NODE-A", "NODE-B"],
      "the uncovered node is appended, the covered one is not duplicated",
    );

    release();
    await waitUntil(() => getSyncJob(SOLO_USER, first.id)?.status === "done");
    assert.deepEqual([...seen].sort(), ["NODE-A", "NODE-B"]);
    const done = getSyncJob(SOLO_USER, first.id);
    assert.equal(done?.total, 2);
    assert.equal(done?.completed, 2);
  });

  it("a second start while one is already running reattaches instead of racing a duplicate", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "c.md"), "unsynced");

    const first = startSyncJob({ userId: SOLO_USER, nodeIds: [shared.nodeId], runNode: runNodeFor(shared.db) });
    const second = startSyncJob({ userId: SOLO_USER, nodeIds: [shared.nodeId], runNode: runNodeFor(shared.db) });
    assert.equal(second.id, first.id);

    await waitUntil(() => getSyncJob(SOLO_USER, first.id)?.status === "done");
  });

  it("a per-node failure is reported as status error without failing the rest of the job", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "d.md"), "unsynced");

    const started = startSyncJob({
      userId: SOLO_USER,
      nodeIds: ["N-DOES-NOT-EXIST", shared.nodeId],
      runNode: runNodeFor(shared.db),
    });
    await waitUntil(() => getSyncJob(SOLO_USER, started.id)?.status === "done");
    const finished = getSyncJob(SOLO_USER, started.id)!;
    assert.equal(finished.total, 2);
    assert.equal(finished.errored, 1);
    const bad = finished.nodes.find((n) => n.node_id === "N-DOES-NOT-EXIST");
    const good = finished.nodes.find((n) => n.node_id === shared.nodeId);
    assert.equal(bad?.status, "error");
    assert.ok(bad?.error);
    assert.equal(good?.status, "done");
  });

  it("getSyncJob scopes jobs to their owning user", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const started = startSyncJob({ userId: SOLO_USER, nodeIds: [], runNode: runNodeFor(shared.db) });
    assert.equal(getSyncJob("someone-else", started.id), null);
    assert.equal(getSyncJob(SOLO_USER, "not-a-real-job-id"), null);
  });
});

describe("POST /sync/jobs, GET /sync/jobs/:id, GET /sync/jobs/current (REST)", () => {
  it("starts a job over explicit node_ids and can be polled to completion", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "e.md"), "unsynced");

    const start = await fetch(`${BASE}/sync/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_ids: [shared.nodeId] }),
    });
    assert.equal(start.status, 202);
    const job = (await start.json()) as { id: string; status: string; total: number };
    assert.equal(job.total, 1);

    let finalStatus = "";
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${BASE}/sync/jobs/${job.id}`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as { status: string };
      finalStatus = body.status;
      if (finalStatus === "done") break;
      await delay(10);
    }
    assert.equal(finalStatus, "done");
  });

  it("GET /sync/jobs/current reflects a job started without waiting on it", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "f.md"), "unsynced");

    const start = await fetch(`${BASE}/sync/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_ids: [shared.nodeId] }),
    });
    const job = (await start.json()) as { id: string };

    const cur = await fetch(`${BASE}/sync/jobs/current`);
    assert.equal(cur.status, 200);
    const curBody = (await cur.json()) as { job: { id: string } | null };
    assert.equal(curBody.job?.id, job.id);
  });

  it("defaults node_ids to the actionable pending set when omitted", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(SOLO_USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "g.md"), "unsynced");

    const start = await fetch(`${BASE}/sync/jobs`, { method: "POST" });
    assert.equal(start.status, 202);
    const job = (await start.json()) as { total: number; nodes: Array<{ node_id: string }> };
    assert.ok(job.nodes.some((n) => n.node_id === shared.nodeId));
  });

  it("GET /sync/jobs/:id for an unknown id is 404", async () => {
    const r = await fetch(`${BASE}/sync/jobs/nonexistent`);
    assert.equal(r.status, 404);
  });
});
