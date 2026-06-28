// Phase B (B1+B2): mirror-less, Drive-direct file content over the central
// server. These tests exercise readFileContentRemote / writeFileContentRemote
// against the shared-db fs remote (no mirror registered), covering remote
// read, remote write, hash-based conflict, native-format rejection, and the
// missing-remote / not-found error shapes.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { resetAdapterCacheForTests, getAdapter } from "../apps/server/domain/sync/adapter-cache.js";
import { resolveNodeInfo } from "../apps/server/domain/sync/node-info.js";
import { buildRemotePath, type Section } from "../apps/server/domain/sync/remote-path.js";
import { sha256Buffer } from "../apps/server/domain/sync/hash.js";
import { replaceRules } from "../apps/server/domain/sync/routing.js";
import { FileContentError } from "../apps/server/domain/sync/file-content.js";
import {
  readFileContentRemote,
  writeFileContentRemote,
  createFileRemote,
  renameFileRemote,
  deleteFileRemote,
} from "../apps/server/domain/sync/file-content-remote.js";

let shared: SharedDb;
let workspace: string;
let originalEnv: string | undefined;

async function remotePathFor(relPath: string): Promise<string> {
  const info = await resolveNodeInfo(shared.db, shared.nodeId);
  const segs = relPath.split("/");
  const section = segs[0] as Section;
  const filename = segs[segs.length - 1];
  const subpath = segs.length > 2 ? segs.slice(1, -1).join("/") : null;
  return buildRemotePath({ ...info, section, subpath, filename });
}

// Put bytes straight onto the routed fs remote at the node's remote path,
// bypassing the mirror (which a central client does not have).
async function seedRemote(relPath: string, content: string): Promise<string> {
  const remotePath = await remotePathFor(relPath);
  const adapter = await getAdapter(shared.db, "test-fs");
  await adapter.put(remotePath, Buffer.from(content, "utf8"));
  return remotePath;
}

async function insertFileRow(
  relPath: string,
  opts: { hash?: string | null; isNative?: boolean } = {},
): Promise<string> {
  const remotePath = await remotePathFor(relPath);
  const id = ulid();
  await shared.db.execute({
    sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path,
                             current_remote_hash, is_native_format, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      shared.nodeId,
      relPath.split("/").pop()!,
      "test-fs",
      remotePath,
      opts.hash ?? null,
      opts.isNative ? 1 : 0,
      "U1",
    ],
  });
  return id;
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-filecontent-remote-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetAdapterCacheForTests();
  shared = await makeSharedDb();
});

afterEach(async () => {
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

describe("readFileContentRemote", () => {
  it("reads remote bytes and returns content + sha256 version", async () => {
    await seedRemote("wip/x.md", "# hi\n");
    const r = await readFileContentRemote(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      relPath: "wip/x.md",
    });
    assert.equal(r.content, "# hi\n");
    assert.equal(r.filename, "x.md");
    assert.equal(r.mime_type, "text/markdown");
    assert.equal(r.version, sha256Buffer(Buffer.from("# hi\n", "utf8")));
  });

  it("throws NOT_FOUND when the remote object is absent", async () => {
    await assert.rejects(
      () =>
        readFileContentRemote(shared.db, {
          userId: "U1",
          nodeId: shared.nodeId,
          relPath: "wip/nope.md",
        }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_FOUND",
    );
  });

  it("throws NO_REMOTE when the node has no routed remote", async () => {
    await replaceRules(shared.db, []);
    resetAdapterCacheForTests();
    await assert.rejects(
      () =>
        readFileContentRemote(shared.db, {
          userId: "U1",
          nodeId: shared.nodeId,
          relPath: "wip/x.md",
        }),
      (e: unknown) => e instanceof FileContentError && e.code === "NO_REMOTE",
    );
  });

  it("throws INVALID_PATH on traversal", async () => {
    await assert.rejects(
      () =>
        readFileContentRemote(shared.db, {
          userId: "U1",
          nodeId: shared.nodeId,
          relPath: "wip/../../escape",
        }),
      (e: unknown) => e instanceof FileContentError && e.code === "INVALID_PATH",
    );
  });
});

describe("writeFileContentRemote", () => {
  it("writes bytes to the remote and returns a new version", async () => {
    const w = await writeFileContentRemote(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      relPath: "wip/new.md",
      content: "hello",
    });
    assert.equal(w.version, sha256Buffer(Buffer.from("hello", "utf8")));
    const adapter = await getAdapter(shared.db, "test-fs");
    const onRemote = await adapter.get(await remotePathFor("wip/new.md"));
    assert.equal(onRemote.toString("utf8"), "hello");
  });

  it("updates the Turso canonical hash on the file record after a write", async () => {
    await seedRemote("wip/x.md", "v1");
    const fileId = await insertFileRow("wip/x.md", { hash: "stale" });
    await writeFileContentRemote(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      relPath: "wip/x.md",
      content: "v2",
    });
    const row = await shared.db.execute({
      sql: "SELECT current_remote_hash, last_pushed_by FROM files WHERE id = ?",
      args: [fileId],
    });
    // fs adapter reports sha256 of the put bytes as its canonical hash.
    assert.equal(row.rows[0].current_remote_hash, sha256Buffer(Buffer.from("v2", "utf8")));
    assert.equal(row.rows[0].last_pushed_by, "U1");
  });

  it("accepts a save when baseVersion matches the current remote bytes", async () => {
    await seedRemote("wip/x.md", "v1");
    const read = await readFileContentRemote(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      relPath: "wip/x.md",
    });
    const w = await writeFileContentRemote(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      relPath: "wip/x.md",
      content: "v2",
      baseVersion: read.version,
    });
    assert.notEqual(w.version, read.version);
    const adapter = await getAdapter(shared.db, "test-fs");
    const onRemote = await adapter.get(await remotePathFor("wip/x.md"));
    assert.equal(onRemote.toString("utf8"), "v2");
  });

  it("throws CONFLICT against the remote hash when baseVersion is stale", async () => {
    await seedRemote("wip/x.md", "remote-current");
    await assert.rejects(
      () =>
        writeFileContentRemote(shared.db, {
          userId: "U1",
          nodeId: shared.nodeId,
          relPath: "wip/x.md",
          content: "mine",
          baseVersion: "0".repeat(64),
        }),
      (e: unknown) =>
        e instanceof FileContentError &&
        e.code === "CONFLICT" &&
        e.currentVersion === sha256Buffer(Buffer.from("remote-current", "utf8")),
    );
  });

  it("force:true overwrites despite a stale baseVersion", async () => {
    await seedRemote("wip/x.md", "remote-current");
    await writeFileContentRemote(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      relPath: "wip/x.md",
      content: "mine",
      baseVersion: "0".repeat(64),
      force: true,
    });
    const adapter = await getAdapter(shared.db, "test-fs");
    const onRemote = await adapter.get(await remotePathFor("wip/x.md"));
    assert.equal(onRemote.toString("utf8"), "mine");
  });

  it("rejects PUT to a native-format file with NOT_EDITABLE", async () => {
    await seedRemote("wip/doc.md", "placeholder");
    await insertFileRow("wip/doc.md", { isNative: true });
    await assert.rejects(
      () =>
        writeFileContentRemote(shared.db, {
          userId: "U1",
          nodeId: shared.nodeId,
          relPath: "wip/doc.md",
          content: "edit",
        }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_EDITABLE",
    );
  });
});

describe("createFileRemote (B3)", () => {
  it("writes bytes to the remote and registers a tracked file record", async () => {
    const f = await createFileRemote(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      filename: "notes.md",
      content: "# Notes\n",
    });
    assert.equal(f.filename, "notes.md");
    assert.equal(f.relative_path, "wip/notes.md");
    assert.equal(f.mime_type, "text/markdown");
    assert.ok(f.id.length > 0);

    const row = await shared.db.execute({
      sql: "SELECT node_id, remote_name, remote_path, current_remote_hash, is_native_format FROM files WHERE id = ?",
      args: [f.id],
    });
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].node_id, shared.nodeId);
    assert.equal(row.rows[0].remote_name, "test-fs");
    assert.equal(row.rows[0].remote_path, await remotePathFor("wip/notes.md"));
    assert.equal(row.rows[0].current_remote_hash, sha256Buffer(Buffer.from("# Notes\n", "utf8")));
    assert.equal(Number(row.rows[0].is_native_format), 0);

    const adapter = await getAdapter(shared.db, "test-fs");
    const onRemote = await adapter.get(await remotePathFor("wip/notes.md"));
    assert.equal(onRemote.toString("utf8"), "# Notes\n");
  });

  it("supports section + subpath placement", async () => {
    const f = await createFileRemote(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      filename: "spec.md",
      section: "outputs",
      subpath: "sub/dir",
      content: "x",
    });
    assert.equal(f.relative_path, "outputs/sub/dir/spec.md");
    assert.equal(f.status, "output");
    const adapter = await getAdapter(shared.db, "test-fs");
    const onRemote = await adapter.get(await remotePathFor("outputs/sub/dir/spec.md"));
    assert.equal(onRemote.toString("utf8"), "x");
  });

  it("throws EXISTS when the remote object already exists", async () => {
    await seedRemote("wip/a.md", "old");
    await assert.rejects(
      () =>
        createFileRemote(shared.db, {
          userId: "U1",
          nodeId: shared.nodeId,
          filename: "a.md",
          content: "new",
        }),
      (e: unknown) => e instanceof FileContentError && e.code === "EXISTS",
    );
  });

  it("throws INVALID_PATH for a bad filename", async () => {
    await assert.rejects(
      () =>
        createFileRemote(shared.db, {
          userId: "U1",
          nodeId: shared.nodeId,
          filename: "../escape.md",
          content: "x",
        }),
      (e: unknown) => e instanceof FileContentError && e.code === "INVALID_PATH",
    );
  });

  it("throws NO_REMOTE when the node has no routed remote", async () => {
    await replaceRules(shared.db, []);
    resetAdapterCacheForTests();
    await assert.rejects(
      () =>
        createFileRemote(shared.db, {
          userId: "U1",
          nodeId: shared.nodeId,
          filename: "a.md",
          content: "x",
        }),
      (e: unknown) => e instanceof FileContentError && e.code === "NO_REMOTE",
    );
  });
});

describe("renameFileRemote (B3)", () => {
  it("renames the remote object and updates the tracked record", async () => {
    await seedRemote("wip/old.md", "body");
    const fileId = await insertFileRow("wip/old.md", { hash: "h" });
    const r = await renameFileRemote(shared.db, {
      userId: "U1",
      fileId,
      newFilename: "new.md",
    });
    assert.equal(r.new_filename, "new.md");
    assert.equal(r.new_remote_path, await remotePathFor("wip/new.md"));
    assert.equal(r.status, "ok");

    const row = await shared.db.execute({
      sql: "SELECT filename, remote_path FROM files WHERE id = ?",
      args: [fileId],
    });
    assert.equal(row.rows[0].filename, "new.md");
    assert.equal(row.rows[0].remote_path, await remotePathFor("wip/new.md"));

    const adapter = await getAdapter(shared.db, "test-fs");
    const onRemote = await adapter.get(await remotePathFor("wip/new.md"));
    assert.equal(onRemote.toString("utf8"), "body");
  });

  it("throws on an invalid new filename", async () => {
    await seedRemote("wip/old.md", "body");
    const fileId = await insertFileRow("wip/old.md");
    await assert.rejects(
      () => renameFileRemote(shared.db, { userId: "U1", fileId, newFilename: "a/b.md" }),
      /Invalid filename/,
    );
  });
});

describe("deleteFileRemote (B3)", () => {
  it("returns a confirm-first preview when not confirmed", async () => {
    await seedRemote("wip/x.md", "body");
    const fileId = await insertFileRow("wip/x.md");
    const r = await deleteFileRemote(shared.db, { userId: "U1", fileId, mode: "complete" });
    assert.ok("requires_confirmation" in r && r.requires_confirmation === true);
    if ("requires_confirmation" in r) {
      assert.deepEqual(r.preview.will_remove_from, ["remote", "portuni"]);
    }
    // nothing deleted yet
    const adapter = await getAdapter(shared.db, "test-fs");
    assert.ok(await adapter.stat(await remotePathFor("wip/x.md")));
  });

  it("deletes the remote object and the tracked record when confirmed", async () => {
    await seedRemote("wip/x.md", "body");
    const fileId = await insertFileRow("wip/x.md");
    const r = await deleteFileRemote(shared.db, {
      userId: "U1",
      fileId,
      mode: "complete",
      confirmed: true,
    });
    assert.ok("status" in r && r.status === "ok");
    const row = await shared.db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [fileId] });
    assert.equal(row.rows.length, 0);
    const adapter = await getAdapter(shared.db, "test-fs");
    assert.equal(await adapter.stat(await remotePathFor("wip/x.md")), null);
  });
});
