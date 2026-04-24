import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRemotePath, buildNodeRoot, subpathFromMirror, deriveLocalPath } from "../src/sync/remote-path.js";

describe("buildNodeRoot", () => {
  it("uses sync_key for non-org nodes", () => {
    assert.equal(
      buildNodeRoot({ orgSyncKey: "workflow", nodeType: "project", nodeSyncKey: "stan-gws" }),
      "workflow/projects/stan-gws",
    );
  });
  it("returns just org sync_key for organization nodes", () => {
    assert.equal(
      buildNodeRoot({ orgSyncKey: "workflow", nodeType: "organization", nodeSyncKey: "workflow" }),
      "workflow",
    );
  });
  it("elides org when null (cross-org hub)", () => {
    assert.equal(
      buildNodeRoot({ orgSyncKey: null, nodeType: "project", nodeSyncKey: "shared" }),
      "projects/shared",
    );
  });
  it("never trailing slash", () => {
    const r = buildNodeRoot({ orgSyncKey: "tempo", nodeType: "process", nodeSyncKey: "hiring" });
    assert.ok(!r.endsWith("/"));
  });
});

describe("buildRemotePath", () => {
  it("full path with subpath", () => {
    assert.equal(
      buildRemotePath({
        orgSyncKey: "workflow", nodeType: "project", nodeSyncKey: "stan-gws",
        section: "wip", subpath: "research", filename: "i.md",
      }),
      "workflow/projects/stan-gws/wip/research/i.md",
    );
  });
});

describe("subpathFromMirror", () => {
  it("extracts section + subpath + filename", () => {
    const r = subpathFromMirror("/ws/workflow/projects/stan-gws", "/ws/workflow/projects/stan-gws/wip/research/x.md");
    assert.deepEqual(r, { section: "wip", subpath: "research", filename: "x.md" });
  });
  it("null outside mirror", () => {
    assert.equal(subpathFromMirror("/a", "/b/x.md"), null);
  });
  it("null on unknown section", () => {
    assert.equal(subpathFromMirror("/root", "/root/garbage/x.md"), null);
  });
});

describe("deriveLocalPath", () => {
  it("throws when remotePath does not start with nodeRoot", () => {
    assert.throws(() => deriveLocalPath({ mirrorRoot: "/m", nodeRoot: "x/y/z", remotePath: "a/b/c/f" }));
  });
  it("composes correctly", () => {
    assert.equal(
      deriveLocalPath({
        mirrorRoot: "/ws/workflow/projects/stan-gws",
        nodeRoot: "workflow/projects/stan-gws",
        remotePath: "workflow/projects/stan-gws/wip/research/i.md",
      }),
      "/ws/workflow/projects/stan-gws/wip/research/i.md",
    );
  });
});
