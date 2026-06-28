// Tests for the Seatbelt sandbox profile generator (universal disk-scope
// layer). The profile uses the home-only single-source model: the kernel
// grants read+write in the home mirror, and denies the rest of
// PORTUNI_ROOT. Neighbor nodes are made readable via staged copies under
// <home>/.portuni-scope/<id>/ (inside the home subpath, already covered
// by the home rw rule). See apps/server/mcp/scope-reconciler.ts.

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
} from "../apps/server/domain/sandbox-profile.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { SOLO_USER } from "../apps/server/infra/schema.js";
import { makeSharedDb } from "./helpers/shared-db.js";

describe("buildSeatbeltProfile (home-only, single-source model)", () => {
  it("grants rw on the home mirror and denies the rest of the root", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/org/proj",
    });
    assert.match(p, /\(deny file-read\* file-write\* \(subpath "\/root"\)\)/);
    assert.match(p, /\(allow file-read-metadata \(subpath "\/root"\)\)/);
    assert.match(p, /\(allow file-read\* file-write\* \(subpath "\/root\/org\/proj"\)\)/);
  });

  it("emits NO standalone neighbor read-allow rules", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: "/root",
      homeMirror: "/root/org/proj",
    });
    // Count only allow lines that grant file-read*; the deny line is excluded.
    // In the home-only model there is exactly one: the home rw line.
    const reads = p.split("\n").filter((l) => l.startsWith("(allow file-read*"));
    assert.equal(reads.length, 1); // just the home rw line
  });

  it("escapes quotes and backslashes in paths", () => {
    const p = buildSeatbeltProfile({
      portuniRoot: '/ws/we"ird\\dir',
      homeMirror: '/ws/we"ird\\dir/home',
    });
    assert.ok(p.includes('"/ws/we\\"ird\\\\dir"'));
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

  it("returns home mirror and portuniRoot", async () => {
    const { db, nodeId } = await makeSharedDb();
    const homeDir = join(workspace, "org", "projects", "p1");
    await mkdir(homeDir, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, homeDir);

    const scope = await resolveSandboxScopeForNode(db, SOLO_USER, nodeId);

    assert.ok(scope, "scope must resolve when the node has a mirror");
    assert.equal(scope.homeMirror.endsWith(join("org", "projects", "p1")), true);
    assert.ok(scope.portuniRoot.length > 0);
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
