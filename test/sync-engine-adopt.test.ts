import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { adoptFiles } from "../src/domain/sync/engine.js";
import { getAdapter, resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-adopt-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("adoptFiles", () => {
  it("registers untracked remote paths", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const adapter = await getAdapter(db, "test-fs");
    const remotePath = `${orgSyncKey}/projects/${nodeSyncKey}/wip/pre-existing.md`;
    await adapter.put(remotePath, Buffer.from("pre"));
    const r = await adoptFiles(db, { userId: "U1", nodeId, paths: [remotePath] });
    assert.equal(r.adopted.length, 1);
    assert.equal(r.skipped.length, 0);
    assert.equal(r.adopted[0].filename, "pre-existing.md");
  });
  it("skips already-tracked paths", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const adapter = await getAdapter(db, "test-fs");
    const remotePath = `${orgSyncKey}/projects/${nodeSyncKey}/wip/x.md`;
    await adapter.put(remotePath, Buffer.from("x"));
    await adoptFiles(db, { userId: "U1", nodeId, paths: [remotePath] });
    const r2 = await adoptFiles(db, { userId: "U1", nodeId, paths: [remotePath] });
    assert.equal(r2.adopted.length, 0);
    assert.equal(r2.skipped[0].reason, "already tracked");
  });
  it("skips non-existent remote paths", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const insideButMissing = `${orgSyncKey}/projects/${nodeSyncKey}/wip/missing.md`;
    const r = await adoptFiles(db, { userId: "U1", nodeId, paths: [insideButMissing] });
    assert.equal(r.adopted.length, 0);
    assert.equal(r.skipped[0].reason, "remote file not found");
  });

  it("rejects paths outside the node subtree (path traversal defence)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const r = await adoptFiles(db, {
      userId: "U1",
      nodeId,
      paths: ["other/projects/foo/wip/x.md"],
    });
    assert.equal(r.adopted.length, 0);
    assert.match(r.skipped[0].reason, /outside node root/);
  });

  it("rejects ../ traversal inside the node subtree", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    const evil = `${orgSyncKey}/projects/${nodeSyncKey}/../escape.md`;
    const r = await adoptFiles(db, { userId: "U1", nodeId, paths: [evil] });
    assert.equal(r.adopted.length, 0);
    assert.match(r.skipped[0].reason, /dot segment|outside node root/);
  });
});
