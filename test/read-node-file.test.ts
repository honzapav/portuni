// portuni_read_file's disk-read helper: the universal (no-hooks) content
// channel for ad-hoc nodes not exposed on disk by the seatbelt. Reads the
// live file from the node's local mirror; the mirror registry is the scope
// boundary (no mirror on this device => not readable).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readNodeFileFromMirror,
  formatNodeFileContent,
} from "../apps/server/domain/read-node-file.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";

const USER = "U1";
const NODE = "N000000000000000000000READ";

let workspace: string;
let mirror: string;
let originalRoot: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-readfile-"));
  mirror = join(workspace, "org", "projects", "p");
  originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  await mkdir(join(mirror, "wip"), { recursive: true });
  await registerMirror(USER, NODE, mirror);
});

afterEach(async () => {
  resetLocalDbForTests();
  if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
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
