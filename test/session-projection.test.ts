// Hardlink primitives + the mirror-watcher <-> session registry
// (domain/session-projection.ts, #191).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  projectNode,
  unprojectNode,
  cleanupSessionProjection,
  sessionProjectionDir,
  nodeProjectionDir,
  registerProjectedNode,
  unregisterSessionProjections,
  projectedEntriesForNode,
  relinkProjectedFile,
  clearProjectionRegistryForTests,
  linkOrCopy,
  sweepStaleSessionProjections,
  UNNARROWED_PROJECTION_ID,
} from "../apps/server/domain/session-projection.js";
import { createSession, transitionSessionState } from "../apps/server/domain/sessions.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { makeSharedDb } from "./helpers/shared-db.js";

let dir: string;
let mirror: string;
let projectionRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-sessproj-"));
  mirror = join(dir, "mirror");
  projectionRoot = join(dir, ".portuni-sessions", "HOME");
  await mkdir(join(mirror, "wip"), { recursive: true });
  clearProjectionRegistryForTests();
});

afterEach(async () => {
  clearProjectionRegistryForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("path helpers", () => {
  it("nests node under session under the projection root", () => {
    assert.equal(sessionProjectionDir(projectionRoot, "SESS"), join(projectionRoot, "SESS"));
    assert.equal(
      nodeProjectionDir(projectionRoot, "SESS", "NODE"),
      join(projectionRoot, "SESS", "NODE"),
    );
  });
});

describe("projectNode / unprojectNode / cleanupSessionProjection", () => {
  it("links files from wip/outputs/resources, skips everything else", async () => {
    await writeFile(join(mirror, "wip", "a.md"), "a\n");
    await mkdir(join(mirror, "outputs"), { recursive: true });
    await writeFile(join(mirror, "outputs", "b.md"), "b\n");
    await writeFile(join(mirror, "readme.md"), "not a synced section\n");

    const target = nodeProjectionDir(projectionRoot, "SESS", "NODE");
    const count = await projectNode(mirror, target);

    assert.equal(count, 2);
    assert.equal(await readFile(join(target, "wip", "a.md"), "utf8"), "a\n");
    assert.equal(await readFile(join(target, "outputs", "b.md"), "utf8"), "b\n");
    await assert.rejects(() => stat(join(target, "readme.md")));
  });

  it("unprojectNode removes only that node's directory", async () => {
    await writeFile(join(mirror, "wip", "a.md"), "a\n");
    const targetA = nodeProjectionDir(projectionRoot, "SESS", "NODE_A");
    const targetB = nodeProjectionDir(projectionRoot, "SESS", "NODE_B");
    await projectNode(mirror, targetA);
    await projectNode(mirror, targetB);

    await unprojectNode(projectionRoot, "SESS", "NODE_A");

    await assert.rejects(() => stat(targetA));
    await assert.doesNotReject(() => stat(targetB));
  });

  it("cleanupSessionProjection removes the whole session directory", async () => {
    await writeFile(join(mirror, "wip", "a.md"), "a\n");
    await projectNode(mirror, nodeProjectionDir(projectionRoot, "SESS", "NODE"));

    await cleanupSessionProjection(projectionRoot, "SESS");

    await assert.rejects(() => stat(sessionProjectionDir(projectionRoot, "SESS")));
  });
});

describe("registry", () => {
  it("registers and looks up entries per node", () => {
    registerProjectedNode("NODE", { sessionId: "S1", mirrorPath: mirror, targetDir: "/t1" });
    registerProjectedNode("NODE", { sessionId: "S2", mirrorPath: mirror, targetDir: "/t2" });

    const entries = projectedEntriesForNode("NODE");
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((e) => e.sessionId).sort(),
      ["S1", "S2"],
    );
  });

  it("unregisterSessionProjections drops only that session, across all nodes", () => {
    registerProjectedNode("NODE_A", { sessionId: "S1", mirrorPath: mirror, targetDir: "/t1" });
    registerProjectedNode("NODE_B", { sessionId: "S1", mirrorPath: mirror, targetDir: "/t2" });
    registerProjectedNode("NODE_A", { sessionId: "S2", mirrorPath: mirror, targetDir: "/t3" });

    unregisterSessionProjections("S1");

    assert.equal(projectedEntriesForNode("NODE_B").length, 0);
    const remaining = projectedEntriesForNode("NODE_A");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].sessionId, "S2");
  });
});

describe("relinkProjectedFile", () => {
  it("does nothing when no session projects the node", async () => {
    await writeFile(join(mirror, "wip", "a.md"), "a\n");
    // no registerProjectedNode call -- must not throw or create anything.
    await relinkProjectedFile("NODE", join(mirror, "wip", "a.md"));
  });

  it("creates the hardlink for a new/changed file inside a projected section", async () => {
    const target = nodeProjectionDir(projectionRoot, "SESS", "NODE");
    registerProjectedNode("NODE", { sessionId: "SESS", mirrorPath: mirror, targetDir: target });

    const src = join(mirror, "wip", "new.md");
    await writeFile(src, "fresh\n");
    await relinkProjectedFile("NODE", src);

    assert.equal(await readFile(join(target, "wip", "new.md"), "utf8"), "fresh\n");
    const srcStat = await stat(src);
    const dstStat = await stat(join(target, "wip", "new.md"));
    assert.equal(srcStat.ino, dstStat.ino);
  });

  it("removes the hardlink when the source file is deleted", async () => {
    const target = nodeProjectionDir(projectionRoot, "SESS", "NODE");
    registerProjectedNode("NODE", { sessionId: "SESS", mirrorPath: mirror, targetDir: target });

    const src = join(mirror, "wip", "gone.md");
    await writeFile(src, "temp\n");
    await relinkProjectedFile("NODE", src);
    await assert.doesNotReject(() => stat(join(target, "wip", "gone.md")));

    await unlink(src);
    await relinkProjectedFile("NODE", src);

    await assert.rejects(() => stat(join(target, "wip", "gone.md")));
  });

  it("ignores files outside wip/outputs/resources", async () => {
    const target = nodeProjectionDir(projectionRoot, "SESS", "NODE");
    registerProjectedNode("NODE", { sessionId: "SESS", mirrorPath: mirror, targetDir: target });

    const src = join(mirror, "readme.md");
    await writeFile(src, "root level\n");
    await relinkProjectedFile("NODE", src);

    await assert.rejects(() => stat(join(target, "readme.md")));
  });

  it("ignores dot-prefixed path segments", async () => {
    const target = nodeProjectionDir(projectionRoot, "SESS", "NODE");
    registerProjectedNode("NODE", { sessionId: "SESS", mirrorPath: mirror, targetDir: target });

    await mkdir(join(mirror, "wip", ".obsidian"), { recursive: true });
    const src = join(mirror, "wip", ".obsidian", "workspace.json");
    await writeFile(src, "{}");
    await relinkProjectedFile("NODE", src);

    await assert.rejects(() => stat(join(target, "wip", ".obsidian", "workspace.json")));
  });

  it("relinks the same source into every session currently projecting the node", async () => {
    const targetA = nodeProjectionDir(projectionRoot, "SESS_A", "NODE");
    const targetB = nodeProjectionDir(projectionRoot, "SESS_B", "NODE");
    registerProjectedNode("NODE", { sessionId: "SESS_A", mirrorPath: mirror, targetDir: targetA });
    registerProjectedNode("NODE", { sessionId: "SESS_B", mirrorPath: mirror, targetDir: targetB });

    const src = join(mirror, "wip", "shared.md");
    await writeFile(src, "shared\n");
    await relinkProjectedFile("NODE", src);

    assert.equal(await readFile(join(targetA, "wip", "shared.md"), "utf8"), "shared\n");
    assert.equal(await readFile(join(targetB, "wip", "shared.md"), "utf8"), "shared\n");
  });
});

// #208: a mirror on another volume than the projection root (e.g. a custom
// mirror path, or /dev/shm's tmpfs vs the regular filesystem here) used to
// leave a silent empty projection directory. linkOrCopy must fall back to a
// real copy on EXDEV instead.
describe("linkOrCopy: EXDEV fallback", () => {
  it("succeeds via a plain hardlink on the same filesystem", async () => {
    const src = join(mirror, "wip", "same-fs.md");
    await writeFile(src, "same fs\n");
    const dest = join(dir, "same-fs-dest.md");

    assert.equal(await linkOrCopy(src, dest), true);
    assert.equal(await readFile(dest, "utf8"), "same fs\n");
    assert.equal((await stat(src)).ino, (await stat(dest)).ino, "a real hardlink, not a copy");
  });

  it("falls back to a real copy across a filesystem boundary (EXDEV)", async (t) => {
    const shmDir = "/dev/shm";
    try {
      await access(shmDir);
    } catch {
      t.skip("/dev/shm not available in this environment");
      return;
    }
    const shmSubdir = await mkdtemp(join(shmDir, "portuni-sessproj-"));
    try {
      const src = join(shmSubdir, "cross-fs.md");
      await writeFile(src, "cross fs\n");
      const dest = join(dir, "cross-fs-dest.md");

      // Sanity: this really is a cross-device pair in this environment,
      // otherwise the test would pass trivially without exercising EXDEV.
      const srcDev = (await stat(src)).dev;
      const destParentDev = (await stat(dir)).dev;
      if (srcDev === destParentDev) {
        t.skip("/dev/shm and the test tmpdir are on the same filesystem here");
        return;
      }

      const result = await linkOrCopy(src, dest);
      assert.equal(result, true);
      assert.equal(await readFile(dest, "utf8"), "cross fs\n");
      assert.notEqual((await stat(src)).ino, (await stat(dest)).ino, "a copy, not a hardlink");
    } finally {
      await rm(shmSubdir, { recursive: true, force: true });
    }
  });

  it("logs and returns false (never throws) for an error other than EEXIST/EXDEV", async () => {
    const src = join(mirror, "wip", "other-error.md");
    await writeFile(src, "x\n");
    // A destination inside a non-existent parent directory raises ENOENT --
    // any code other than EEXIST/EXDEV should be swallowed with a log, not
    // thrown, matching the best-effort contract the rest of this module has.
    const dest = join(dir, "no-such-parent", "dest.md");

    const result = await linkOrCopy(src, dest);
    assert.equal(result, false);
    await assert.rejects(() => stat(dest));
  });

  it("treats EEXIST as success without re-linking", async () => {
    const src = join(mirror, "wip", "already.md");
    await writeFile(src, "first\n");
    const dest = join(dir, "already-dest.md");
    await writeFile(dest, "pre-existing, unrelated content\n");

    const result = await linkOrCopy(src, dest);
    assert.equal(result, true);
    // Unchanged -- EEXIST means "leave the existing link/file alone", not
    // "overwrite it".
    assert.equal(await readFile(dest, "utf8"), "pre-existing, unrelated content\n");
  });
});

// #208: no startup reconcile meant a crashed process's leftover hardlink
// directories stayed readable to the next session on that node forever,
// with no scope event ever recorded for it.
describe("sweepStaleSessionProjections", () => {
  it("removes projection dirs for closed/archived/unknown sessions, keeps running ones", async () => {
    const { db, nodeId } = await makeSharedDb();
    const running = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    const closed = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await transitionSessionState(db, "U1", closed.id, "closed");
    const suspended = await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
    await transitionSessionState(db, "U1", suspended.id, "suspended");
    const unknownSessionId = "01UNKNOWNSESSION000000000";

    const base = join(dir, ".portuni-sessions", nodeId);
    for (const sessionId of [running.id, closed.id, suspended.id, unknownSessionId]) {
      const target = join(base, sessionId, "SOME_ADHOC_NODE");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "f.md"), "x\n");
    }

    const { removed } = await sweepStaleSessionProjections(db, dir, "U1");

    assert.equal(removed.length, 3);
    await assert.doesNotReject(() => stat(join(base, running.id)), "running session's projection survives");
    await assert.rejects(() => stat(join(base, closed.id)), "closed session's projection is removed");
    await assert.rejects(() => stat(join(base, suspended.id)), "suspended session's projection is removed");
    await assert.rejects(() => stat(join(base, unknownSessionId)), "unknown session id's projection is removed");
  });

  it("is a no-op when no .portuni-sessions directory exists yet", async () => {
    const { db } = await makeSharedDb();
    const { removed } = await sweepStaleSessionProjections(db, join(dir, "never-created"), "U1");
    assert.deepEqual(removed, []);
  });

  // #214: the shared bucket (#211) isn't a session row, so the per-sessionId
  // rule above can't age it out -- it used to be skipped unconditionally and
  // grew forever. It's now governed by node-level running-session state.
  describe("shared bucket (#214)", () => {
    beforeEach(() => {
      process.env.PORTUNI_WORKSPACE_ROOT = dir;
      resetLocalDbForTests();
    });

    it("removes the shared bucket outright once no session on its node is running", async () => {
      const { db, nodeId } = await makeSharedDb();
      const base = join(dir, ".portuni-sessions", nodeId);
      const sharedTarget = join(base, UNNARROWED_PROJECTION_ID, "SOME_ADHOC_NODE");
      await mkdir(sharedTarget, { recursive: true });
      await writeFile(join(sharedTarget, "f.md"), "x\n");

      const { removed } = await sweepStaleSessionProjections(db, dir, "U1");

      assert.ok(removed.includes(join(base, UNNARROWED_PROJECTION_ID)));
      await assert.rejects(() => stat(join(base, UNNARROWED_PROJECTION_ID)));
    });

    it("reconciles instead of removing while a session on its node is still running", async () => {
      const { db, nodeId } = await makeSharedDb();
      await createSession(db, "U1", { node_id: nodeId, session_type: "interactive_task" });
      const base = join(dir, ".portuni-sessions", nodeId);
      const sharedDir = join(base, UNNARROWED_PROJECTION_ID);

      // Ad-hoc node with no mirror registered at all anymore: source is
      // entirely gone, so its whole subdirectory is pruned.
      const gone = join(sharedDir, "GONE_NODE");
      await mkdir(gone, { recursive: true });
      await writeFile(join(gone, "f.md"), "x\n");

      // Ad-hoc node with a registered mirror: one linked file still exists
      // there (kept), one no longer does (pruned).
      const adhocMirror = join(dir, "adhoc-mirror");
      await mkdir(join(adhocMirror, "wip"), { recursive: true });
      await writeFile(join(adhocMirror, "wip", "keep.md"), "keep\n");
      await registerMirror("U1", "ADHOC", adhocMirror);
      const linkedDir = join(sharedDir, "ADHOC", "wip");
      await mkdir(linkedDir, { recursive: true });
      await writeFile(join(linkedDir, "keep.md"), "keep\n");
      await writeFile(join(linkedDir, "deleted.md"), "stale\n");

      const { removed } = await sweepStaleSessionProjections(db, dir, "U1");

      assert.ok(!removed.includes(sharedDir), "shared bucket itself is not removed");
      await assert.rejects(() => stat(gone), "node with no mirror at all is pruned entirely");
      await assert.doesNotReject(() => stat(join(linkedDir, "keep.md")), "still-present source file survives");
      await assert.rejects(() => stat(join(linkedDir, "deleted.md")), "hardlink with no source is pruned");
    });
  });
});
