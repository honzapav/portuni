// The Files tab's tree helpers (#446), spec
// docs/superpowers/specs/2026-09-22-files-organize-design.md.
//
// buildFileTree / sortChildren / aggregateFolderSync moved out of
// DetailPane.files.tsx so the tree shape is testable without a browser:
// section order, folders before files, and the dot a folder shows for the
// files inside it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateFolderSync,
  buildFileTree,
  isSectionRoot,
  sortChildren,
  type TreeFile,
  type TreeNode,
} from "../apps/web/src/lib/file-tree.js";
import type { SyncStatusFile } from "../apps/web/src/types.js";

function file(relPath: string, fileId: string | null = relPath): TreeFile {
  const filename = relPath.slice(relPath.lastIndexOf("/") + 1);
  return {
    relative_path: relPath,
    filename,
    mime_type: "text/markdown",
    fileId,
    local_path: `/mirror/${relPath}`,
  };
}

function syncMap(entries: Array<[string, SyncStatusFile["sync_class"]]>) {
  const m = new Map<string, SyncStatusFile>();
  for (const [id, cls] of entries) {
    m.set(id, { file_id: id, sync_class: cls } as unknown as SyncStatusFile);
  }
  return m;
}

function child(node: TreeNode, name: string): TreeNode {
  const c = node.children?.get(name);
  assert.ok(c, `missing child ${name}`);
  return c;
}

describe("file tree", () => {
  it("adds the plan's virtual folders as empty rows and fills one that gets a file (#447)", () => {
    const root = buildFileTree([file("wip/navrhy/hero-a.png")], [
      "wip/nove/leden",
      "wip/navrhy",
    ]);
    const wip = child(root, "wip");
    const leden = child(child(wip, "nove"), "leden");
    assert.equal(leden.path, "wip/nove/leden");
    assert.equal(leden.children?.size, 0);
    // A virtual folder that a real file already sits in keeps that file;
    // applyPlan is what drops it from the plan (rule 4).
    const navrhy = child(wip, "navrhy");
    assert.equal(navrhy.children?.size, 1);
  });

  it("builds nested folders from relative paths", () => {
    const root = buildFileTree([
      file("wip/navrhy/hero-a.png"),
      file("wip/brief.md"),
    ]);
    const wip = child(root, "wip");
    assert.equal(wip.path, "wip");
    assert.ok(wip.children);
    const navrhy = child(wip, "navrhy");
    assert.equal(navrhy.path, "wip/navrhy");
    assert.equal(
      child(navrhy, "hero-a.png").file?.relative_path,
      "wip/navrhy/hero-a.png",
    );
    assert.equal(child(wip, "brief.md").file?.filename, "brief.md");
  });

  it("orders the top level wip, outputs, resources, then the rest", () => {
    const root = buildFileTree([
      file("zbytek/poznamka.md"),
      file("resources/cenik.xlsx"),
      file("outputs/nabidka.pdf"),
      file("archiv/stare.md"),
      file("wip/brief.md"),
    ]);
    assert.deepEqual(
      sortChildren(root, true).map((n) => n.name),
      ["wip", "outputs", "resources", "archiv", "zbytek"],
    );
  });

  it("orders folder children folders first, then files, both alphabetically", () => {
    const root = buildFileTree([
      file("wip/zaver.md"),
      file("wip/brief.md"),
      file("wip/navrhy/hero.png"),
      file("wip/archiv/stare.md"),
    ]);
    assert.deepEqual(
      sortChildren(child(root, "wip"), false).map((n) => n.name),
      ["archiv", "navrhy", "brief.md", "zaver.md"],
    );
  });

  it("marks only top-level wip / outputs / resources as section roots", () => {
    const root = buildFileTree([
      file("wip/navrhy/hero.png"),
      file("wip/brief.md"),
      file("archiv/stare.md"),
    ]);
    const wip = child(root, "wip");
    assert.equal(isSectionRoot(wip, 0), true);
    assert.equal(isSectionRoot(child(root, "archiv"), 0), false);
    // A folder named like a section deeper in the tree is a plain folder.
    assert.equal(isSectionRoot(child(wip, "navrhy"), 1), false);
    assert.equal(isSectionRoot(child(wip, "brief.md"), 0), false);
  });

  describe("folder sync dot", () => {
    // An untracked file inside never counts towards the dot.
    const tree = buildFileTree([
      file("wip/navrhy/hero-a.png", "a"),
      file("wip/navrhy/hero-b.png", "b"),
      file("wip/navrhy/draft.md", null),
    ]);
    const navrhy = child(child(tree, "wip"), "navrhy");

    it("shows nothing while no file inside is mapped yet", () => {
      assert.equal(aggregateFolderSync(navrhy, syncMap([])), null);
      assert.equal(
        aggregateFolderSync(navrhy, syncMap([["other", "push"]])),
        null,
      );
    });

    it("prefers a conflict over anything else", () => {
      const dot = aggregateFolderSync(
        navrhy,
        syncMap([
          ["a", "conflict"],
          ["b", "push"],
        ]),
      );
      assert.equal(dot?.color, "var(--color-danger)");
    });

    it("shows pending over remote_missing and clean", () => {
      const dot = aggregateFolderSync(
        navrhy,
        syncMap([
          ["a", "clean"],
          ["b", "push"],
        ]),
      );
      assert.equal(dot?.color, "var(--color-node-process)");
      const missing = aggregateFolderSync(
        navrhy,
        syncMap([
          ["a", "clean"],
          ["b", "remote_missing"],
        ]),
      );
      assert.equal(missing?.color, "var(--color-status-archived)");
    });

    it("shows clean when every mapped file inside is clean", () => {
      const dot = aggregateFolderSync(
        navrhy,
        syncMap([
          ["a", "clean"],
          ["b", "clean"],
        ]),
      );
      assert.equal(dot?.color, "var(--color-status-active)");
      assert.equal(dot?.title, "Vše synchronizováno");
    });
  });
});
