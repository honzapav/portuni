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
