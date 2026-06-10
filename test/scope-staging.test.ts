// Tests for staging expanded-scope node files into the home mirror.
//
// The Seatbelt sandbox boundary is fixed at terminal spawn (home mirror
// rw + depth-1 neighbors ro). When the user approves a scope expansion
// mid-session, the sandboxed agent still cannot read the expanded node's
// mirror — so the (unsandboxed) server copies its files into
// <homeMirror>/.portuni-scope/<nodeId>/, which IS inside the visible
// zone. Dot-segment paths are already excluded from sync discovery
// (mirror-ignore.ts), so staged copies never leak into the graph.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stageNodeIntoMirror } from "../src/domain/scope-staging.js";

let dir: string;
let home: string;
let source: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-staging-"));
  home = join(dir, "home");
  source = join(dir, "expanded-node");
  await mkdir(join(home, "wip"), { recursive: true });
  await mkdir(join(source, "outputs"), { recursive: true });
  await writeFile(join(source, "outputs", "report.md"), "# report\n");
  await writeFile(join(source, "notes.md"), "notes\n");
  await mkdir(join(source, ".claude"), { recursive: true });
  await writeFile(join(source, ".claude", "settings.local.json"), "{}");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("stageNodeIntoMirror", () => {
  it("copies the node mirror into .portuni-scope/<nodeId> inside home", async () => {
    const r = await stageNodeIntoMirror({
      homeMirror: home,
      nodeId: "01NODE",
      nodeMirror: source,
    });

    assert.equal(r.staged_path, join(home, ".portuni-scope", "01NODE"));
    const report = await readFile(
      join(home, ".portuni-scope", "01NODE", "outputs", "report.md"),
      "utf8",
    );
    assert.equal(report, "# report\n");
    assert.ok(r.files >= 2);
  });

  it("skips dot-segments from the source (no .claude, no nested staging)", async () => {
    await mkdir(join(source, ".portuni-scope", "01OTHER"), { recursive: true });
    await writeFile(join(source, ".portuni-scope", "01OTHER", "x.md"), "x");

    await stageNodeIntoMirror({
      homeMirror: home,
      nodeId: "01NODE",
      nodeMirror: source,
    });

    const target = join(home, ".portuni-scope", "01NODE");
    await assert.rejects(access(join(target, ".claude"), constants.F_OK));
    await assert.rejects(access(join(target, ".portuni-scope"), constants.F_OK));
  });

  it("makes staged files read-only", async () => {
    await stageNodeIntoMirror({
      homeMirror: home,
      nodeId: "01NODE",
      nodeMirror: source,
    });
    const st = await stat(join(home, ".portuni-scope", "01NODE", "notes.md"));
    assert.equal(st.mode & 0o222, 0, "no write bits on staged files");
  });

  it("re-stages cleanly over a previous copy (stale files disappear)", async () => {
    await stageNodeIntoMirror({ homeMirror: home, nodeId: "01NODE", nodeMirror: source });
    await rm(join(source, "notes.md"));
    await writeFile(join(source, "fresh.md"), "fresh\n");

    await stageNodeIntoMirror({ homeMirror: home, nodeId: "01NODE", nodeMirror: source });

    const target = join(home, ".portuni-scope", "01NODE");
    await assert.rejects(access(join(target, "notes.md"), constants.F_OK), undefined, "stale file must be gone");
    assert.equal(await readFile(join(target, "fresh.md"), "utf8"), "fresh\n");
  });
});
