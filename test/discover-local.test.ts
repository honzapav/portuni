import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { storeFile } from "../src/domain/sync/engine.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { listUntrackedLocal } from "../src/domain/sync/discover-local.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-discover-"));
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

describe("listUntrackedLocal", () => {
  it("returns files on disk that are not registered", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "docs"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "loose.md"), "x");
    await writeFile(join(mirrorRoot, "wip", "docs", "deep.md"), "y");

    const out = await listUntrackedLocal(db, { userId: "U1", nodeId });
    const rels = out.map((u) => [u.section, u.subpath, u.filename]).sort();
    assert.deepEqual(rels, [
      ["wip", null, "loose.md"],
      ["wip", "docs", "deep.md"],
    ]);
  });

  it("excludes registered files", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const src = join(workspace, "reg.md");
    await writeFile(src, "z");
    await storeFile(db, { userId: "U1", nodeId, localPath: src }); // -> wip/reg.md, tracked

    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "loose.md"), "x");

    const out = await listUntrackedLocal(db, { userId: "U1", nodeId });
    assert.equal(out.length, 1);
    assert.equal(out[0].filename, "loose.md");
  });

  it("returns [] when there is no mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const out = await listUntrackedLocal(db, { userId: "U1", nodeId });
    assert.deepEqual(out, []);
  });
});
