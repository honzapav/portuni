import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import { createMirrorForNode } from "../src/domain/sync/mirror-create.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { setDbForTesting } from "../src/infra/db.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-mirrorpath-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

// Local mirror leafs must come from sync_key (unique, collision-suffixed),
// not slugify(name): two nodes named "Web" and "web?" slug to the same leaf
// and would register the SAME directory -- every status scan afterwards
// cross-attributes files between the two nodes.
describe("mirror path identity", () => {
  it("two same-slug nodes in one org get distinct mirror directories", async () => {
    const { db, orgId, nodeId } = await makeSharedDb();
    // createMirrorForNode's audit write goes through the global singleton.
    setDbForTesting(db);
    // makeSharedDb's project is "Stan GWS" (sync_key stan-gws). Add a second
    // project whose name slugs identically but whose sync_key differs --
    // exactly what generateSyncKey produces on a name collision.
    const otherId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
      args: [otherId, "project", "Stan GWS!", "stan-gws-2", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO edges (id,source_id,target_id,relation,created_by) VALUES (?,?,?,?,?)",
      args: [ulid(), otherId, orgId, "belongs_to", "U1"],
    });

    const a = await createMirrorForNode(db, "U1", { nodeId });
    const b = await createMirrorForNode(db, "U1", { nodeId: otherId });
    assert.notEqual(
      a.local_path,
      b.local_path,
      "two nodes must never share one mirror directory",
    );
    assert.ok(
      b.local_path.endsWith("stan-gws-2"),
      `leaf must be the sync_key, got ${b.local_path}`,
    );
  });

  it("rejects a customPath already registered to another node", async () => {
    const { db, orgId, nodeId } = await makeSharedDb();
    setDbForTesting(db);
    const otherId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
      args: [otherId, "project", "Other", "other", "U1"],
    });
    await db.execute({
      sql: "INSERT INTO edges (id,source_id,target_id,relation,created_by) VALUES (?,?,?,?,?)",
      args: [ulid(), otherId, orgId, "belongs_to", "U1"],
    });

    const a = await createMirrorForNode(db, "U1", { nodeId });
    await assert.rejects(
      () => createMirrorForNode(db, "U1", { nodeId: otherId, customPath: a.local_path }),
      /already|registered|in use/i,
    );
  });
});
