// registerLocalFile: register a brand-new local file WITHOUT uploading it.
// This is the "auto git add, don't push" capability the deterministic
// file-state watcher needs -- a file created through Portuni is tracked
// immediately and shows as pending-upload, but the bytes only reach the
// remote on a deliberate sync.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { registerLocalFile, statusScan } from "../apps/server/domain/sync/engine.js";
import {
  getFileState,
  resetLocalDbForTests,
} from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-reg-"));
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

describe("registerLocalFile", () => {
  it("registers a local file without uploading it to the remote", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const fp = join(mirrorRoot, "wip", "note.md");
    await writeFile(fp, "hello");

    const res = await registerLocalFile(db, {
      userId: "U1",
      nodeId,
      localPath: fp,
    });

    // files row exists, routed, but never pushed.
    const rows = await db.execute({
      sql: "SELECT filename, remote_name, current_remote_hash, last_pushed_at FROM files WHERE id = ?",
      args: [res.file_id],
    });
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].filename, "note.md");
    assert.equal(rows.rows[0].remote_name, "test-fs");
    assert.equal(rows.rows[0].current_remote_hash, null);
    assert.equal(rows.rows[0].last_pushed_at, null);

    // file_state: local hash cached, no synced baseline.
    const st = await getFileState(res.file_id);
    assert.ok(st);
    assert.equal(st.last_synced_hash, null);
    assert.ok(st.cached_local_hash);

    // Nothing reached the remote.
    const remoteEntries = await readdir(remoteRoot, { recursive: true }).catch(
      () => [] as string[],
    );
    assert.equal(
      (remoteEntries as string[]).some((f) => String(f).endsWith("note.md")),
      false,
    );
  });

  it("classifies a register-only file as push (pending upload), not orphan", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    const fp = join(mirrorRoot, "wip", "note.md");
    await writeFile(fp, "hello");
    await registerLocalFile(db, { userId: "U1", nodeId, localPath: fp });

    const scan = await statusScan(db, {
      userId: "U1",
      nodeId,
      fast: true,
      includeDiscovery: false,
    });
    assert.deepEqual(
      scan.push_candidates.map((f) => f.filename),
      ["note.md"],
    );
    assert.equal(scan.orphan.length, 0);
  });
});
