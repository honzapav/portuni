import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, access, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, renameFolder } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-rename-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_AGENT_MODE = "1";
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  delete process.env.PORTUNI_AGENT_MODE;
  await rm(workspace, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("renameFolder", () => {
  it("dry_run returns preview, no mutation", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "r"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "r", "a.md"), "a");
    await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: join(mirrorRoot, "wip", "r", "a.md"),
    });
    const r = await renameFolder(db, {
      userId: "U1",
      nodeId,
      oldPrefix: "wip/r",
      newPrefix: "wip/archive/r",
      dryRun: true,
    });
    assert.equal(r.type, "preview");
    assert.ok(await exists(join(mirrorRoot, "wip", "r", "a.md")));
  });

  it("apply renames remote + local + DB", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "r"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "r", "c.md"), "c");
    await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: join(mirrorRoot, "wip", "r", "c.md"),
    });
    const r = await renameFolder(db, {
      userId: "U1",
      nodeId,
      oldPrefix: "wip/r",
      newPrefix: "wip/archive/r",
      dryRun: false,
    });
    assert.equal(r.type, "applied");
    assert.equal(await exists(join(mirrorRoot, "wip", "r", "c.md")), false);
    assert.ok(await exists(join(mirrorRoot, "wip", "archive", "r", "c.md")));
  });

  it("limit bounds an apply call; a following call with the same prefix finishes the rest", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "r"), { recursive: true });
    for (const name of ["a.md", "b.md", "c.md"]) {
      await writeFile(join(mirrorRoot, "wip", "r", name), name);
      await storeFile(db, { userId: "U1", nodeId, localPath: join(mirrorRoot, "wip", "r", name) });
    }

    const first = await renameFolder(db, {
      userId: "U1",
      nodeId,
      oldPrefix: "wip/r",
      newPrefix: "wip/archive/r",
      dryRun: false,
      limit: 2,
    });
    assert.equal(first.type, "applied");
    assert.equal(first.renamed, 2);
    assert.equal(first.remaining, 1);
    assert.ok(first.next_call);

    const second = await renameFolder(db, {
      userId: "U1",
      nodeId,
      oldPrefix: "wip/r",
      newPrefix: "wip/archive/r",
      dryRun: false,
      limit: 2,
    });
    assert.equal(second.type, "applied");
    assert.equal(second.renamed, 1);
    assert.equal(second.remaining, 0);
    assert.equal("next_call" in second ? second.next_call : undefined, undefined);

    for (const name of ["a.md", "b.md", "c.md"]) {
      assert.ok(await exists(join(mirrorRoot, "wip", "archive", "r", name)));
    }
  });

  it("a file whose remote object already sits at the destination is reported ok, not failed", async () => {
    const { db, nodeId, remoteRoot, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "r"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "r", "z.md"), "z");
    const stored = await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: join(mirrorRoot, "wip", "r", "z.md"),
    });

    // Simulate a previous apply call whose remote rename landed but whose
    // DB update never ran (client-side timeout, or an interrupted retry).
    const nodeRoot = `${orgSyncKey}/projects/${nodeSyncKey}`;
    const newRemotePath = `${nodeRoot}/wip/archive/r/z.md`;
    await mkdir(dirname(join(remoteRoot, newRemotePath)), { recursive: true });
    await rename(join(remoteRoot, stored.remote_path), join(remoteRoot, newRemotePath));

    const r = await renameFolder(db, {
      userId: "U1",
      nodeId,
      oldPrefix: "wip/r",
      newPrefix: "wip/archive/r",
      dryRun: false,
    });
    assert.equal(r.type, "applied");
    assert.equal(r.renamed, 1);
    assert.equal(r.failed, 0);
    assert.equal(r.files[0].status, "ok");
    assert.equal(r.files[0].already_at_target, true);
    const row = await db.execute({
      sql: "SELECT remote_path FROM files WHERE id = ?",
      args: [stored.file_id],
    });
    assert.equal(row.rows[0].remote_path, newRemotePath);
  });
});
