import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";
import { computeSyncPending } from "../apps/server/domain/sync/pending.js";
import { storeFile } from "../apps/server/domain/sync/engine.js";
import { reconcilePath } from "../apps/server/domain/sync/reconcile.js";
import type { GroupIdentityView } from "../apps/server/auth/node-access.js";
import { makeSharedDb } from "./helpers/shared-db.js";

// Admin sees every node regardless of ACL -- the existing tests below only
// care about untracked-file counting, not visibility filtering, so an
// admin identity preserves their original "everything is visible" behavior.
function adminIdentity(): GroupIdentityView {
  return { userId: SOLO_USER, globalScope: "admin", groups: [], groupIds: [] };
}

let workspace: string;
let originalRoot: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-pending-"));
  originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});
afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
  await rm(workspace, { recursive: true, force: true });
});

describe("computeSyncPending", () => {
  it("reports a node with an untracked local file as pending", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirror = join(workspace, "mirror-p");
    await mkdir(join(mirror, "wip"), { recursive: true });
    await writeFile(join(mirror, "wip", "draft.md"), "# unsynced\n");
    await registerMirror(SOLO_USER, shared.nodeId, mirror);

    const r = await computeSyncPending(shared.db, adminIdentity());

    const node = r.nodes.find((n) => n.node_id === shared.nodeId);
    assert.ok(node, "node with the untracked file must appear");
    assert.ok(node.untracked >= 1, "the untracked draft must be counted");
    assert.ok(node.total >= 1);
    assert.ok(r.total >= 1);
  });

  it("returns an empty aggregate when nothing is pending", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirror = join(workspace, "mirror-clean");
    await mkdir(join(mirror, "wip"), { recursive: true });
    await registerMirror(SOLO_USER, shared.nodeId, mirror);

    const r = await computeSyncPending(shared.db, adminIdentity());
    assert.deepEqual(r, { nodes: [], total: 0 });
  });

  // Task 14 point 7: a mirror for a node the caller can no longer see
  // (ACL restricted to a group they don't belong to) must not surface its
  // name/counts in the pending aggregate.
  it("excludes a mirror for a node restricted to a group the caller doesn't belong to", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    await shared.db.execute({
      sql: "UPDATE nodes SET visibility = 'group' WHERE id = ?",
      args: [shared.nodeId],
    });
    await shared.db.execute({
      sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
            VALUES (?, 'group', 'restricted-group@x.com', 'restricted-group@x.com', 'U1')`,
      args: [shared.nodeId],
    });
    const mirror = join(workspace, "mirror-restricted");
    await mkdir(join(mirror, "wip"), { recursive: true });
    await writeFile(join(mirror, "wip", "secret.md"), "# unsynced\n");
    await registerMirror(SOLO_USER, shared.nodeId, mirror);

    const outsider: GroupIdentityView = {
      userId: SOLO_USER,
      globalScope: "read",
      groups: [],
      groupIds: ["some-other-group-id"],
    };
    const r = await computeSyncPending(shared.db, outsider);

    assert.equal(
      r.nodes.find((n) => n.node_id === shared.nodeId),
      undefined,
      "revoked/restricted node must not appear in the pending list",
    );
    assert.ok(
      !JSON.stringify(r).includes("Stan GWS"),
      "restricted node's name must not leak anywhere in the response",
    );
  });

  it("a node whose only pending files are deleted_local is absent, total 0", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirror = join(workspace, "mirror-deleted");
    await mkdir(join(mirror, "wip"), { recursive: true });
    const fp = join(mirror, "wip", "doc.md");
    await writeFile(fp, "v1");
    await registerMirror(SOLO_USER, shared.nodeId, mirror);
    await storeFile(shared.db, { userId: SOLO_USER, nodeId: shared.nodeId, localPath: fp });
    await rm(fp);
    await reconcilePath(shared.db, { userId: SOLO_USER, nodeId: shared.nodeId, absPath: fp });

    const r = await computeSyncPending(shared.db, adminIdentity());

    assert.equal(
      r.nodes.find((n) => n.node_id === shared.nodeId),
      undefined,
      "a node with only deleted_local files must not appear",
    );
    assert.equal(r.total, 0);
  });

  it("a node with push and deleted_local is listed with total counting only the push", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirror = join(workspace, "mirror-mixed");
    await mkdir(join(mirror, "wip"), { recursive: true });
    const gone = join(mirror, "wip", "gone.md");
    await writeFile(gone, "v1");
    await registerMirror(SOLO_USER, shared.nodeId, mirror);
    await storeFile(shared.db, { userId: SOLO_USER, nodeId: shared.nodeId, localPath: gone });
    await rm(gone);
    await reconcilePath(shared.db, { userId: SOLO_USER, nodeId: shared.nodeId, absPath: gone });
    const newFile = join(mirror, "wip", "new.md");
    await writeFile(newFile, "new work");
    await reconcilePath(shared.db, { userId: SOLO_USER, nodeId: shared.nodeId, absPath: newFile });

    const r = await computeSyncPending(shared.db, adminIdentity());

    const node = r.nodes.find((n) => n.node_id === shared.nodeId);
    assert.ok(node, "the mixed node must appear");
    assert.equal(node.deleted_local, 1);
    assert.equal(node.total, node.push);
    assert.ok(node.push >= 1);
  });

  it("skips a mirror whose root directory was removed from disk", async () => {
    const shared = await makeSharedDb();
    setDbForTesting(shared.db);
    const mirror = join(workspace, "mirror-gone-entirely");
    await mkdir(join(mirror, "wip"), { recursive: true });
    await writeFile(join(mirror, "wip", "draft.md"), "# unsynced\n");
    await registerMirror(SOLO_USER, shared.nodeId, mirror);
    await rm(mirror, { recursive: true, force: true });

    const r = await computeSyncPending(shared.db, adminIdentity());

    assert.equal(
      r.nodes.find((n) => n.node_id === shared.nodeId),
      undefined,
      "a mirror whose root directory is gone must be skipped, not scanned",
    );
    assert.equal(r.total, 0);
  });
});
