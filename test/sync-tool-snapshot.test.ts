import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import {
  snapshotService,
  __setSnapshotExporterForTests,
  __resetSnapshotExporterForTests,
} from "../src/mcp/tools/sync-snapshot.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-snapshot-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  __resetSnapshotExporterForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("portuni_snapshot", () => {
  it("exports and stores the resulting file", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    __setSnapshotExporterForTests(async (_db, _nid, _url, format) => {
      return Buffer.from(`pretend-${format}`);
    });
    const r = await snapshotService(db, {
      userId: "U1",
      nodeId,
      docUrl: "https://docs.google.com/document/d/ABC123/edit",
      format: "pdf",
    });
    assert.ok(r.file_id.length > 0);
    assert.ok(r.remote_path.includes("/wip/"));
    assert.ok(r.filename.endsWith(".pdf"));
  });
});
