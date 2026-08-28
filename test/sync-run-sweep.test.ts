// POST /nodes/:id/sync must sweep the remote before scanning: records whose
// remote object is confirmed gone are dropped (and their local copy cleaned
// up via the existing tombstone machinery), and files that appeared on the
// remote out of band are adopted and pulled in the same run.

process.env.PORT = "14931";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { storeFile } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";

const BASE = "http://127.0.0.1:14931";
const USER = "01SOLO0000000000000000000";

let handle: HttpServerHandle;
let workspace: string;

before(async () => {
  handle = startHttpServer({ port: 14931, host: "127.0.0.1", registerSigint: false });
  await new Promise((res) => setImmediate(res));
});

after(async () => {
  await handle.shutdown();
});

beforeEach(async () => {
  resetGateCachesForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-syncrun-sweep-"));
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

describe("sync run: remote sweep", () => {
  it("removes the local copy of a file deleted on the remote", async () => {
    const shared: SharedDb = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const localPath = join(mirrorRoot, "wip", "a.md");
    await writeFile(localPath, "obsah a");
    const stored = await storeFile(shared.db, { userId: USER, nodeId: shared.nodeId, localPath });
    await rm(join(shared.remoteRoot, stored.remote_path));

    const res = await fetch(`${BASE}/nodes/${shared.nodeId}/sync`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      deleted_on_remote: Array<{ file_id: string; filename: string }>;
      deleted_remote: Array<{ file_id: string; filename: string }>;
    };
    assert.deepEqual(
      body.deleted_on_remote.map((f) => f.file_id),
      [stored.file_id],
    );
    assert.deepEqual(
      body.deleted_remote.map((f) => f.file_id),
      [stored.file_id],
    );
    await assert.rejects(() => stat(localPath), "local copy must be removed");
  });

  it("pushes back a locally edited copy of a file deleted on the remote", async () => {
    const shared: SharedDb = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(USER, shared.nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const localPath = join(mirrorRoot, "wip", "a.md");
    await writeFile(localPath, "obsah a");
    const stored = await storeFile(shared.db, { userId: USER, nodeId: shared.nodeId, localPath });
    await rm(join(shared.remoteRoot, stored.remote_path));
    // Local copy is edited before the sync run notices the remote deletion,
    // so it is no longer byte-identical to the last synced state -- the
    // tombstone match must not clean it up, and it should come back as a
    // new push instead.
    await writeFile(localPath, "obsah upraveny");

    const res = await fetch(`${BASE}/nodes/${shared.nodeId}/sync`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      deleted_on_remote: Array<{ file_id: string; filename: string }>;
      adopted: Array<{ file_id: string; filename: string }>;
    };
    assert.equal(body.deleted_on_remote.length, 1);
    assert.equal(body.adopted.length, 1);
    await assert.doesNotReject(() => stat(localPath));
    const remoteContent = await readFile(join(shared.remoteRoot, stored.remote_path), "utf8");
    assert.equal(remoteContent, "obsah upraveny");
  });

  it("adopts and pulls a file that appeared on the remote", async () => {
    const shared: SharedDb = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror(USER, shared.nodeId, mirrorRoot);
    const nodeRoot = `${shared.orgSyncKey}/projects/${shared.nodeSyncKey}`;
    await mkdir(join(shared.remoteRoot, nodeRoot, "outputs"), { recursive: true });
    await writeFile(join(shared.remoteRoot, nodeRoot, "outputs", "report.md"), "from drive");

    const res = await fetch(`${BASE}/nodes/${shared.nodeId}/sync`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      adopted_remote: Array<{ file_id: string; filename: string }>;
      pulled: Array<{ file_id: string; filename: string }>;
    };
    assert.equal(body.adopted_remote.length, 1);
    assert.equal(body.pulled.length, 1);
    assert.equal(body.adopted_remote[0].file_id, body.pulled[0].file_id);
    const content = await readFile(join(mirrorRoot, "outputs", "report.md"), "utf8");
    assert.equal(content, "from drive");
  });
});
