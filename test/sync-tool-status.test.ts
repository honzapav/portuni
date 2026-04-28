import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { statusScan } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-tool-status-"));
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

describe("portuni_status discovery", () => {
  it("surfaces new_local when a file sits in the mirror but has no files row", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip", "sub"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "sub", "note.md"), "n");
    const scan = await statusScan(db, {
      userId: "U1",
      nodeId,
      includeDiscovery: true,
    });
    assert.ok(scan.new_local.find((e) => e.filename === "note.md"));
  });

  it("omits new_local when includeDiscovery is false", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.txt"), "x");
    const scan = await statusScan(db, {
      userId: "U1",
      nodeId,
      includeDiscovery: false,
    });
    assert.equal(scan.new_local.length, 0);
  });
});
