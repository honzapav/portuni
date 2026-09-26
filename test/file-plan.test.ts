// The Files tab's move plan (#445), spec
// docs/superpowers/specs/2026-09-22-files-organize-design.md.
//
// The plan is a pure value: dragging, "Nová složka" and folder renames only
// rewrite it, and "Použít" turns it into one move call per file. Everything
// the UI refuses (an occupied target, a folder into its own subtree, an
// untracked file inside a folder) is decided here, at the drop, not at apply.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planReasonText,
  applyPlan,
  planMove,
  planFolder,
  planFolderMove,
  planFolderRename,
  orderMoves,
  type FilePlan,
  type PlanFile,
} from "../apps/web/src/lib/file-plan.js";
import { createI18n } from "../apps/server/shared/i18n/create.js";
import { RESOURCES } from "../apps/server/shared/i18n/resources.js";

const { i18n } = createI18n({
  lng: "en",
  resources: { en: RESOURCES.en, cs: RESOURCES.cs },
  escapeValue: false,
  initAsync: false,
});
const tEn = i18n.getFixedT("en", "files");
const tCs = i18n.getFixedT("cs", "files");

const EMPTY: FilePlan = { moves: {}, folders: [] };

function file(relative_path: string, fileId: string | null = relative_path): PlanFile {
  const filename = relative_path.slice(relative_path.lastIndexOf("/") + 1);
  return { relative_path, filename, fileId };
}

function occupiedOf(files: readonly PlanFile[], plan: FilePlan = EMPTY): Set<string> {
  return new Set(applyPlan(files, plan).files.map((f) => f.relative_path));
}

function plan(moves: FilePlan["moves"], folders: string[] = []): FilePlan {
  return { moves, folders };
}

describe("applyPlan", () => {
  it("substitutes planned paths and keeps the folder the file sits in today", () => {
    const files = [file("wip/a.md"), file("outputs/b.md")];
    const r = applyPlan(files, plan({ "wip/a.md": { section: "wip", subpath: "navrhy" } }));
    const a = r.files.find((f) => f.fileId === "wip/a.md")!;
    assert.equal(a.relative_path, "wip/navrhy/a.md");
    assert.equal(a.planned_from, "wip");
    const b = r.files.find((f) => f.fileId === "outputs/b.md")!;
    assert.equal(b.relative_path, "outputs/b.md");
    assert.equal(b.planned_from, null);
  });

  it("reports the virtual folders and drops one a real file already sits in", () => {
    const files = [file("wip/navrhy/a.md")];
    const r = applyPlan(files, plan({}, ["wip/navrhy", "wip/nove"]));
    assert.deepEqual(r.folders, ["wip/nove"]);
    assert.deepEqual(r.plan.folders, ["wip/nove"]);
  });

  it("drops a stale entry and one whose file is already at its target", () => {
    const files = [file("wip/a.md"), file("wip/navrhy/b.md")];
    const r = applyPlan(
      files,
      plan({
        "wip/a.md": { section: "wip", subpath: null }, // already there
        "wip/navrhy/b.md": { section: "wip", subpath: "navrhy" }, // already there
        "gone.md": { section: "outputs", subpath: null }, // file no longer exists
      }),
    );
    assert.deepEqual(r.plan.moves, {});
    assert.equal(r.files.every((f) => f.planned_from === null), true);
  });
});

describe("planMove", () => {
  it("refuses an occupied target", () => {
    const files = [file("wip/a.md"), file("outputs/a.md")];
    const r = planMove(EMPTY, files[0], "outputs", occupiedOf(files));
    assert.equal(r.ok, false);
    assert.deepEqual(r.ok === false ? r.reason : null, { code: "file_exists", name: "a.md" });
  });

  it("refuses an untracked file", () => {
    const f = file("wip/a.md", null);
    const r = planMove(EMPTY, f, "outputs", occupiedOf([f]));
    assert.equal(r.ok, false);
    assert.deepEqual(r.ok === false ? r.reason : null, { code: "untracked" });
  });

  it("removes the entry when the file goes home", () => {
    const files = [file("wip/a.md")];
    const moved = planMove(EMPTY, files[0], "outputs", occupiedOf(files));
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    assert.deepEqual(moved.plan.moves, { "wip/a.md": { section: "outputs", subpath: null } });
    const back = planMove(moved.plan, files[0], "wip", occupiedOf(files, moved.plan));
    assert.equal(back.ok, true);
    if (!back.ok) return;
    assert.deepEqual(back.plan.moves, {});
  });

  it("plans into a virtual folder", () => {
    const files = [file("wip/a.md")];
    const created = planFolder(EMPTY, "wip/nove/", new Set(["wip"]));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const r = planMove(created.plan, files[0], "wip/nove", occupiedOf(files, created.plan));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.moves, { "wip/a.md": { section: "wip", subpath: "nove" } });
  });
});

describe("planFolderMove", () => {
  it("refuses a folder into its own subtree and into itself", () => {
    const files = [file("wip/navrhy/a.md"), file("wip/navrhy/v2/b.md")];
    const occ = occupiedOf(files);
    assert.equal(planFolderMove(EMPTY, "wip/navrhy", "wip/navrhy/v2", files, occ).ok, false);
    assert.equal(planFolderMove(EMPTY, "wip/navrhy", "wip/navrhy", files, occ).ok, false);
  });

  it("plans one move per registered file under the folder", () => {
    const files = [file("wip/navrhy/a.md"), file("wip/navrhy/v2/b.md")];
    const r = planFolderMove(EMPTY, "wip/navrhy", "outputs", files, occupiedOf(files));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.moves, {
      "wip/navrhy/a.md": { section: "outputs", subpath: "navrhy" },
      "wip/navrhy/v2/b.md": { section: "outputs", subpath: "navrhy/v2" },
    });
  });
});

describe("planFolderRename", () => {
  it("turns a real folder into one move per file under it", () => {
    const files = [file("wip/navrhy/a.md"), file("wip/navrhy/v2/b.md")];
    const r = planFolderRename(EMPTY, "wip/navrhy", "navrhy-2026", files, occupiedOf(files));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.moves, {
      "wip/navrhy/a.md": { section: "wip", subpath: "navrhy-2026" },
      "wip/navrhy/v2/b.md": { section: "wip", subpath: "navrhy-2026/v2" },
    });
    // The tree then shows the files under the new folder; the old one is gone
    // because nothing is in it any more (rule 4).
    const tree = applyPlan(files, r.plan);
    assert.deepEqual(
      tree.files.map((f) => f.relative_path).sort(),
      ["wip/navrhy-2026/a.md", "wip/navrhy-2026/v2/b.md"],
    );
  });

  it("renames a virtual folder and retargets the entries under it", () => {
    const files = [file("wip/a.md")];
    const created = planFolder(EMPTY, "wip/nove", new Set(["wip"]));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const moved = planMove(created.plan, files[0], "wip/nove", occupiedOf(files, created.plan));
    assert.equal(moved.ok, true);
    if (!moved.ok) return;
    const r = planFolderRename(
      moved.plan,
      "wip/nove",
      "navrhy",
      files,
      occupiedOf(files, moved.plan),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.folders, ["wip/navrhy"]);
    assert.deepEqual(r.plan.moves, { "wip/a.md": { section: "wip", subpath: "navrhy" } });
  });

  it("refuses an untracked file inside the folder", () => {
    const files = [file("wip/navrhy/a.md"), file("wip/navrhy/b.md", null)];
    const r = planFolderRename(EMPTY, "wip/navrhy", "navrhy-2026", files, occupiedOf(files));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false ? r.reason.code : null, "folder_has_untracked");
  });

  it("refuses a name that already exists and a section root", () => {
    const files = [file("wip/navrhy/a.md"), file("wip/hotovo/b.md")];
    const occ = occupiedOf(files);
    const taken = planFolderRename(EMPTY, "wip/navrhy", "hotovo", files, occ);
    assert.equal(taken.ok, false);
    assert.deepEqual(taken.ok === false ? taken.reason : null, { code: "folder_exists", name: "hotovo" });
    const section = planFolderRename(EMPTY, "wip", "rozpracovane", files, occ);
    assert.equal(section.ok, false);
    const unsafe = planFolderRename(EMPTY, "wip/navrhy", "..", files, occ);
    assert.equal(unsafe.ok, false);
  });
});

describe("planFolder", () => {
  it("requires a section prefix and a name inside it", () => {
    assert.equal(planFolder(EMPTY, "jine/nove", new Set()).ok, false);
    assert.equal(planFolder(EMPTY, "wip/", new Set()).ok, false);
    assert.equal(planFolder(EMPTY, "", new Set()).ok, false);
  });

  it("refuses an unsafe segment", () => {
    for (const path of ["wip/../tajne", "wip/a//b", "wip/ mezera", "wip/konec ", "wip/a\0b"]) {
      assert.equal(planFolder(EMPTY, path, new Set()).ok, false, path);
    }
  });

  it("refuses a path that exists, real or virtual", () => {
    const real = planFolder(EMPTY, "wip/navrhy", new Set(["wip/navrhy"]));
    assert.equal(real.ok, false);
    const created = planFolder(EMPTY, "wip/nove", new Set());
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.deepEqual(created.plan.folders, ["wip/nove"]);
    assert.equal(planFolder(created.plan, "wip/nove", new Set()).ok, false);
  });
});

describe("orderMoves", () => {
  it("orders shallower targets first, then by path", () => {
    const p = plan({
      c: { section: "wip", subpath: "navrhy/v2" },
      a: { section: "outputs", subpath: null },
      b: { section: "wip", subpath: "navrhy" },
      d: { section: "wip", subpath: null },
    });
    assert.deepEqual(
      orderMoves(p).map((m) => `${m.fileId}:${m.path}`),
      ["a:outputs", "d:wip", "b:wip/navrhy", "c:wip/navrhy/v2"],
    );
  });
});

describe("planReasonText", () => {
  it("renders a refusal in the UI language, the file name as a value", () => {
    const reason = { code: "file_exists", name: "a.md" } as const;
    assert.equal(planReasonText(reason, tEn), "The folder already has a file a.md");
    assert.equal(planReasonText(reason, tCs), "Ve složce už soubor a.md je");
    assert.equal(planReasonText({ code: "no_mirror" }, tEn), "Create the node's mirror first");
  });
});
