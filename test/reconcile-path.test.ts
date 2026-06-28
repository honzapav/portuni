// reconcilePath: bring the sync DB in line with one path on disk. This is
// the deterministic core the mirror watcher fires on every filesystem event
// -- create registers, modify re-hashes the cache (so fast-mode status
// flips to push), delete clears the cache (so it shows missing), and
// ignored/out-of-section paths are no-ops. No agent, no manual portuni_store.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { storeFile, statusScan } from "../apps/server/domain/sync/engine.js";
import { reconcilePath } from "../apps/server/domain/sync/reconcile.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;
let mirrorRoot: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-reconcile-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  mirrorRoot = join(workspace, "mirror");
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

async function fastScan(db: Parameters<typeof statusScan>[0], nodeId: string) {
  return statusScan(db, {
    userId: "U1",
    nodeId,
    fast: true,
    includeDiscovery: false,
  });
}

describe("reconcilePath", () => {
  it("registers a brand-new file (create) so it shows as push", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const fp = join(mirrorRoot, "wip", "new.md");
    await writeFile(fp, "hi");

    const res = await reconcilePath(db, { userId: "U1", nodeId, absPath: fp });
    assert.equal(res.action, "registered");

    const scan = await fastScan(db, nodeId);
    assert.deepEqual(
      scan.push_candidates.map((f) => f.filename),
      ["new.md"],
    );
  });

  it("re-hashes a modified registered file so fast status flips to push", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const fp = join(mirrorRoot, "wip", "doc.md");
    await writeFile(fp, "v1");
    await storeFile(db, { userId: "U1", nodeId, localPath: fp }); // synced baseline

    assert.equal((await fastScan(db, nodeId)).clean.length, 1);

    await writeFile(fp, "v2 changed bytes");
    const res = await reconcilePath(db, { userId: "U1", nodeId, absPath: fp });
    assert.equal(res.action, "rehashed");

    assert.deepEqual(
      (await fastScan(db, nodeId)).push_candidates.map((f) => f.filename),
      ["doc.md"],
    );
  });

  it("clears the cache for a deleted registered file so it shows missing", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const fp = join(mirrorRoot, "wip", "doc.md");
    await writeFile(fp, "v1");
    await storeFile(db, { userId: "U1", nodeId, localPath: fp }); // synced baseline

    await rm(fp);
    const res = await reconcilePath(db, { userId: "U1", nodeId, absPath: fp });
    assert.equal(res.action, "deleted");

    assert.deepEqual(
      (await fastScan(db, nodeId)).deleted_local.map((f) => f.filename),
      ["doc.md"],
    );
  });

  it("is a no-op for a newly created directory (not a file)", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, mirrorRoot);
    const dirPath = join(mirrorRoot, "wip", "subdir");
    await mkdir(dirPath, { recursive: true });

    const res = await reconcilePath(db, { userId: "U1", nodeId, absPath: dirPath });
    assert.equal(res.action, "noop");

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS c FROM files WHERE node_id = ?",
      args: [nodeId],
    });
    assert.equal(Number(rows.rows[0].c), 0);
  });

  it("is a no-op for ignored dotfiles and files outside tracked sections", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });

    const dot = join(mirrorRoot, "wip", ".DS_Store");
    await writeFile(dot, "junk");
    assert.equal(
      (await reconcilePath(db, { userId: "U1", nodeId, absPath: dot })).action,
      "ignored",
    );

    const rootFile = join(mirrorRoot, "PORTUNI_SCOPE.md");
    await writeFile(rootFile, "managed");
    assert.equal(
      (await reconcilePath(db, { userId: "U1", nodeId, absPath: rootFile }))
        .action,
      "ignored",
    );

    // Nothing got registered.
    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS c FROM files WHERE node_id = ?",
      args: [nodeId],
    });
    assert.equal(Number(rows.rows[0].c), 0);
  });
});
