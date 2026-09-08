// mcp/read-file-spill.ts: portuni_read_file inline-vs-spill decision (#252).
// A file over the 1 MB inline cap, or a caller passing as_path: true, is
// spilled to a path inside the session's projection directory instead of
// being returned inline -- see the file's own header comment for the two
// sources (local mirror hardlink vs a remote download).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileOrSpill, type RemoteRawFetch } from "../apps/server/mcp/read-file-spill.js";
import { createDiskProjector, type DiskProjector } from "../apps/server/mcp/disk-projection.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { MAX_READ_BYTES } from "../apps/server/domain/read-node-file.js";

const HOME = "01HOME00000000000000000000";
const ADHOC = "01ADHOC0000000000000000000";
const REMOTE_ONLY = "01REMOTE000000000000000000";

let dir: string;
let homeMirror: string;
let adhocMirror: string;
let originalPortuniRoot: string | undefined;
let originalWorkspaceRoot: string | undefined;

function projectorFor(homeNodeId: string | null): DiskProjector {
  return createDiskProjector({
    userId: "U1",
    scope: {
      homeNodeId,
      has: () => true,
      isSeed: () => false,
      projectionSessionId: "SESS",
    },
  });
}

const NEVER_CALLED: RemoteRawFetch = async () => {
  throw new Error("remote fetch should not be called when a local mirror exists");
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-readfilespill-"));
  homeMirror = join(dir, "home");
  adhocMirror = join(dir, "adhoc");
  await mkdir(join(homeMirror, "wip"), { recursive: true });
  await mkdir(join(adhocMirror, "wip"), { recursive: true });
  originalPortuniRoot = process.env.PORTUNI_ROOT;
  originalWorkspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_ROOT = dir;
  process.env.PORTUNI_WORKSPACE_ROOT = dir;
  resetLocalDbForTests();
  await registerMirror("U1", HOME, homeMirror);
  await registerMirror("U1", ADHOC, adhocMirror);
});

afterEach(async () => {
  if (originalPortuniRoot === undefined) delete process.env.PORTUNI_ROOT;
  else process.env.PORTUNI_ROOT = originalPortuniRoot;
  if (originalWorkspaceRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalWorkspaceRoot;
  resetLocalDbForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("readFileOrSpill: local mirror present", () => {
  it("returns small text content inline, without touching the projector", async () => {
    await writeFile(join(homeMirror, "wip", "notes.md"), "hello\n");
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: HOME,
      relPath: "wip/notes.md",
      asPath: false,
      remote: NEVER_CALLED,
    });
    assert.equal(out.isError, undefined);
    assert.equal(out.content[0].text, "hello\n");
  });

  it("as_path on the home node spills to its own real mirror path (no projection needed)", async () => {
    await writeFile(join(homeMirror, "wip", "notes.md"), "hello\n");
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: HOME,
      relPath: "wip/notes.md",
      asPath: true,
      remote: NEVER_CALLED,
    });
    const payload = JSON.parse(out.content[0].text) as { path: string; bytes: number; mime: string };
    assert.equal(payload.path, join(homeMirror, "wip", "notes.md"));
    assert.equal(payload.bytes, 6);
    assert.equal(payload.mime, "text/markdown");
  });

  it("a file over the inline limit spills to the projection directory for a non-home node", async () => {
    const big = Buffer.alloc(MAX_READ_BYTES + 1024, "a");
    await writeFile(join(adhocMirror, "wip", "big.txt"), big);
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: ADHOC,
      relPath: "wip/big.txt",
      asPath: false,
      remote: NEVER_CALLED,
    });
    const payload = JSON.parse(out.content[0].text) as { path: string; bytes: number; mime: string };
    assert.equal(payload.bytes, big.length);
    assert.equal(payload.path, join(dir, ".portuni-sessions", HOME, "SESS", ADHOC, "wip", "big.txt"));
    assert.equal(await readFile(payload.path, "utf8"), big.toString("utf8"));
  });

  it("as_path on a small file for a non-home node also spills, via the same hardlink projection", async () => {
    await writeFile(join(adhocMirror, "wip", "small.md"), "tiny\n");
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: ADHOC,
      relPath: "wip/small.md",
      asPath: true,
      remote: NEVER_CALLED,
    });
    const payload = JSON.parse(out.content[0].text) as { path: string; bytes: number };
    assert.equal(payload.path, join(dir, ".portuni-sessions", HOME, "SESS", ADHOC, "wip", "small.md"));
    assert.equal(await readFile(payload.path, "utf8"), "tiny\n");
  });

  it("passes a not_found error through unchanged", async () => {
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: HOME,
      relPath: "wip/absent.md",
      asPath: false,
      remote: NEVER_CALLED,
    });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /No such file/);
  });
});

describe("readFileOrSpill: no local mirror (remote-only node)", () => {
  it("returns small content inline via the remote fetch", async () => {
    const remote: RemoteRawFetch = async () => ({ kind: "ok", bytes: Buffer.from("from remote\n") });
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: REMOTE_ONLY,
      relPath: "wip/r.md",
      asPath: false,
      remote,
    });
    assert.equal(out.content[0].text, "from remote\n");
  });

  it("a 2 MB remote file is downloaded once and spilled to the session's projection directory, bytes matching", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, "b");
    let calls = 0;
    const remote: RemoteRawFetch = async () => {
      calls++;
      return { kind: "ok", bytes: big };
    };
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: REMOTE_ONLY,
      relPath: "wip/deck.html",
      asPath: false,
      remote,
    });
    const payload = JSON.parse(out.content[0].text) as { path: string; bytes: number; mime: string };
    assert.equal(calls, 1, "fetched exactly once, not re-fetched for classification");
    assert.equal(payload.bytes, big.length);
    assert.equal(payload.mime, "text/html");
    assert.equal(
      payload.path,
      join(dir, ".portuni-sessions", HOME, "SESS", REMOTE_ONLY, "wip", "deck.html"),
    );
    const written = await readFile(payload.path);
    assert.ok(written.equals(big));
  });

  it("as_path forces a spill even for a small remote file", async () => {
    const remote: RemoteRawFetch = async () => ({ kind: "ok", bytes: Buffer.from("tiny\n") });
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: REMOTE_ONLY,
      relPath: "wip/r.md",
      asPath: true,
      remote,
    });
    const payload = JSON.parse(out.content[0].text) as { path: string };
    assert.equal(await readFile(payload.path, "utf8"), "tiny\n");
  });

  it("passes remote error kinds (no_remote/native_format/not_found) through unchanged", async () => {
    const remote: RemoteRawFetch = async () => ({ kind: "no_remote" });
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: HOME,
      projectionSessionId: "SESS",
      projector: projectorFor(HOME),
      nodeId: REMOTE_ONLY,
      relPath: "wip/r.md",
      asPath: false,
      remote,
    });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /no routed remote/);
  });

  it("falls back to the too_large refusal (never dumps an oversized payload) when there is no home node to spill under", async () => {
    const big = Buffer.alloc(MAX_READ_BYTES + 1, "c");
    const remote: RemoteRawFetch = async () => ({ kind: "ok", bytes: big });
    const out = await readFileOrSpill({
      userId: "U1",
      homeNodeId: null,
      projectionSessionId: null,
      projector: projectorFor(null),
      nodeId: REMOTE_ONLY,
      relPath: "wip/big.md",
      asPath: false,
      remote,
    });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /over the/);
  });
});
