// "Nová složka", "Nová podsložka" and renaming a folder in the Files tab
// (#448), spec docs/superpowers/specs/2026-09-22-files-organize-design.md
// (rules 4 and 10, sections „Nová složka" and Renaming a folder).
//
// All three are plan edits and nothing else: the form's validation, what the
// hover strip on a folder row offers, what a rename turns into, and the
// virtual folder an edit empties are decided by the pure helpers here; the
// React file only renders them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPlan,
  planFolder,
  planFolderRename,
  pruneEmptyFolders,
  folderPathsOf,
  type FilePlan,
  type PlanFile,
} from "../apps/web/src/lib/file-plan.js";
import { folderActionCheck, newFolderPrefill } from "../apps/web/src/lib/file-drag.js";
import { buildFileTree, type TreeFile } from "../apps/web/src/lib/file-tree.js";

const EMPTY: FilePlan = { moves: {}, folders: [] };

function file(relative_path: string, fileId: string | null = relative_path): PlanFile {
  const filename = relative_path.slice(relative_path.lastIndexOf("/") + 1);
  return { relative_path, filename, fileId };
}

function occupiedOf(files: readonly PlanFile[], plan: FilePlan = EMPTY): Set<string> {
  return new Set(applyPlan(files, plan).files.map((f) => f.relative_path));
}

// What the form does with what the user typed: planFolder over the real
// folders of the tree plus the plan's virtual ones.
function submitForm(plan: FilePlan, typed: string, files: readonly PlanFile[]) {
  return planFolder(plan, typed.trim(), folderPathsOf(files));
}

describe("the new-folder form", () => {
  const files = [file("wip/navrhy/hero.png"), file("outputs/report.md")];

  it("takes a valid path into the plan as a virtual folder", () => {
    const r = submitForm(EMPTY, "wip/archiv", files);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan.folders, ["wip/archiv"]);
    assert.deepEqual(r.ok && r.plan.moves, {});
  });

  it("accepts the prefilled section with a trailing slash typed into", () => {
    const r = submitForm(EMPTY, "wip/archiv/2026", files);
    assert.deepEqual(r.ok && r.plan.folders, ["wip/archiv/2026"]);
  });

  it("refuses a path a real folder already holds", () => {
    const r = submitForm(EMPTY, "wip/navrhy", files);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /už existuje/);
  });

  it("refuses a path a virtual folder already holds", () => {
    const first = submitForm(EMPTY, "wip/archiv", files);
    assert.equal(first.ok, true);
    const again = submitForm(first.ok ? first.plan : EMPTY, "wip/archiv", files);
    assert.equal(again.ok, false);
  });

  it("refuses an unsafe segment and a path outside the three sections", () => {
    for (const typed of ["wip/..", "wip/a//b", "wip/ mezera", "jine/archiv", "wip/"]) {
      assert.equal(submitForm(EMPTY, typed, files).ok, false, typed);
    }
  });

  it("the subfolder action prefills the form with the folder and a slash", () => {
    assert.equal(newFolderPrefill("wip/navrhy"), "wip/navrhy/");
  });
});

describe("folder row actions", () => {
  const files = [file("wip/navrhy/hero.png"), file("wip/hotovo/final.png", null)];

  it("a section root has no rename and no new-subfolder action", () => {
    for (const section of ["wip", "outputs", "resources"]) {
      assert.equal(folderActionCheck(section, files, true).visible, false, section);
    }
    assert.equal(folderActionCheck("jine", files, true).visible, false);
  });

  it("a folder under a section offers both actions", () => {
    const actions = folderActionCheck("wip/navrhy", files, true);
    assert.equal(actions.visible, true);
    assert.equal(actions.rename.enabled, true);
    assert.equal(actions.subfolder.enabled, true);
  });

  it("refuses the rename of a folder holding an untracked file, with the reason", () => {
    const actions = folderActionCheck("wip/hotovo", files, true);
    assert.equal(actions.visible, true);
    assert.equal(actions.rename.enabled, false);
    assert.match(actions.rename.reason ?? "", /neregistrovaný soubor final\.png/);
  });

  it("disables both actions without a mirror on this device (rule 9)", () => {
    const actions = folderActionCheck("wip/navrhy", files, false);
    assert.equal(actions.rename.enabled, false);
    assert.equal(actions.subfolder.enabled, false);
    assert.equal(actions.rename.reason, "Nejdřív vytvoř mirror uzlu");
    assert.equal(actions.subfolder.reason, "Nejdřív vytvoř mirror uzlu");
  });
});

describe("renaming a folder", () => {
  const files = [
    file("wip/navrhy/hero-a.png"),
    file("wip/navrhy/v2/hero-b.png"),
    file("wip/brief.md"),
  ];

  it("a real folder becomes one plan entry per registered file under it", () => {
    const r = planFolderRename(EMPTY, "wip/navrhy", "archiv", files, occupiedOf(files));
    assert.equal(r.ok, true);
    const moves = r.ok ? r.plan.moves : {};
    assert.deepEqual(Object.keys(moves).sort(), ["wip/navrhy/hero-a.png", "wip/navrhy/v2/hero-b.png"]);
    assert.deepEqual(moves["wip/navrhy/hero-a.png"], { section: "wip", subpath: "archiv" });
    assert.deepEqual(moves["wip/navrhy/v2/hero-b.png"], { section: "wip", subpath: "archiv/v2" });
  });

  it("the tree then shows the folder under its new name, every file planned", () => {
    const r = planFolderRename(EMPTY, "wip/navrhy", "archiv", files, occupiedOf(files));
    assert.equal(r.ok, true);
    const treeFiles: TreeFile[] = files.map((f) => ({
      ...f,
      mime_type: null,
      local_path: null,
    }));
    const planned = applyPlan(treeFiles, r.ok ? r.plan : EMPTY);
    const root = buildFileTree(planned.files, planned.folders);
    const wip = root.children!.get("wip")!;
    assert.equal(wip.children!.has("archiv"), true);
    assert.equal(wip.children!.has("navrhy"), false, "the emptied folder leaves the tree");
    const moved = planned.files.filter((f) => f.planned_from !== null);
    assert.deepEqual(
      moved.map((f) => f.relative_path).sort(),
      ["wip/archiv/hero-a.png", "wip/archiv/v2/hero-b.png"],
    );
    assert.equal(moved[0].planned_from, "wip/navrhy");
  });

  it("refuses while an untracked file is inside (rule 5)", () => {
    const withUntracked = [...files, file("wip/navrhy/scratch.txt", null)];
    const r = planFolderRename(
      EMPTY,
      "wip/navrhy",
      "archiv",
      withUntracked,
      occupiedOf(withUntracked),
    );
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /neregistrovaný soubor scratch\.txt/);
  });

  it("renames a virtual folder in the plan and retargets what points at it", () => {
    const created = planFolder(EMPTY, "wip/nove", folderPathsOf(files));
    assert.equal(created.ok, true);
    const base = created.ok ? created.plan : EMPTY;
    const withFile: FilePlan = {
      moves: { "wip/brief.md": { section: "wip", subpath: "nove" } },
      folders: base.folders,
    };
    const r = planFolderRename(withFile, "wip/nove", "hotovo", files, occupiedOf(files, withFile));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.plan.folders, ["wip/hotovo"]);
    assert.deepEqual(r.ok && r.plan.moves["wip/brief.md"], { section: "wip", subpath: "hotovo" });
  });

  it("refuses a name that a real or a virtual folder already has, and a section", () => {
    const occ = occupiedOf(files);
    assert.equal(planFolderRename(EMPTY, "wip/navrhy", "v2", files, occ).ok, true);
    const withVirtual: FilePlan = { moves: {}, folders: ["wip/archiv"] };
    assert.equal(planFolderRename(withVirtual, "wip/navrhy", "archiv", files, occ).ok, false);
    assert.equal(planFolderRename(EMPTY, "wip", "rozpracovane", files, occ).ok, false);
  });
});

describe("pruneEmptyFolders", () => {
  const files = [file("wip/hero.png"), file("wip/brief.md")];

  it("drops a virtual folder the edit just emptied (rule 4)", () => {
    const filled: FilePlan = {
      moves: { "wip/hero.png": { section: "wip", subpath: "archiv" } },
      folders: ["wip/archiv"],
    };
    // The file is dragged back home: nothing is planned into wip/archiv any
    // more, so the folder leaves the plan with it.
    const emptied: FilePlan = { moves: {}, folders: ["wip/archiv"] };
    const pruned = pruneEmptyFolders(filled, emptied, files);
    assert.deepEqual(pruned.folders, []);
    assert.deepEqual(pruned.moves, {});
  });

  it("keeps a folder that held nothing before the edit either", () => {
    const created: FilePlan = { moves: {}, folders: ["wip/archiv"] };
    const other: FilePlan = {
      moves: { "wip/hero.png": { section: "outputs", subpath: null } },
      folders: ["wip/archiv"],
    };
    // A freshly created folder is an empty row until a file lands in it; an
    // unrelated drag never removes it.
    assert.deepEqual(pruneEmptyFolders(created, other, files).folders, ["wip/archiv"]);
  });

  it("keeps a folder that still holds a planned file", () => {
    const before: FilePlan = {
      moves: {
        "wip/hero.png": { section: "wip", subpath: "archiv" },
        "wip/brief.md": { section: "wip", subpath: "archiv" },
      },
      folders: ["wip/archiv"],
    };
    const after: FilePlan = {
      moves: { "wip/brief.md": { section: "wip", subpath: "archiv" } },
      folders: ["wip/archiv"],
    };
    assert.deepEqual(pruneEmptyFolders(before, after, files).folders, ["wip/archiv"]);
  });
});
