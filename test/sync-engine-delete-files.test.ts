import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, deleteFiles } from "../apps/server/domain/sync/engine.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests, getFileState } from "../apps/server/domain/sync/local-db.js";
import type { DbClient } from "../apps/server/infra/db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-delmany-"));
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

// Stores one file at <mirror>/<rel> and returns its id + local path.
async function storeAt(
  db: DbClient,
  nodeId: string,
  mirrorRoot: string,
  rel: string,
): Promise<{ file_id: string; local_path: string }> {
  const p = join(mirrorRoot, rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, rel);
  const r = await storeFile(db, { userId: "U1", nodeId, localPath: p });
  return { file_id: r.file_id, local_path: r.local_path };
}

async function rowCount(db: DbClient, nodeId: string): Promise<number> {
  const r = await db.execute({ sql: "SELECT id FROM files WHERE node_id = ?", args: [nodeId] });
  return r.rows.length;
}

describe("deleteFiles", () => {
  it("previews every file under the prefixes plus explicit ids, without deleting", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const a = await storeAt(db, nodeId, mirrorRoot, "wip/navrh/a.md");
    const b = await storeAt(db, nodeId, mirrorRoot, "wip/navrh/sub/b.md");
    const keep = await storeAt(db, nodeId, mirrorRoot, "wip/navrh-final/c.md");
    const res = await storeAt(db, nodeId, mirrorRoot, "resources/r.md");

    const r = await deleteFiles(db, {
      userId: "U1",
      nodeId,
      pathPrefixes: ["wip/navrh/"],
      fileIds: [res.file_id, "MISSING"],
    });
    assert.ok("requires_confirmation" in r);
    assert.equal(r.count, 3);
    assert.deepEqual(new Set(r.files.map((f) => f.file_id)), new Set([a.file_id, b.file_id, res.file_id]));
    assert.deepEqual(r.not_found, ["MISSING"]);
    assert.ok(!r.files.some((f) => f.file_id === keep.file_id), "sibling folder with a shared name prefix is not selected");
    assert.equal(await rowCount(db, nodeId), 4, "preview deletes nothing");
    assert.equal(await exists(a.local_path), true);
  });

  it("confirmed deletes the whole selection: remote, local copy and record", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const a = await storeAt(db, nodeId, mirrorRoot, "wip/navrh/a.md");
    const b = await storeAt(db, nodeId, mirrorRoot, "outputs/run_1/b.md");
    const keep = await storeAt(db, nodeId, mirrorRoot, "outputs/runX1/keep.md");
    // A file already gone from disk is deleted in the same batch.
    await rm(b.local_path);

    const r = await deleteFiles(db, {
      userId: "U1",
      nodeId,
      pathPrefixes: ["wip/navrh", "outputs/run_1"],
      confirmed: true,
    });
    assert.ok("type" in r && r.type === "applied");
    assert.equal(r.deleted, 2);
    assert.equal(r.failed, 0);
    assert.equal(r.remaining, 0);
    assert.equal(await exists(a.local_path), false);
    assert.equal(await getFileState(a.file_id), null);
    assert.equal(await rowCount(db, nodeId), 1, "only the file outside the prefixes is left");
    assert.equal(await exists(keep.local_path), true, "LIKE '_' does not match runX1");
  });

  it("a bounded confirmed call reports remaining and the next call continues", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    for (const n of ["1", "2", "3"]) await storeAt(db, nodeId, mirrorRoot, `wip/tmp/${n}.md`);

    const first = await deleteFiles(db, {
      userId: "U1",
      nodeId,
      pathPrefixes: ["wip/tmp"],
      confirmed: true,
      limit: 2,
    });
    assert.ok("type" in first);
    assert.equal(first.deleted, 2);
    assert.equal(first.remaining, 1);
    assert.ok(first.next_call);

    const second = await deleteFiles(db, {
      userId: "U1",
      nodeId,
      pathPrefixes: ["wip/tmp"],
      confirmed: true,
      limit: 2,
    });
    assert.ok("type" in second);
    assert.equal(second.deleted, 1);
    assert.equal(second.remaining, 0);
    assert.equal(await rowCount(db, nodeId), 0);
  });

  it("never touches another node's file passed by id", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const a = await storeAt(db, nodeId, mirrorRoot, "wip/a.md");
    const r = await deleteFiles(db, {
      userId: "U1",
      nodeId: "OTHER_NODE",
      fileIds: [a.file_id],
      confirmed: true,
    }).catch((e: Error) => e);
    // Either the node does not resolve or the id is reported not_found;
    // in both cases the file survives.
    if (!(r instanceof Error)) {
      assert.ok("type" in r);
      assert.equal(r.deleted, 0);
      assert.deepEqual(r.not_found, [a.file_id]);
    }
    assert.equal(await rowCount(db, nodeId), 1);
  });

  it("rejects an empty selection and an escaping prefix", async () => {
    const { db, nodeId } = await makeSharedDb();
    await assert.rejects(deleteFiles(db, { userId: "U1", nodeId }), /path_prefixes or file_ids/);
    await assert.rejects(deleteFiles(db, { userId: "U1", nodeId, pathPrefixes: ["../x"] }));
  });
});
