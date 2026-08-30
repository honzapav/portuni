import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import {
  snapshotService,
  __setSnapshotExporterForTests,
  __resetSnapshotExporterForTests,
} from "../apps/server/mcp/tools/sync-snapshot.js";

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

  it("stores remote-direct when the node has no local mirror (central serving a teammate)", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    __setSnapshotExporterForTests(async () => Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
    const r = await snapshotService(db, {
      userId: "U1",
      nodeId,
      docUrl: "https://docs.google.com/document/d/ABC123/edit",
      format: "pdf",
      filename: "spec.pdf",
      subpath: "archive",
    });
    assert.equal(r.filename, "spec.pdf");
    assert.ok(r.remote_path.endsWith("/wip/archive/spec.pdf"));

    const row = await db.execute({
      sql: "SELECT node_id, remote_name, remote_path, mime_type, is_native_format FROM files WHERE id = ?",
      args: [r.file_id],
    });
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].node_id, nodeId);
    assert.equal(row.rows[0].remote_name, "test-fs");
    assert.equal(row.rows[0].remote_path, r.remote_path);
    assert.equal(row.rows[0].mime_type, "application/pdf");
    assert.equal(Number(row.rows[0].is_native_format), 0);

    const onRemote = await readFile(join(remoteRoot, r.remote_path));
    assert.deepEqual([...onRemote], [0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
  });

  it("falls back to the export MIME type for an extension the MIME table does not know", async () => {
    const { db, nodeId } = await makeSharedDb();
    __setSnapshotExporterForTests(async () => Buffer.from("docx-bytes"));
    const r = await snapshotService(db, {
      userId: "U1",
      nodeId,
      docUrl: "https://docs.google.com/document/d/ABC123/edit",
      format: "docx",
    });
    assert.ok(r.filename.endsWith(".docx"));
    const row = await db.execute({
      sql: "SELECT mime_type FROM files WHERE id = ?",
      args: [r.file_id],
    });
    assert.equal(
      row.rows[0].mime_type,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });
});
