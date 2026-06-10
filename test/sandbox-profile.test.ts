// Tests for the Seatbelt sandbox profile generator (universal disk-scope
// layer). The profile mirrors the MCP read-scope semantics on disk:
// home mirror read+write, depth-1 neighbor mirrors read-only, the rest
// of PORTUNI_ROOT denied at the kernel. Validated against a live
// sandbox-exec run in docs/sandbox-spike-2026-06-10.md.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import {
  buildSeatbeltProfile,
  resolveSandboxScopeForCwd,
  resolveSandboxScopeForNode,
} from "../src/domain/sandbox-profile.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { SOLO_USER } from "../src/infra/schema.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("buildSeatbeltProfile", () => {
  it("emits deny on the root, metadata traverse, rw home, ro neighbors", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/ws",
      homeMirror: "/ws/org/projects/p1",
      neighborMirrors: ["/ws/org"],
    });
    const lines = p.trim().split("\n");
    assert.equal(lines[0], "(version 1)");
    assert.equal(lines[1], "(allow default)");
    // Order matters: later rules win in Seatbelt, so the deny must come
    // before the allows.
    const denyIdx = lines.findIndex((l) => l.includes("(deny file-read* file-write*"));
    const homeIdx = lines.findIndex((l) =>
      l.includes('(allow file-read* file-write* (subpath "/ws/org/projects/p1"))'),
    );
    assert.ok(denyIdx > 0 && homeIdx > denyIdx, "deny root must precede home allow");
    assert.ok(p.includes('(deny file-read* file-write* (subpath "/ws"))'));
    assert.ok(p.includes('(allow file-read-metadata (subpath "/ws"))'));
    assert.ok(p.includes('(allow file-read* (subpath "/ws/org"))'));
    assert.ok(!p.includes('file-write* (subpath "/ws/org"))'), "neighbor must be read-only");
  });

  it("escapes quotes and backslashes in paths", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: '/ws/we"ird\\dir',
      homeMirror: '/ws/we"ird\\dir/home',
      neighborMirrors: [],
    });
    assert.ok(p.includes('"/ws/we\\"ird\\\\dir"'));
  });

  it("dedupes neighbors equal to the home mirror", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/ws",
      homeMirror: "/ws/org/projects/p1",
      // A self-edge (or duplicate registration) must not emit a read-only
      // rule for the home mirror itself — home already has read+write.
      neighborMirrors: ["/ws/org/projects/p1", "/ws/other"],
    });
    const allowReadOnly = p
      .split("\n")
      .filter((l) => l.startsWith("(allow file-read* (subpath"));
    assert.equal(allowReadOnly.length, 1);
    assert.ok(allowReadOnly[0].includes("/ws/other"));
  });
});

describe("resolveSandboxScopeForNode", () => {
  let workspace: string;
  let originalRoot: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-sbx-"));
    originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
  });

  afterEach(async () => {
    resetLocalDbForTests();
    if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
    await rm(workspace, { recursive: true, force: true });
  });

  it("returns home + mirrored depth-1 neighbors with realpaths", async () => {
    const { db, nodeId, orgId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    const orgDir = join(workspace, "org");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);
    await registerMirror(SOLO_USER, orgId, orgDir);

    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);

    assert.ok(scope, "scope must resolve when the node has a mirror");
    assert.equal(scope.homeMirror.endsWith(join("org", "projects", "p1")), true);
    assert.equal(scope.neighborMirrors.length, 1);
    assert.ok(scope.neighborMirrors[0].endsWith("org"));
    assert.ok(scope.portuniRoot.length > 0);
  });

  it("ignores neighbors without a local mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);
    // orgId has an edge to nodeId but no mirror registered.

    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);

    assert.ok(scope);
    assert.deepEqual(scope.neighborMirrors, []);
  });

  it("returns null when the node has no mirror", async () => {
    const { db } = await makeSharedDb();
    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, ulid());
    assert.equal(scope, null);
  });

  it("resolves by cwd: deepest containing mirror wins", async () => {
    const { db, nodeId, orgId } = await makeSharedDb();
    const orgDir = join(workspace, "org");
    const homeDir = join(orgDir, "projects", "p1");
    await mkdir(join(homeDir, "wip"), { recursive: true });
    await registerMirror(SOLO_USER, orgId, orgDir);
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const r = await resolveSandboxScopeForCwd(db, SOLO_USER, join(homeDir, "wip"));

    assert.ok(r, "cwd inside a mirror must resolve");
    assert.equal(r.nodeId, nodeId, "nested mirror must beat its ancestor");
    assert.ok(r.scope.homeMirror.endsWith(join("projects", "p1")));
  });

  it("resolves by cwd: returns null outside every mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const r = await resolveSandboxScopeForCwd(db, SOLO_USER, join(workspace, "elsewhere"));
    assert.equal(r, null);
  });
});
