// Drag and drop and "Použít" in the Files tab (#447), spec
// docs/superpowers/specs/2026-09-22-files-organize-design.md.
//
// What the drag refuses, where a drop lands and the apply loop are pure, so
// they are tested here rather than in a browser; DetailPane.files.tsx only
// binds DOM events to them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyMoves,
  createHoverExpand,
  dropTargetFolder,
  fileDragCheck,
  folderDragCheck,
  HOVER_EXPAND_MS,
  NO_MIRROR_REASON,
  UNTRACKED_REASON,
  type TimerFns,
} from "../apps/web/src/lib/file-drag.js";
import {
  orderMoves,
  type FilePlan,
  type MoveTarget,
  type PlanFile,
} from "../apps/web/src/lib/file-plan.js";
import { loadFilePlan, saveFilePlan } from "../apps/web/src/lib/settings.js";

function file(relative_path: string, fileId: string | null = relative_path): PlanFile {
  return {
    relative_path,
    filename: relative_path.slice(relative_path.lastIndexOf("/") + 1),
    fileId,
  };
}

describe("dropTargetFolder", () => {
  it("targets a file row's own folder and a folder row itself", () => {
    assert.equal(dropTargetFolder({ path: "wip/navrhy/a.md", isFile: true }), "wip/navrhy");
    assert.equal(dropTargetFolder({ path: "wip/navrhy", isFile: false }), "wip/navrhy");
    // A section root is a folder like any other for the drop.
    assert.equal(dropTargetFolder({ path: "outputs", isFile: false }), "outputs");
  });
});

describe("fileDragCheck", () => {
  it("refuses an untracked row with the reason in its title", () => {
    const check = fileDragCheck(file("wip/a.md", null), true);
    assert.equal(check.draggable, false);
    assert.equal(check.reason, UNTRACKED_REASON);
  });

  it("refuses every row without a mirror on this device (rule 9)", () => {
    const check = fileDragCheck(file("wip/a.md"), false);
    assert.equal(check.draggable, false);
    assert.equal(check.reason, NO_MIRROR_REASON);
  });

  it("refuses a file outside the three sections and allows one inside", () => {
    assert.equal(fileDragCheck(file("README.md"), true).draggable, false);
    assert.equal(fileDragCheck(file("jine/a.md"), true).draggable, false);
    assert.equal(fileDragCheck(file("wip/navrhy/a.md"), true).draggable, true);
  });
});

describe("folderDragCheck", () => {
  it("refuses a folder holding an untracked file, naming it", () => {
    const files = [file("wip/navrhy/a.md"), file("wip/navrhy/nove.png", null)];
    const check = folderDragCheck("wip/navrhy", files, true);
    assert.equal(check.draggable, false);
    assert.match(check.reason ?? "", /nove\.png/);
  });

  it("refuses a section root and allows a folder of registered files", () => {
    const files = [file("wip/navrhy/a.md")];
    assert.equal(folderDragCheck("wip", files, true).draggable, false);
    assert.equal(folderDragCheck("wip/navrhy", files, true).draggable, true);
  });
});

describe("applyMoves", () => {
  const plan: FilePlan = {
    moves: {
      f1: { section: "outputs", subpath: "hotove/leden" },
      f2: { section: "wip", subpath: null },
      f3: { section: "wip", subpath: "navrhy" },
    },
    folders: ["wip/nove"],
  };

  it("calls the move route once per file in orderMoves order", async () => {
    const calls: string[] = [];
    const outcome = await applyMoves(plan, async (fileId) => {
      calls.push(fileId);
    });
    assert.deepEqual(calls, orderMoves(plan).map((m) => m.fileId));
    assert.equal(outcome.done, 3);
    assert.equal(outcome.failure, null);
    assert.deepEqual(outcome.plan.moves, {});
    // Virtual folders are not moves; they survive the apply and applyPlan
    // drops the ones a moved file made real.
    assert.deepEqual(outcome.plan.folders, ["wip/nove"]);
  });

  it("stops at the first failure and leaves the rest of the plan alone", async () => {
    const order = orderMoves(plan).map((m) => m.fileId);
    const failing = order[1];
    const calls: string[] = [];
    const outcome = await applyMoves(plan, async (fileId) => {
      calls.push(fileId);
      if (fileId === failing) throw new Error("Přesun se nepovedl: remote nedostupný");
    });
    assert.deepEqual(calls, [order[0], order[1]]);
    assert.equal(outcome.done, 1);
    assert.equal(outcome.failure?.fileId, failing);
    assert.match(outcome.failure?.message ?? "", /remote nedostupný/);
    assert.deepEqual(Object.keys(outcome.plan.moves).sort(), [order[1], order[2]].sort());
  });

  it("reports progress per file", async () => {
    const seen: number[] = [];
    await applyMoves(
      plan,
      async () => undefined,
      (p) => {
        seen.push(p.index);
        assert.equal(p.total, 3);
      },
    );
    assert.deepEqual(seen, [0, 1, 2]);
  });
});

describe("createHoverExpand", () => {
  // An injected timer: no sleep, the 600 ms wait is fired by hand.
  function fakeTimers(): TimerFns & { fire: () => void; pending: () => number } {
    let next = 1;
    const queue = new Map<number, () => void>();
    return {
      setTimeout: (fn, ms) => {
        assert.equal(ms, HOVER_EXPAND_MS);
        const handle = next++;
        queue.set(handle, fn);
        return handle;
      },
      clearTimeout: (handle) => {
        queue.delete(handle as number);
      },
      fire: () => {
        for (const [handle, fn] of Array.from(queue.entries())) {
          queue.delete(handle);
          fn();
        }
      },
      pending: () => queue.size,
    };
  }

  it("expands the folder the cursor rested on", () => {
    const expanded: string[] = [];
    const timers = fakeTimers();
    const hover = createHoverExpand((p) => expanded.push(p), timers);
    hover.over("wip/navrhy");
    assert.deepEqual(expanded, []);
    timers.fire();
    assert.deepEqual(expanded, ["wip/navrhy"]);
  });

  it("restarts on a new folder and expands nothing after cancel", () => {
    const expanded: string[] = [];
    const timers = fakeTimers();
    const hover = createHoverExpand((p) => expanded.push(p), timers);
    hover.over("wip/navrhy");
    hover.over("outputs/hotove");
    assert.equal(timers.pending(), 1);
    hover.cancel();
    timers.fire();
    assert.deepEqual(expanded, []);
  });
});

describe("the plan in localStorage", () => {
  // settings.ts reads window.localStorage; workspace-storage falls back to
  // the unscoped key outside Tauri, which is what a browser build uses too.
  function withFakeWindow<T>(fn: () => T): T {
    const map = new Map<string, string>();
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    };
    try {
      return fn();
    } finally {
      if (original === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = original;
    }
  }

  it("survives leaving the node and is the node's own (rule 8)", () => {
    withFakeWindow(() => {
      const target: MoveTarget = { section: "outputs", subpath: "hotove" };
      saveFilePlan("node-a", { moves: { f1: target }, folders: ["wip/nove"] });
      // Remounting the tab for the same node reads the same plan back.
      const again = loadFilePlan("node-a");
      assert.deepEqual(again.moves, { f1: target });
      assert.deepEqual(again.folders, ["wip/nove"]);
      // Another node has none of it.
      assert.deepEqual(loadFilePlan("node-b"), { moves: {}, folders: [] });
      // "Zahodit" clears the node's entry.
      saveFilePlan("node-a", { moves: {}, folders: [] });
      assert.deepEqual(loadFilePlan("node-a"), { moves: {}, folders: [] });
    });
  });
});
