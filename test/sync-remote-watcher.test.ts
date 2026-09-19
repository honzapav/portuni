// Remote watcher (#338): the change feed's batches become exactly the
// adopt / hash-refresh / delete + tombstone operations a full remoteSweep
// would apply for the same file (spec rule 4), and the cursor only advances
// once a whole batch landed.
//
// Central-mode shape: PORTUNI_AUTH_MODE=google, so isLocalWorkspace() is
// false and the remote-touching guards let the sweep steps run.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests, upsertFileState } from "../apps/server/domain/sync/local-db.js";
import {
  resetAdapterCacheForTests,
  setAdapterForTests,
} from "../apps/server/domain/sync/adapter-cache.js";
import {
  applyRemoteChanges,
  getRemoteCursor,
  planRemoteChanges,
  runRemoteWatchTick,
  setRemoteCursor,
  watchedNodesForRemote,
} from "../apps/server/domain/sync/remote-watcher.js";
import { RemoteWatchLoop } from "../apps/server/boot/remote-watch.js";
import { statusScanCentral } from "../apps/server/domain/sync/central/engine-central.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";
import type {
  FileAdapter,
  FileRef,
  RemoteChange,
  RemoteChanges,
} from "../apps/server/domain/sync/types.js";
import type { DbClient } from "../apps/server/infra/db.js";

const NODE_ROOT = "workflow/projects/stan-gws";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-remote-watch-"));
  for (const k of ["PORTUNI_WORKSPACE_ROOT", "PORTUNI_AUTH_MODE"]) savedEnv[k] = process.env[k];
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_AUTH_MODE = "google";
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(workspace, { recursive: true, force: true });
});

// A backend double that holds bytes in memory, reports a content hash on
// stat (like Drive's md5Checksum) and serves a scripted change feed.
interface FakeBackend extends FileAdapter {
  objects: Map<string, Buffer>;
  feed: RemoteChanges[];
  statCalls: string[];
  changesCalls: Array<string | null>;
}

function fakeBackend(): FakeBackend {
  const objects = new Map<string, Buffer>();
  const feed: RemoteChanges[] = [];
  const statCalls: string[] = [];
  const changesCalls: Array<string | null> = [];
  const refFor = (path: string, body: Buffer): FileRef => ({
    path,
    hash: sha(body),
    size: body.length,
    modified_at: new Date(0),
    is_native_format: false,
  });
  return {
    objects,
    feed,
    statCalls,
    changesCalls,
    async put(path, content) {
      objects.set(path, content);
      return refFor(path, content);
    },
    async get(path) {
      const b = objects.get(path);
      if (!b) throw new Error(`fakeBackend: no object at ${path}`);
      return b;
    },
    async stat(path) {
      statCalls.push(path);
      const b = objects.get(path);
      return b ? refFor(path, b) : null;
    },
    async list(prefix) {
      return Array.from(objects.entries())
        .filter(([p]) => p.startsWith(`${prefix}/`))
        .map(([p, b]) => refFor(p, b));
    },
    async delete(path) {
      objects.delete(path);
    },
    async rename() {
      throw new Error("fakeBackend: rename not implemented");
    },
    async url(path) {
      return `fake://${path}`;
    },
    async changes(cursor) {
      changesCalls.push(cursor);
      const next = feed.shift();
      if (!next) return { cursor: cursor ?? "c0", changes: [], reset: false };
      return next;
    },
  };
}

const upsert = (path: string, hash: string | null, is_folder = false): RemoteChange => ({
  kind: "upsert",
  path,
  hash,
  modified_at: new Date(0),
  is_folder,
});
const remove = (path: string | null, file_id = "drive-id"): RemoteChange => ({
  kind: "remove",
  path,
  file_id,
});

async function recordRow(db: DbClient, remotePath: string) {
  const r = await db.execute({
    sql: "SELECT id, filename, current_remote_hash, status FROM files WHERE remote_path = ?",
    args: [remotePath],
  });
  return r.rows[0] ?? null;
}

describe("planRemoteChanges (pure reducer)", () => {
  const nodes = [
    { nodeId: "N-ORG", nodeRoot: "workflow" },
    { nodeId: "N-PROJ", nodeRoot: NODE_ROOT },
  ];

  const cases: Array<{ name: string; change: RemoteChange; expect: string }> = [
    { name: "a file under wip/ is planned", change: upsert(`${NODE_ROOT}/wip/a.md`, "h"), expect: "N-PROJ" },
    { name: "a file under outputs/ is planned", change: upsert(`${NODE_ROOT}/outputs/b.md`, "h"), expect: "N-PROJ" },
    { name: "a file under resources/ is planned", change: upsert(`${NODE_ROOT}/resources/c.md`, "h"), expect: "N-PROJ" },
    { name: "a remove under wip/ is planned", change: remove(`${NODE_ROOT}/wip/a.md`), expect: "N-PROJ" },
    { name: "a folder is dropped", change: upsert(`${NODE_ROOT}/wip/sub`, null, true), expect: "folder" },
    { name: "a pathless hard delete is dropped", change: remove(null), expect: "no_path" },
    { name: "a path outside every node root is dropped", change: upsert("elsewhere/wip/a.md", "h"), expect: "out_of_root" },
    { name: "a path inside the root but outside a section is dropped", change: upsert(`${NODE_ROOT}/notes/a.md`, "h"), expect: "out_of_section" },
    { name: "a dot-prefixed segment is dropped", change: upsert(`${NODE_ROOT}/wip/.git/a.md`, "h"), expect: "out_of_section" },
    // The organization's own root spans its children's subtrees; the child
    // node owns its files (longest matching root wins).
    { name: "a child project's file belongs to the child, not the org", change: upsert(`${NODE_ROOT}/wip/d.md`, "h"), expect: "N-PROJ" },
    { name: "the org's own wip file belongs to the org", change: upsert("workflow/wip/e.md", "h"), expect: "N-ORG" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const plan = planRemoteChanges([c.change], nodes);
      if (c.expect === "N-PROJ" || c.expect === "N-ORG") {
        assert.equal(plan.planned.length, 1);
        assert.equal(plan.planned[0].nodeId, c.expect);
        assert.equal(plan.dropped.length, 0);
      } else {
        assert.equal(plan.planned.length, 0);
        assert.equal(plan.dropped[0]?.reason, c.expect);
      }
    });
  }

  it("keeps only the last change for a path", () => {
    const path = `${NODE_ROOT}/wip/a.md`;
    const plan = planRemoteChanges([upsert(path, "old"), upsert(path, "new")], nodes);
    assert.equal(plan.planned.length, 1);
    assert.equal(plan.planned[0].kind === "upsert" && plan.planned[0].hash, "new");
  });
});

describe("applyRemoteChanges", () => {
  it("adopts a file the remote gained and records its hash", async () => {
    const { db, nodeId } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    const path = `${NODE_ROOT}/wip/nova.md`;
    const body = Buffer.from("z Drive");
    backend.objects.set(path, body);

    const nodes = await watchedNodesForRemote(db, "test-fs");
    const plan = planRemoteChanges([upsert(path, sha(body))], nodes);
    const res = await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: plan.planned,
    });

    assert.equal(res.adopted.length, 1);
    const row = await recordRow(db, path);
    assert.ok(row, "the adopted record exists");
    assert.equal(row.current_remote_hash, sha(body));
    assert.equal(row.node_id ?? nodeId, nodeId);
  });

  it("refreshes the hash of a record the remote edited, and is a no-op when it matches", async () => {
    const { db } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    const path = `${NODE_ROOT}/wip/a.md`;
    const first = Buffer.from("v1");
    backend.objects.set(path, first);
    const nodes = await watchedNodesForRemote(db, "test-fs");
    await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([upsert(path, sha(first))], nodes).planned,
    });

    const second = Buffer.from("v2 z Drive");
    backend.objects.set(path, second);
    const res = await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([upsert(path, sha(second))], nodes).planned,
    });
    assert.equal(res.refreshed.length, 1);
    assert.equal((await recordRow(db, path))!.current_remote_hash, sha(second));

    const again = await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([upsert(path, sha(second))], nodes).planned,
    });
    assert.deepEqual(again.refreshed, []);
    assert.deepEqual(again.adopted, []);
  });

  it("deletes the record and writes a tombstone for a file removed on the remote", async () => {
    const { db, nodeId } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    const path = `${NODE_ROOT}/wip/a.md`;
    const body = Buffer.from("v1");
    backend.objects.set(path, body);
    const nodes = await watchedNodesForRemote(db, "test-fs");
    await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([upsert(path, sha(body))], nodes).planned,
    });
    const fileId = (await recordRow(db, path))!.id as string;

    backend.objects.delete(path);
    const res = await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([remove(path)], nodes).planned,
    });

    assert.deepEqual(res.deleted.map((d) => d.file_id), [fileId]);
    assert.equal(await recordRow(db, path), null);
    const audit = await db.execute({
      sql: "SELECT action, target_id FROM audit_log WHERE action = 'sync_delete_remote'",
      args: [],
    });
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].target_id, fileId);
    assert.ok(nodeId);
  });

  it("does not delete a record whose object the confirmation stat still finds", async () => {
    const { db } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    const path = `${NODE_ROOT}/wip/a.md`;
    const body = Buffer.from("v1");
    backend.objects.set(path, body);
    const nodes = await watchedNodesForRemote(db, "test-fs");
    await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([upsert(path, sha(body))], nodes).planned,
    });

    // The object is still there (a change feed reports a move out of the
    // watched root the same way it reports a delete).
    const res = await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([remove(path)], nodes).planned,
    });
    assert.deepEqual(res.deleted, []);
    assert.ok(await recordRow(db, path));
  });
});

describe("runRemoteWatchTick", () => {
  it("takes a start token and asks for a baseline sweep when there is no cursor", async () => {
    const { db, nodeId } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    const swept: string[][] = [];
    const res = await runRemoteWatchTick(db, {
      remoteName: "test-fs",
      userId: "U1",
      adapter: backend,
      fullSweep: (ids) => {
        swept.push(ids);
      },
    });
    assert.equal(res.baseline, true);
    assert.deepEqual(backend.changesCalls, [null]);
    // Every node routed to this remote: the project and the organization it
    // belongs to (makeSharedDb routes both).
    assert.equal(swept.length, 1);
    assert.ok(swept[0].includes(nodeId));
    assert.equal((await getRemoteCursor(db, "test-fs"))?.cursor, "c0");
  });

  it("advances the cursor only once the whole batch applied", async () => {
    const { db } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    await setRemoteCursor(db, "test-fs", "c1");
    const ok = `${NODE_ROOT}/wip/ok.md`;
    const broken = `${NODE_ROOT}/wip/broken.md`;
    backend.objects.set(ok, Buffer.from("ok"));
    // No object behind `broken` and no hash on the change, so the adopt
    // path's own hash backfill has to fetch bytes -- and fails.
    backend.feed.push({
      cursor: "c2",
      reset: false,
      changes: [upsert(ok, sha(Buffer.from("ok"))), upsert(broken, null)],
    });

    const res = await runRemoteWatchTick(db, {
      remoteName: "test-fs",
      userId: "U1",
      adapter: backend,
      fullSweep: () => undefined,
    });
    assert.equal(res.applied.errors.length, 1);
    assert.equal(res.cursor_persisted, false);
    assert.equal((await getRemoteCursor(db, "test-fs"))?.cursor, "c1");
    // The half of the batch that did apply is not undone -- which is what
    // makes the replay below a no-op rather than a duplicate.
    assert.ok(await recordRow(db, ok));
  });

  it("replaying the same batch is a no-op", async () => {
    const { db } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    await setRemoteCursor(db, "test-fs", "c1");
    const path = `${NODE_ROOT}/wip/a.md`;
    const body = Buffer.from("v1");
    backend.objects.set(path, body);
    const batch: RemoteChanges = {
      cursor: "c2",
      reset: false,
      changes: [upsert(path, sha(body))],
    };
    backend.feed.push(batch, { ...batch });

    const first = await runRemoteWatchTick(db, {
      remoteName: "test-fs",
      userId: "U1",
      adapter: backend,
      fullSweep: () => undefined,
    });
    assert.equal(first.applied.adopted.length, 1);
    assert.equal(first.cursor_persisted, true);
    const second = await runRemoteWatchTick(db, {
      remoteName: "test-fs",
      userId: "U1",
      adapter: backend,
      fullSweep: () => undefined,
    });
    assert.deepEqual(second.applied.adopted, []);
    assert.deepEqual(second.applied.refreshed, []);
    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM files WHERE remote_path = ?",
      args: [path],
    });
    assert.equal(Number(rows.rows[0].n), 1);
  });

  it("a reset stores the fresh token and asks for a full sweep", async () => {
    const { db, nodeId } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    await setRemoteCursor(db, "test-fs", "stale");
    backend.feed.push({ cursor: "fresh", reset: true, changes: [] });
    const swept: string[][] = [];
    const res = await runRemoteWatchTick(db, {
      remoteName: "test-fs",
      userId: "U1",
      adapter: backend,
      fullSweep: (ids) => {
        swept.push(ids);
      },
    });
    assert.equal(res.reset, true);
    assert.equal(swept.length, 1);
    assert.ok(swept[0].includes(nodeId));
    assert.equal((await getRemoteCursor(db, "test-fs"))?.cursor, "fresh");
  });
});

describe("RemoteWatchLoop", () => {
  it("backs off exponentially from the tick interval and resumes on success", async () => {
    const { db } = await makeSharedDb();
    const backend = fakeBackend();
    backend.changes = async () => {
      throw new Error("Drive changes: 429 rate limited");
    };
    setAdapterForTests("test-fs", backend);
    let clock = 1_000_000;
    const loop = new RemoteWatchLoop({
      db,
      userId: "U1",
      intervalMs: 60_000,
      sweepIntervalMs: 6 * 60 * 60_000,
      now: () => clock,
      schedule: () => ({}),
      runCatchUp: () => undefined,
    });

    await loop.tick();
    assert.match(loop.status()[0].last_error ?? "", /429/);
    assert.equal(loop.status()[0].backoff_until, new Date(clock + 60_000).toISOString());

    // Still inside the backoff window: the tick is skipped entirely.
    clock += 30_000;
    const callsBefore = backend.changesCalls.length;
    await loop.tick();
    assert.equal(backend.changesCalls.length, callsBefore);

    // Past it: one more failure doubles the wait.
    clock += 40_000;
    await loop.tick();
    assert.equal(loop.status()[0].backoff_until, new Date(clock + 120_000).toISOString());

    // A successful tick clears it.
    clock += 200_000;
    backend.changes = async (cursor) => ({ cursor: cursor ?? "c0", changes: [], reset: false });
    await loop.tick();
    assert.equal(loop.status()[0].backoff_until, null);
    assert.equal(loop.status()[0].last_error, null);
  });

  it("a backend with no change feed still gets the periodic full sweep, and only that", async () => {
    const { db } = await makeSharedDb();
    const backend = fakeBackend();
    delete (backend as { changes?: unknown }).changes;
    setAdapterForTests("test-fs", backend);
    let clock = 1_000_000;
    const sweeps: string[][] = [];
    const loop = new RemoteWatchLoop({
      db,
      userId: "U1",
      intervalMs: 60_000,
      sweepIntervalMs: 6 * 60 * 60_000,
      now: () => clock,
      schedule: () => ({}),
      runCatchUp: (ids) => {
        sweeps.push(ids);
      },
    });

    await loop.tick();
    assert.equal(sweeps.length, 1);
    assert.equal(loop.status()[0].watching, false);
    // Every tick inside the interval must not re-sweep (the state is kept
    // per remote, not rebuilt each pass).
    clock += 60_000;
    await loop.tick();
    clock += 60_000;
    await loop.tick();
    assert.equal(sweeps.length, 1);
    assert.equal((await getRemoteCursor(db, "test-fs")), null);
  });

  it("runs the catch-up sweep at boot and again after the sweep interval, not before", async () => {
    const { db, nodeId } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);
    await setRemoteCursor(db, "test-fs", "c1");
    let clock = 1_000_000;
    const sweeps: string[][] = [];
    const loop = new RemoteWatchLoop({
      db,
      userId: "U1",
      intervalMs: 60_000,
      sweepIntervalMs: 6 * 60 * 60_000,
      now: () => clock,
      schedule: () => ({}),
      runCatchUp: (ids) => {
        sweeps.push(ids);
      },
    });

    await loop.tick();
    assert.equal(sweeps.length, 1);
    assert.ok(sweeps[0].includes(nodeId));
    clock += 60_000;
    await loop.tick();
    assert.equal(sweeps.length, 1, "no second sweep inside the interval");
    clock += 6 * 60 * 60_000;
    await loop.tick();
    assert.equal(sweeps.length, 2);
  });
});

describe("end to end: a watched change reads as pull on a device", () => {
  it("a file edited on the remote reads as pull on the next status read, with no sync run", async () => {
    const { db, nodeId } = await makeSharedDb();
    const backend = fakeBackend();
    setAdapterForTests("test-fs", backend);

    // The device holds a mirror with the file as it last synced it.
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const local = Buffer.from("verze 1");
    await writeFile(join(mirrorRoot, "wip", "a.md"), local);

    const path = posix.join(NODE_ROOT, "wip", "a.md");
    backend.objects.set(path, local);
    const nodes = await watchedNodesForRemote(db, "test-fs");
    await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([upsert(path, sha(local))], nodes).planned,
    });

    // The device's own sync baseline for that copy (what a completed sync
    // leaves behind): without it the edit below would read as a conflict,
    // not a pull.
    const localPath = join(mirrorRoot, "wip", "a.md");
    const st = await stat(localPath);
    await upsertFileState({
      file_id: (await recordRow(db, path))!.id as string,
      last_synced_hash: sha(local),
      last_synced_at: new Date().toISOString(),
      cached_local_hash: sha(local),
      cached_mtime: Math.floor(st.mtimeMs),
      cached_size: st.size,
      cached_ino: Number(st.ino),
      cached_dev: Number(st.dev),
    });

    // Central's syncInfo is fed straight from the `files` rows the watcher
    // maintains -- the same thing statusScanCentral classifies on.
    const central = {
      async syncInfo(): Promise<NodeSyncInfo> {
        const r = await db.execute({
          sql: `SELECT id, filename, status, remote_path, current_remote_hash, is_native_format
                FROM files WHERE node_id = ?`,
          args: [nodeId],
        });
        return {
          node: {
            id: nodeId,
            name: "Stan GWS",
            type: "project",
            sync_key: "stan-gws",
            org_sync_key: "workflow",
          },
          remote_name: "test-fs",
          files: r.rows.map((row) => ({
            id: row.id as string,
            filename: row.filename as string,
            status: row.status as string,
            remote_path: row.remote_path as string,
            current_remote_hash: row.current_remote_hash as string | null,
            is_native_format: Number(row.is_native_format) === 1,
            mime_type: null,
          })),
          deleted: [],
        };
      },
    } as unknown as CentralClient;

    // Baseline: the device's copy is what the remote holds.
    let scan = await statusScanCentral(central, { userId: "U1", nodeId });
    assert.deepEqual(scan.pull_candidates, []);

    // A teammate edits the file on Drive; one change arrives.
    const edited = Buffer.from("verze 2 od kolegy");
    backend.objects.set(path, edited);
    await applyRemoteChanges(db, {
      userId: "U1",
      remoteName: "test-fs",
      adapter: backend,
      plan: planRemoteChanges([upsert(path, sha(edited))], nodes).planned,
    });

    scan = await statusScanCentral(central, { userId: "U1", nodeId });
    assert.deepEqual(
      scan.pull_candidates.map((f) => f.local_path),
      [localPath],
    );
  });
});
