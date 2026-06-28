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
import { makeSharedDb } from "./helpers/shared-db.js";

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

    const r = await computeSyncPending(shared.db, SOLO_USER);

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

    const r = await computeSyncPending(shared.db, SOLO_USER);
    assert.deepEqual(r, { nodes: [], total: 0 });
  });
});
