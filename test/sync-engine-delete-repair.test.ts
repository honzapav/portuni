import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, deleteFile } from "../src/sync/engine.js";
import { registerMirror } from "../src/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/sync/adapter-cache.js";
import { resetLocalDbForTests, getFileState } from "../src/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-del-repair-"));
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

describe("deleteFile remote-failure repair contract", () => {
  it(
    "returns repair_needed and keeps DB row + local file when remote delete fails",
    { skip: process.platform === "win32" },
    async () => {
      const { db, nodeId, remoteRoot } = await makeSharedDb();
      const mirrorRoot = join(workspace, "mirror");
      await registerMirror("U1", nodeId, mirrorRoot);
      const src = join(workspace, "x.txt");
      await writeFile(src, "x");
      const { file_id, local_path } = await storeFile(db, {
        userId: "U1",
        nodeId,
        localPath: src,
      });

      // Look up where the file landed on the fs remote, then lock the
      // immediate parent directory so the adapter cannot unlink it.
      const fileRow = await db.execute({
        sql: "SELECT remote_path FROM files WHERE id = ?",
        args: [file_id],
      });
      const remotePath = fileRow.rows[0].remote_path as string;
      const remoteParent = join(remoteRoot, remotePath.split("/").slice(0, -1).join("/"));
      await chmod(remoteParent, 0o500);

      try {
        const r = await deleteFile(db, {
          userId: "U1",
          fileId: file_id,
          mode: "complete",
          confirmed: true,
        });

        assert.equal((r as { status?: string }).status, "repair_needed");
        const row = await db.execute({
          sql: "SELECT id FROM files WHERE id = ?",
          args: [file_id],
        });
        assert.equal(row.rows.length, 1, "DB row must survive remote failure");
        assert.equal(await exists(local_path), true, "local file must survive");
        assert.notEqual(await getFileState(file_id), null, "per-device state survives");

        const audit = await db.execute({
          sql: "SELECT action FROM audit_log WHERE target_id = ? ORDER BY timestamp DESC",
          args: [file_id],
        });
        assert.ok(
          audit.rows.some((r) => r.action === "sync_delete_repair_needed"),
          "repair_needed event is audited",
        );
      } finally {
        await chmod(remoteParent, 0o700);
      }
    },
  );
});
