import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRemotePath,
  buildNodeRoot,
  subpathFromMirror,
  deriveLocalPath,
  safeMirrorJoin,
  assertSafeRelativePath,
  RemotePathError,
} from "../src/domain/sync/remote-path.js";

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

describe("path traversal defences", () => {
  it("buildRemotePath rejects ../ in subpath", () => {
    assert.throws(
      () =>
        buildRemotePath({
          orgSyncKey: "org",
          nodeType: "project",
          nodeSyncKey: "node",
          section: "wip",
          subpath: "../../outside",
          filename: "x.txt",
        }),
      RemotePathError,
    );
  });

  it("buildRemotePath rejects slash in filename", () => {
    assert.throws(
      () =>
        buildRemotePath({
          orgSyncKey: "org",
          nodeType: "project",
          nodeSyncKey: "node",
          section: "wip",
          subpath: null,
          filename: "../escape",
        }),
      RemotePathError,
    );
  });

  it("buildRemotePath rejects empty subpath segments", () => {
    assert.throws(
      () =>
        buildRemotePath({
          orgSyncKey: "org",
          nodeType: "project",
          nodeSyncKey: "node",
          section: "wip",
          subpath: "a//b",
          filename: "x.txt",
        }),
      RemotePathError,
    );
  });

  it("buildRemotePath rejects null bytes in filename", () => {
    assert.throws(
      () =>
        buildRemotePath({
          orgSyncKey: "org",
          nodeType: "project",
          nodeSyncKey: "node",
          section: "wip",
          subpath: null,
          filename: "x\0.txt",
        }),
      RemotePathError,
    );
  });

  it("deriveLocalPath rejects ../ inside remotePath remainder", () => {
    assert.throws(
      () =>
        deriveLocalPath({
          mirrorRoot: "/tmp/mirror",
          nodeRoot: "org/projects/node",
          remotePath: "org/projects/node/../../outside.txt",
        }),
      RemotePathError,
    );
  });

  it("deriveLocalPath rejects path that escapes mirror after composition", () => {
    assert.throws(
      () =>
        deriveLocalPath({
          mirrorRoot: "/tmp/mirror",
          nodeRoot: "org/projects/node",
          remotePath: "org/projects/node/../etc/passwd",
        }),
      RemotePathError,
    );
  });

  it("subpathFromMirror returns null when mirror is escaped via symlink-shaped path", () => {
    assert.equal(subpathFromMirror("/ws/mirror", "/ws/mirror/../outside.txt"), null);
  });

  it("safeMirrorJoin allows nested safe segments", () => {
    assert.equal(safeMirrorJoin("/ws/mirror", "wip", "research", "x.md"), "/ws/mirror/wip/research/x.md");
  });

  it("safeMirrorJoin rejects ../ across segments", () => {
    assert.throws(() => safeMirrorJoin("/ws/mirror", "wip", "..", "etc"), RemotePathError);
  });

  it("safeMirrorJoin rejects multi-segment subpath that contains ../", () => {
    assert.throws(() => safeMirrorJoin("/ws/mirror", "wip", "a/../../etc"), RemotePathError);
  });

  it("assertSafeRelativePath rejects absolute paths", () => {
    assert.throws(() => assertSafeRelativePath("/etc/passwd", "test"), RemotePathError);
  });

  it("assertSafeRelativePath accepts deep nested safe paths", () => {
    assert.doesNotThrow(() => assertSafeRelativePath("a/b/c/d.txt", "test"));
  });
});
