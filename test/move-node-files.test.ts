import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, statusScan } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { moveNodeToOrganization } from "../src/domain/edges.js";
import { addRule, upsertRemote } from "../src/domain/sync/routing.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-orgmove-"));
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

const ORG2_ID = "N000000000000000000000ORG2";

async function addSecondOrg(db: Awaited<ReturnType<typeof makeSharedDb>>["db"]) {
  await db.execute({
    sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
    args: [ORG2_ID, "organization", "Acme", "acme", "U1"],
  });
}

describe("moveNodeToOrganization migrates tracked files", () => {
  it("rewrites remote_path and renames the remote file to the new org root", async () => {
    const { db, nodeId, remoteRoot, orgSyncKey, nodeSyncKey } = await makeSharedDb();
    await addSecondOrg(db);
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "doc.md");
    await writeFile(src, "v1");
    const { file_id, remote_path } = await storeFile(db, {
      userId: "U1",
      nodeId,
      localPath: src,
    });
    assert.ok(remote_path.startsWith(`${orgSyncKey}/projects/${nodeSyncKey}/`));

    const result = await moveNodeToOrganization(db, "U1", nodeId, ORG2_ID);
    assert.equal(result.moved, true);

    const row = await db.execute({
      sql: "SELECT remote_path FROM files WHERE id = ?",
      args: [file_id],
    });
    const newRemote = row.rows[0].remote_path as string;
    assert.ok(
      newRemote.startsWith(`acme/projects/${nodeSyncKey}/`),
      `remote_path must move under the new org root, got ${newRemote}`,
    );
    // The physical remote file moved (fs remote root = plain directory).
    await stat(join(remoteRoot, newRemote));
    await assert.rejects(() => stat(join(remoteRoot, remote_path)));

    // And the scan must not classify the file as orphan afterwards.
    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: false });
    assert.ok(
      !scan.orphan.some((f) => f.file_id === file_id),
      "file must not be orphaned by the org move",
    );
  });

  it("refuses the move when the new org routes to a different remote", async () => {
    const { db, nodeId } = await makeSharedDb();
    await addSecondOrg(db);
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    const src = join(workspace, "doc.md");
    await writeFile(src, "v1");
    await storeFile(db, { userId: "U1", nodeId, localPath: src });

    const otherRoot = join(workspace, "other-remote");
    await upsertRemote(db, {
      name: "other-fs",
      type: "fs",
      config: { root: otherRoot },
      created_by: "U1",
    });
    await addRule(db, { priority: 5, node_type: null, org_slug: "acme", remote_name: "other-fs" });

    await assert.rejects(
      () => moveNodeToOrganization(db, "U1", nodeId, ORG2_ID),
      /remote/i,
    );
    // Edge must be untouched on refusal.
    const edge = await db.execute({
      sql: "SELECT target_id FROM edges WHERE source_id = ? AND relation = 'belongs_to'",
      args: [nodeId],
    });
    assert.notEqual(edge.rows[0].target_id, ORG2_ID);
  });

  it("moves a node without tracked files as before", async () => {
    const { db, nodeId } = await makeSharedDb();
    await addSecondOrg(db);
    const result = await moveNodeToOrganization(db, "U1", nodeId, ORG2_ID);
    assert.equal(result.moved, true);
    const edge = await db.execute({
      sql: "SELECT target_id FROM edges WHERE source_id = ? AND relation = 'belongs_to'",
      args: [nodeId],
    });
    assert.equal(edge.rows[0].target_id, ORG2_ID);
  });
});
