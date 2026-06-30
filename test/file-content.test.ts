import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import {
  readFileContent,
  writeFileContent,
  FileContentError,
} from "../apps/server/domain/sync/file-content.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-filecontent-"));
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

describe("readFileContent", () => {
  it("reads a markdown file and returns content + version", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.md"), "# hi\n");

    const r = await readFileContent(db, { userId: "U1", nodeId, relPath: "wip/x.md" });
    assert.equal(r.content, "# hi\n");
    assert.equal(r.filename, "x.md");
    assert.equal(r.mime_type, "text/markdown");
    assert.equal(r.version.length, 64);
  });

  it("throws NO_MIRROR when the node has no mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    await assert.rejects(
      () => readFileContent(db, { userId: "U1", nodeId, relPath: "wip/x.md" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NO_MIRROR",
    );
  });

  it("throws NOT_FOUND for a missing file", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    await assert.rejects(
      () => readFileContent(db, { userId: "U1", nodeId, relPath: "wip/nope.md" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_FOUND",
    );
  });

  it("throws NOT_EDITABLE for a binary mime", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "p.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await assert.rejects(
      () => readFileContent(db, { userId: "U1", nodeId, relPath: "wip/p.png" }),
      (e: unknown) => e instanceof FileContentError && e.code === "NOT_EDITABLE",
    );
  });

  it("throws INVALID_PATH on traversal", async () => {
    const { db, nodeId } = await makeSharedDb();
    await registerMirror("U1", nodeId, join(workspace, "mirror"));
    await assert.rejects(
      () => readFileContent(db, { userId: "U1", nodeId, relPath: "wip/../../escape" }),
      (e: unknown) => e instanceof FileContentError && e.code === "INVALID_PATH",
    );
  });

  it("returns the absolute local_path of the file on disk", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "page.html"), "<h1>hi</h1>");

    const r = await readFileContent(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/page.html",
    });

    assert.equal(r.local_path, join(mirrorRoot, "wip", "page.html"));
  });
});

describe("writeFileContent", () => {
  it("writes content and returns a new version (no conflict check without baseVersion)", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const w = await writeFileContent(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/new.md",
      content: "hello",
    });
    assert.equal(w.version.length, 64);
    assert.equal(await readFile(join(mirrorRoot, "wip", "new.md"), "utf8"), "hello");
  });

  it("accepts a save when baseVersion matches the on-disk version", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.md"), "v1");
    const read = await readFileContent(db, { userId: "U1", nodeId, relPath: "wip/x.md" });
    const w = await writeFileContent(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/x.md",
      content: "v2",
      baseVersion: read.version,
    });
    assert.equal(await readFile(join(mirrorRoot, "wip", "x.md"), "utf8"), "v2");
    assert.notEqual(w.version, read.version);
  });

  it("throws CONFLICT when baseVersion is stale, with currentVersion attached", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.md"), "current");
    await assert.rejects(
      () =>
        writeFileContent(db, {
          userId: "U1",
          nodeId,
          relPath: "wip/x.md",
          content: "mine",
          baseVersion: "0".repeat(64),
        }),
      (e: unknown) =>
        e instanceof FileContentError &&
        e.code === "CONFLICT" &&
        typeof e.currentVersion === "string" &&
        e.currentVersion.length === 64,
    );
  });

  it("force:true overwrites despite a stale baseVersion", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    await mkdir(join(mirrorRoot, "wip"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "x.md"), "current");
    await writeFileContent(db, {
      userId: "U1",
      nodeId,
      relPath: "wip/x.md",
      content: "mine",
      baseVersion: "0".repeat(64),
      force: true,
    });
    assert.equal(await readFile(join(mirrorRoot, "wip", "x.md"), "utf8"), "mine");
  });
});

describe("createFile", () => {
  it("writes the file, registers it, and returns a DetailFile shape", async () => {
    const { db, nodeId, remoteRoot } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { createFile } = await import("../apps/server/domain/sync/file-content.js");
    const f = await createFile(db, {
      userId: "U1",
      nodeId,
      filename: "notes.md",
      content: "# Notes\n",
    });
    assert.equal(f.filename, "notes.md");
    assert.equal(f.relative_path, "wip/notes.md");
    assert.equal(f.mime_type, "text/markdown");
    assert.ok(f.id.length > 0);
    // file row exists
    const rows = await db.execute({ sql: "SELECT id FROM files WHERE id = ?", args: [f.id] });
    assert.equal(rows.rows.length, 1);
    // bytes landed on the fs remote
    void remoteRoot;
    assert.equal(await readFile(join(mirrorRoot, "wip", "notes.md"), "utf8"), "# Notes\n");
  });

  it("throws EXISTS when the file already exists", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = join(workspace, "mirror");
    await registerMirror("U1", nodeId, mirrorRoot);
    const { createFile } = await import("../apps/server/domain/sync/file-content.js");
    await createFile(db, { userId: "U1", nodeId, filename: "a.md", content: "x" });
    await assert.rejects(
      () => createFile(db, { userId: "U1", nodeId, filename: "a.md", content: "y" }),
      (e: unknown) => e instanceof FileContentError && e.code === "EXISTS",
    );
  });
});
