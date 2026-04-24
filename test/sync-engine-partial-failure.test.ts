import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile, moveFile } from "../src/sync/engine.js";
import { registerMirror } from "../src/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/sync/local-db.js";

let workspace: string;
let originalEnv: string | undefined;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-partial-"));
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

describe("moveFile partial failure", () => {
  it(
    "returns repair_needed when local rename fails after remote succeeded",
    { skip: process.platform === "win32" },
    async () => {
      const { db, nodeId } = await makeSharedDb();
      const mirrorRoot = join(workspace, "mirror");
      await registerMirror("U1", nodeId, mirrorRoot);
      const src = join(workspace, "p.txt");
      await writeFile(src, "p");
      const { file_id } = await storeFile(db, { userId: "U1", nodeId, localPath: src });
      // Make outputs/ dir read-only so local rename fails. POSIX only.
      await mkdir(join(mirrorRoot, "outputs"), { recursive: true });
      await chmod(join(mirrorRoot, "outputs"), 0o500); // r-x no write
      try {
        const r = await moveFile(db, {
          userId: "U1",
          fileId: file_id,
          newSection: "outputs",
          confirmed: true,
        });
        assert.equal((r as { status?: string }).status, "repair_needed");
        // DB reflects remote truth.
        const row = await db.execute({
          sql: "SELECT remote_path FROM files WHERE id = ?",
          args: [file_id],
        });
        assert.ok((row.rows[0].remote_path as string).includes("/outputs/"));
      } finally {
        await chmod(join(mirrorRoot, "outputs"), 0o700); // restore for teardown
      }
    },
  );
});
