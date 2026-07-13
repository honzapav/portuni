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
  onMirrorRegistryChange,
} from "../apps/server/domain/sync/mirror-registry.js";
import { createClient } from "@libsql/client";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";

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

describe("mirror-registry change notifications", () => {
  it("notifies subscribers on register and unregister; unsubscribe stops it", async () => {
    let fired = 0;
    const unsubscribe = onMirrorRegistryChange(() => {
      fired += 1;
    });
    await registerMirror("U1", "N1", "/a");
    assert.equal(fired, 1);
    await unregisterMirror("U1", "N1");
    assert.equal(fired, 2);
    unsubscribe();
    await registerMirror("U1", "N2", "/b");
    assert.equal(fired, 2);
  });

  it("notifies once when stale cleanup removes mirrors, not when it removes none", async () => {
    await registerMirror("U1", "N_exists", "/a");
    await registerMirror("U1", "N_gone", "/b");
    const shared = createClient({ url: ":memory:" });
    await shared.execute("CREATE TABLE nodes (id TEXT PRIMARY KEY)");
    await shared.execute("INSERT INTO nodes (id) VALUES ('N_exists')");
    let fired = 0;
    const unsubscribe = onMirrorRegistryChange(() => {
      fired += 1;
    });
    await tryCleanStaleMirrors(shared, "U1");
    assert.equal(fired, 1);
    await tryCleanStaleMirrors(shared, "U1");
    assert.equal(fired, 1);
    unsubscribe();
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
