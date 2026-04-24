import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerMirror,
  getMirrorPath,
  unregisterMirror,
  listUserMirrors,
  tryCleanStaleMirrors,
} from "../src/sync/mirror-registry.js";
import { createClient } from "@libsql/client";
import { resetLocalDbForTests } from "../src/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-mirreg-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("mirror-registry basic", () => {
  it("register + get + unregister", async () => {
    await registerMirror("U1", "N1", "/a");
    assert.equal(await getMirrorPath("U1", "N1"), "/a");
    await unregisterMirror("U1", "N1");
    assert.equal(await getMirrorPath("U1", "N1"), null);
  });
});

describe("mirror-registry stale cleanup", () => {
  it("removes rows whose node_id no longer exists in shared DB", async () => {
    await registerMirror("U1", "N_exists", "/a");
    await registerMirror("U1", "N_gone", "/b");
    const shared = createClient({ url: ":memory:" });
    await shared.execute("CREATE TABLE nodes (id TEXT PRIMARY KEY)");
    await shared.execute("INSERT INTO nodes (id) VALUES ('N_exists')");
    const report = await tryCleanStaleMirrors(shared, "U1");
    assert.equal(report.removed.length, 1);
    assert.equal(report.removed[0], "N_gone");
    const all = await listUserMirrors("U1");
    assert.equal(all.length, 1);
    assert.equal(all[0].node_id, "N_exists");
  });
});
