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
