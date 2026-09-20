// portuni_read_file's disk-read helper: the universal content channel for a
// node with no local mirror on this device. Reads the live file from the
// node's local mirror when there is one; the mirror registry is the scope
// boundary for that branch (no mirror on this device => read the remote).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  disposeReadFileSpill,
  readFileSpillRoot,
  readNodeFileFromMirror,
  readNodeFileOrPath,
  readNodeFileRaw,
  sweepReadFileSpillRoot,
  writeBytesToPath,
  mimeFromExtension,
  formatNodeFileContent,
  MAX_READ_BYTES,
} from "../apps/server/domain/read-node-file.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { useRemoteCapableEnv } from "./helpers/remote-capable-env.js";

useRemoteCapableEnv();

const USER = "U1";
const NODE = "N000000000000000000000READ";

let workspace: string;
let mirror: string;
let originalRoot: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-readfile-"));
  mirror = join(workspace, "org", "projects", "p");
  originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  // The spill root is derived from the runner data dir; keep it inside the
  // per-test temp tree instead of the repo checkout (resolveRunnerDataDir's
  // process.cwd() fallback).
  originalDataDir = process.env.PORTUNI_DATA_DIR;
  process.env.PORTUNI_DATA_DIR = join(workspace, "data");
  resetLocalDbForTests();
  await mkdir(join(mirror, "wip"), { recursive: true });
  await registerMirror(USER, NODE, mirror);
});

afterEach(async () => {
  resetLocalDbForTests();
  if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
  if (originalDataDir === undefined) delete process.env.PORTUNI_DATA_DIR;
  else process.env.PORTUNI_DATA_DIR = originalDataDir;
  await rm(workspace, { recursive: true, force: true });
});

describe("readNodeFileFromMirror", () => {
  it("returns UTF-8 text for a text file", async () => {
    await writeFile(join(mirror, "wip", "notes.md"), "# hello\nworld\n");
    const r = await readNodeFileFromMirror(USER, NODE, "wip/notes.md");
    assert.equal(r.kind, "text");
    assert.equal((r as { text: string }).text, "# hello\nworld\n");
  });

  it("returns base64 for a binary file (NUL byte)", async () => {
    await writeFile(join(mirror, "wip", "b.bin"), Buffer.from([1, 0, 2, 3]));
    const r = await readNodeFileFromMirror(USER, NODE, "wip/b.bin");
    assert.equal(r.kind, "binary");
    assert.equal((r as { base64: string }).base64, Buffer.from([1, 0, 2, 3]).toString("base64"));
  });

  it("no_mirror when the node is not mirrored on this device", async () => {
    const r = await readNodeFileFromMirror(USER, "N0000000000000000000GHOST", "wip/x.md");
    assert.equal(r.kind, "no_mirror");
  });

  it("not_found for a missing file", async () => {
    const r = await readNodeFileFromMirror(USER, NODE, "wip/absent.md");
    assert.equal(r.kind, "not_found");
  });

  it("rejects path traversal outside the mirror", async () => {
    // A sibling secret outside the node mirror must not be readable.
    await writeFile(join(workspace, "secret.txt"), "top secret");
    const r = await readNodeFileFromMirror(USER, NODE, "../../../secret.txt");
    assert.equal(r.kind, "not_found");
  });

  it("reports only the size on a too_large result, never the bytes", async () => {
    const big = Buffer.alloc(MAX_READ_BYTES + 1, "z");
    await writeFile(join(mirror, "wip", "big.txt"), big);
    const r = await readNodeFileFromMirror(USER, NODE, "wip/big.txt");
    assert.equal(r.kind, "too_large");
    assert.equal((r as { bytes: number }).bytes, big.length);
    assert.ok(!("raw" in r), "too_large must not carry the oversized buffer");
  });
});

describe("readNodeFileRaw", () => {
  // The node has a local mirror, so the db parameter is never touched --
  // rawFromMirror short-circuits before rawFromRemote would need it.
  const NO_DB = null as unknown as Parameters<typeof readNodeFileRaw>[0];

  it("returns raw bytes from the mirror, uncapped by MAX_READ_BYTES", async () => {
    const big = Buffer.alloc(MAX_READ_BYTES + 1024, "y");
    await writeFile(join(mirror, "wip", "big.bin"), big);
    const r = await readNodeFileRaw(NO_DB, USER, NODE, "wip/big.bin");
    assert.equal(r.kind, "ok");
    assert.ok((r as { bytes: Buffer }).bytes.equals(big));
  });

  it("not_found for a missing file when the node has a mirror", async () => {
    const r = await readNodeFileRaw(NO_DB, USER, NODE, "wip/absent.md");
    assert.equal(r.kind, "not_found");
  });
});

describe("writeBytesToPath", () => {
  it("creates missing parent directories and writes the bytes", async () => {
    const dest = join(workspace, "spill", "nested", "out.bin");
    const bytes = Buffer.from([1, 2, 3, 4]);
    await writeBytesToPath(dest, bytes);
    const written = await import("node:fs/promises").then((m) => m.readFile(dest));
    assert.ok(written.equals(bytes));
  });
});

describe("mimeFromExtension", () => {
  it("maps known extensions", () => {
    assert.equal(mimeFromExtension("wip/deck.html"), "text/html");
    assert.equal(mimeFromExtension("outputs/report.pdf"), "application/pdf");
    assert.equal(mimeFromExtension("wip/notes.MD"), "text/markdown");
  });

  it("defaults to application/octet-stream for an unknown extension", () => {
    assert.equal(mimeFromExtension("wip/mystery.xyz"), "application/octet-stream");
  });
});

describe("formatNodeFileContent", () => {
  it("renders text as plain content", () => {
    const out = formatNodeFileContent({ kind: "text", text: "hi" }, "wip/a.md");
    assert.equal(out.content[0].text, "hi");
    assert.equal(out.isError, undefined);
  });

  it("flags no_mirror as an error result", () => {
    const out = formatNodeFileContent({ kind: "no_mirror" }, "wip/a.md");
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /not mirrored/);
  });
});

// Mirror-less fallback: a server holding no mirror of the node (central,
// a remote client's session) reads the bytes from the routed remote.
describe("readNodeFileFromRemote / readNodeFile", () => {
  it("reads text from the routed remote when the node has no mirror", async () => {
    const { makeSharedDb } = await import("./helpers/shared-db.js");
    const { getAdapter, resetAdapterCacheForTests } = await import(
      "../apps/server/domain/sync/adapter-cache.js"
    );
    const { readNodeFile, readNodeFileFromRemote } = await import(
      "../apps/server/domain/read-node-file.js"
    );
    resetAdapterCacheForTests();
    const shared = await makeSharedDb();
    try {
      const adapter = await getAdapter(shared.db, "test-fs");
      await adapter.put("workflow/projects/stan-gws/wip/remote.md", Buffer.from("from the remote\n"));
      await adapter.put("workflow/projects/stan-gws/wip/bin.dat", Buffer.from([7, 0, 9]));

      const text = await readNodeFile(shared.db, USER, shared.nodeId, "wip/remote.md");
      assert.equal(text.kind, "text");
      assert.equal((text as { text: string }).text, "from the remote\n");

      const bin = await readNodeFileFromRemote(shared.db, shared.nodeId, "wip/bin.dat");
      assert.equal(bin.kind, "binary");
      assert.equal((bin as { base64: string }).base64, Buffer.from([7, 0, 9]).toString("base64"));

      const missing = await readNodeFileFromRemote(shared.db, shared.nodeId, "wip/nope.md");
      assert.equal(missing.kind, "not_found");

      const traversal = await readNodeFileFromRemote(shared.db, shared.nodeId, "../secret.txt");
      assert.equal(traversal.kind, "not_found");
    } finally {
      resetAdapterCacheForTests();
      await rm(shared.remoteRoot, { recursive: true, force: true });
    }
  });

  it("no_remote when no remote is routed for the node", async () => {
    const { makeSharedDb } = await import("./helpers/shared-db.js");
    const { replaceRules } = await import("../apps/server/domain/sync/routing.js");
    const { resetAdapterCacheForTests } = await import("../apps/server/domain/sync/adapter-cache.js");
    const { readNodeFileFromRemote, formatNodeFileContent } = await import(
      "../apps/server/domain/read-node-file.js"
    );
    resetAdapterCacheForTests();
    const shared = await makeSharedDb();
    try {
      await replaceRules(shared.db, []);
      const r = await readNodeFileFromRemote(shared.db, shared.nodeId, "wip/x.md");
      assert.equal(r.kind, "no_remote");
      const out = formatNodeFileContent(r, "wip/x.md");
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /no routed remote/);
    } finally {
      resetAdapterCacheForTests();
      await rm(shared.remoteRoot, { recursive: true, force: true });
    }
  });

  it("prefers the local mirror when one exists", async () => {
    const { makeSharedDb } = await import("./helpers/shared-db.js");
    const { resetAdapterCacheForTests } = await import("../apps/server/domain/sync/adapter-cache.js");
    const { readNodeFile } = await import("../apps/server/domain/read-node-file.js");
    resetAdapterCacheForTests();
    const shared = await makeSharedDb();
    try {
      await writeFile(join(mirror, "wip", "local.md"), "from disk\n");
      const r = await readNodeFile(shared.db, USER, NODE, "wip/local.md");
      assert.equal(r.kind, "text");
      assert.equal((r as { text: string }).text, "from disk\n");
    } finally {
      resetAdapterCacheForTests();
      await rm(shared.remoteRoot, { recursive: true, force: true });
    }
  });
});

// readNodeFileOrPath's LOCAL branch (mirror on this device) plus the spill
// lifecycle that replaced the removed hardlink projection (#346/#406). The
// remote branch is exercised for real against central in
// test/agent-transport.test.ts; here it is a plain injected fetch.
describe("readNodeFileOrPath: local mirror, spill and disposal", () => {
  const remoteBytes = (bytes: Buffer) => async () => ({ kind: "ok" as const, bytes });

  it("reports the real mirror path (no copy) when as_path is requested", async () => {
    const abs = join(mirror, "wip", "big.md");
    await writeFile(abs, "hello\n");
    const r = await readNodeFileOrPath({
      userId: USER,
      nodeId: NODE,
      relPath: "wip/big.md",
      asPath: true,
      remote: async () => {
        throw new Error("remote must not be consulted for a mirrored node");
      },
      spillSessionId: "T-mirror",
    });
    assert.notEqual(r.isError, true);
    const payload = JSON.parse(r.content[0].text) as { path: string; bytes: number; mime: string };
    assert.equal(payload.path, abs);
    assert.equal(payload.bytes, 6);
    assert.equal(payload.mime, "text/markdown");
    // Nothing was spilled: the real path is the answer.
    await assert.rejects(() => stat(readFileSpillRoot()));
  });

  it("reports the real mirror path for a file over the inline cap, without as_path", async () => {
    const abs = join(mirror, "wip", "huge.txt");
    await writeFile(abs, "x".repeat(MAX_READ_BYTES + 10));
    const r = await readNodeFileOrPath({
      userId: USER,
      nodeId: NODE,
      relPath: "wip/huge.txt",
      asPath: false,
      remote: async () => {
        throw new Error("remote must not be consulted for a mirrored node");
      },
      spillSessionId: "T-mirror",
    });
    assert.notEqual(r.isError, true);
    assert.equal((JSON.parse(r.content[0].text) as { path: string }).path, abs);
  });

  it("returns inline content for a small mirrored file", async () => {
    await writeFile(join(mirror, "wip", "small.md"), "inline\n");
    const r = await readNodeFileOrPath({
      userId: USER,
      nodeId: NODE,
      relPath: "wip/small.md",
      asPath: false,
      remote: async () => {
        throw new Error("remote must not be consulted for a mirrored node");
      },
      spillSessionId: "T-mirror",
    });
    assert.equal(r.content[0].text, "inline\n");
  });

  it("spills into <dataDir>/read-file-spill/<transportSessionId>/ when the node has no mirror", async () => {
    const r = await readNodeFileOrPath({
      userId: USER,
      nodeId: "N0000000000000000000GHOST",
      relPath: "wip/remote.md",
      asPath: true,
      remote: remoteBytes(Buffer.from("from central\n")),
      spillSessionId: "T-alpha",
    });
    const payload = JSON.parse(r.content[0].text) as { path: string; bytes: number };
    assert.ok(
      payload.path.startsWith(join(readFileSpillRoot(), "T-alpha") + "/"),
      `spill path ${payload.path} must live under this transport's own directory`,
    );
    assert.equal(payload.bytes, 13);
    assert.equal(await readFile(payload.path, "utf8"), "from central\n");
  });

  it("spills a file over the inline cap even without as_path", async () => {
    const r = await readNodeFileOrPath({
      userId: USER,
      nodeId: "N0000000000000000000GHOST",
      relPath: "wip/huge.bin",
      asPath: false,
      remote: remoteBytes(Buffer.alloc(MAX_READ_BYTES + 1, 0x61)),
      spillSessionId: "T-alpha",
    });
    assert.notEqual(r.isError, true);
    const payload = JSON.parse(r.content[0].text) as { path: string; bytes: number };
    assert.equal(payload.bytes, MAX_READ_BYTES + 1);
    assert.ok(payload.path.startsWith(join(readFileSpillRoot(), "T-alpha") + "/"));
  });

  it("disposal removes only the closing transport's own spill directory", async () => {
    const alpha = JSON.parse(
      (
        await readNodeFileOrPath({
          userId: USER,
          nodeId: "N0000000000000000000GHOST",
          relPath: "wip/a.md",
          asPath: true,
          remote: remoteBytes(Buffer.from("a")),
          spillSessionId: "T-alpha",
        })
      ).content[0].text,
    ).path as string;
    const beta = JSON.parse(
      (
        await readNodeFileOrPath({
          userId: USER,
          nodeId: "N0000000000000000000GHOST",
          relPath: "wip/b.md",
          asPath: true,
          remote: remoteBytes(Buffer.from("b")),
          spillSessionId: "T-beta",
        })
      ).content[0].text,
    ).path as string;

    await disposeReadFileSpill("T-alpha");
    await assert.rejects(() => stat(alpha));
    assert.equal(await readFile(beta, "utf8"), "b");
    // Idempotent: a transport that spilled nothing (or closes twice) is fine.
    await disposeReadFileSpill("T-alpha");
    await disposeReadFileSpill("T-never-spilled");

    // The boot sweep clears whatever a crash left behind.
    await sweepReadFileSpillRoot();
    await assert.rejects(() => stat(beta));
    await assert.rejects(() => stat(readFileSpillRoot()));
  });

  it("refuses to delete anything outside the spill root", async () => {
    const beta = JSON.parse(
      (
        await readNodeFileOrPath({
          userId: USER,
          nodeId: "N0000000000000000000GHOST",
          relPath: "wip/b.md",
          asPath: true,
          remote: remoteBytes(Buffer.from("b")),
          spillSessionId: "T-beta",
        })
      ).content[0].text,
    ).path as string;

    await disposeReadFileSpill("../..");
    await disposeReadFileSpill(".");
    await disposeReadFileSpill(workspace);
    assert.equal(await readFile(beta, "utf8"), "b");
    await stat(mirror);
  });
});
