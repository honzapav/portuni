// POST /nodes/:id/files/:fileId/resolve -- the REST surface for the two
// decisions reconciliation cannot make on its own: a conflict (both sides
// changed -- which version wins) and a locally deleted file (restore it, or
// leave it deleted and let a later delete remove it everywhere). Exercises
// the real HTTP route + handler (not the engine functions directly) and
// asserts both the resulting file bytes (remote for keep_local, local for
// take_remote/restore) and the post-resolve fast-mode sync-status class.

process.env.PORT = "14932";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { storeFile } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";

let handle: HttpServerHandle;
let workspace: string;
let shared: SharedDb;
let base: string;
let srcCounter = 0;
let originalWorkspaceRoot: string | undefined;

beforeEach(async () => {
  resetGateCachesForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-resolve-rest-"));
  originalWorkspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  shared = await makeSharedDb();
  setDbForTesting(shared.db);
  await registerMirror(SOLO_USER, shared.nodeId, join(workspace, "mirror"));

  handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });
  if (!handle.server.listening) {
    await new Promise<void>((r) => handle.server.once("listening", r));
  }
  const addr = handle.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  process.env.PORT = String(addr.port);
  resetGateCachesForTesting();
});

afterEach(async () => {
  await handle.shutdown();
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalWorkspaceRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalWorkspaceRoot;
  await rm(workspace, { recursive: true, force: true });
});

// Pushes a fresh "wip/<name>.md" file (content "v1") and returns the store
// result -- file_id, remote_path, local_path all resolved through the real
// engine, not hand-built.
async function seedFile(name: string) {
  const src = join(workspace, `${name}-${srcCounter++}.md`);
  await writeFile(src, "v1");
  return storeFile(shared.db, { userId: SOLO_USER, nodeId: shared.nodeId, localPath: src });
}

async function syncClassFor(fileId: string): Promise<string> {
  const res = await fetch(`${base}/nodes/${shared.nodeId}/sync-status`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { files: Array<{ file_id: string; sync_class: string }> };
  const entry = body.files.find((f) => f.file_id === fileId);
  assert.ok(entry, `expected ${fileId} in sync-status files, got ${JSON.stringify(body.files)}`);
  return entry!.sync_class;
}

describe("POST /nodes/:id/files/:fileId/resolve", () => {
  it("keep_local pushes the local version over a remote edit", async () => {
    const stored = await seedFile("a");
    // Both sides changed since the last sync -- a real conflict.
    await writeFile(join(shared.remoteRoot, stored.remote_path), "remote");
    await writeFile(stored.local_path, "local");

    const r = await fetch(
      `${base}/nodes/${shared.nodeId}/files/${stored.file_id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "keep_local" }),
      },
    );
    assert.equal(r.status, 200);
    const body = (await r.json()) as { file_id: string; action: string; status: string };
    assert.deepEqual(body, { file_id: stored.file_id, action: "keep_local", status: "ok" });

    assert.equal(
      await readFile(join(shared.remoteRoot, stored.remote_path), "utf8"),
      "local",
      "remote must now carry the local version",
    );
    assert.equal(
      await readFile(stored.local_path, "utf8"),
      "local",
      "local copy must be untouched",
    );
    assert.equal(await syncClassFor(stored.file_id), "clean");
  });

  it("take_remote overwrites the local edit with the remote version", async () => {
    const stored = await seedFile("b");
    await writeFile(join(shared.remoteRoot, stored.remote_path), "remote");
    await writeFile(stored.local_path, "local");

    const r = await fetch(
      `${base}/nodes/${shared.nodeId}/files/${stored.file_id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "take_remote" }),
      },
    );
    assert.equal(r.status, 200);

    assert.equal(
      await readFile(stored.local_path, "utf8"),
      "remote",
      "local copy must now carry the remote version",
    );
    assert.equal(
      await readFile(join(shared.remoteRoot, stored.remote_path), "utf8"),
      "remote",
      "remote must be untouched",
    );
    assert.equal(await syncClassFor(stored.file_id), "clean");
  });

  it("restore re-downloads a locally deleted file", async () => {
    const stored = await seedFile("c");
    // User deletes the local copy on purpose -- deleted_local.
    await rm(stored.local_path);

    const r = await fetch(
      `${base}/nodes/${shared.nodeId}/files/${stored.file_id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore" }),
      },
    );
    assert.equal(r.status, 200);

    await stat(stored.local_path); // throws if still missing
    assert.equal(await readFile(stored.local_path, "utf8"), "v1");
    assert.equal(await syncClassFor(stored.file_id), "clean");
  });

  it("rejects an unknown action with 400", async () => {
    const stored = await seedFile("d");
    const r = await fetch(
      `${base}/nodes/${shared.nodeId}/files/${stored.file_id}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "nope" }),
      },
    );
    assert.equal(r.status, 400);
    const body = (await r.json()) as { error: string };
    assert.match(body.error, /keep_local/);
  });
});
