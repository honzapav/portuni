// Hardlink primitives + the mirror-watcher <-> session registry
// (domain/session-projection.ts, #191).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, unlink } from "node:fs/promises";
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
} from "../apps/server/domain/session-projection.js";

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
