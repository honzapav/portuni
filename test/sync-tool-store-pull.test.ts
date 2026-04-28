import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-tool-store-"));
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

describe("portuni_list_files sql + derivation", () => {
  it("SELECT with JOIN and subselect returns enriched rows", async () => {
    const { db, nodeId, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "t.txt");
    await writeFile(src, "t");
    await storeFile(db, { userId: "U1", nodeId, localPath: src });
    const r = await db.execute({
      sql: `SELECT f.id, f.node_id, n.name AS node_name, n.type AS node_type, n.sync_key AS node_sync_key,
                   f.filename, f.remote_path,
                   (SELECT org.sync_key FROM edges e JOIN nodes org ON org.id = e.target_id
                    WHERE e.source_id = f.node_id AND e.relation = 'belongs_to' AND org.type = 'organization' LIMIT 1) AS org_sync_key
            FROM files f JOIN nodes n ON f.node_id = n.id`,
    });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].org_sync_key, orgSyncKey);
    assert.equal(r.rows[0].node_sync_key, nodeSyncKey);
    assert.ok(
      (r.rows[0].remote_path as string).startsWith(`${orgSyncKey}/projects/${nodeSyncKey}/`),
    );
  });
});
