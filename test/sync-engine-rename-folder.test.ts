import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, renameFolder } from "../src/sync/engine.js";
import { registerMirror } from "../src/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-rename-"));
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
});
