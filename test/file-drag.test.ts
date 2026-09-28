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
  applyPlan,
  orderMoves,
  planForNode,
  type FilePlan,
  type MoveTarget,
  type NodeFilePlan,
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
    assert.deepEqual(check.reason, { code: "folder_has_untracked", name: "nove.png" });
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
      if (fileId === failing) throw new Error("Move failed: remote unavailable");
    });
    assert.deepEqual(calls, [order[0], order[1]]);
    assert.equal(outcome.done, 1);
    assert.equal(outcome.failure?.fileId, failing);
    assert.match(outcome.failure?.message ?? "", /remote unavailable/);
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
  // #451: the Files tab is not remounted on a node switch, so the plan is
  // paired with its node and the pairing is resolved during render. This is
  // that wiring, pure: what the tree renders is planForNode's plan, and what
  // the tree's cleaning pass writes back is applyPlan's cleaned plan under
  // planForNode's node id. The browser click-through (plan on A, open B,
  // return to A) is left for a human.
  function renderFilesTab(
    held: NodeFilePlan,
    nodeId: string,
    files: readonly PlanFile[],
  ): { held: NodeFilePlan; writes: { nodeId: string; plan: FilePlan }[] } {
    const writes: { nodeId: string; plan: FilePlan }[] = [];
    const current = planForNode(held, nodeId, loadFilePlan);
    const planned = applyPlan(files, current.plan);
    if (JSON.stringify(planned.plan) !== JSON.stringify(current.plan)) {
      writes.push({ nodeId: current.nodeId, plan: planned.plan });
      saveFilePlan(current.nodeId, planned.plan);
      return { held: { nodeId: current.nodeId, plan: planned.plan }, writes };
    }
    return { held: current, writes };
  }

  it("a plan loaded for A, laid over B's files, never writes for B (rule 8)", () => {
    withFakeWindow(() => {
      const planA: FilePlan = {
        moves: { fa: { section: "outputs", subpath: "hotove" } },
        folders: ["wip/nove"],
      };
      const planB: FilePlan = { moves: {}, folders: ["resources/zdroje"] };
      saveFilePlan("node-a", planA);
      saveFilePlan("node-b", planB);
      const filesA = [file("wip/a.md", "fa")];
      const filesB = [file("wip/b.md", "fb")];

      // Node A open: nothing to clean, nothing written.
      const a = renderFilesTab({ nodeId: "node-a", plan: planA }, "node-a", filesA);
      assert.deepEqual(a.writes, []);

      // Switch to B while A's plan is still the committed one: the render
      // pairs B with B's own plan, so no write carries A's remains to B.
      const b = renderFilesTab(a.held, "node-b", filesB);
      assert.deepEqual(b.writes, []);
      assert.equal(b.held.nodeId, "node-b");
      assert.deepEqual(b.held.plan, planB);
      assert.deepEqual(loadFilePlan("node-b"), planB);

      // And back to A: A's plan is exactly what it was.
      const back = renderFilesTab(b.held, "node-a", filesA);
      assert.deepEqual(back.writes, []);
      assert.deepEqual(back.held.plan, planA);
      assert.deepEqual(loadFilePlan("node-a"), planA);
    });
  });

  it("the unpaired plan is what corrupted the other node (rule 8, the defect)", () => {
    withFakeWindow(() => {
      const planA: FilePlan = {
        moves: { fa: { section: "outputs", subpath: "hotove" } },
        folders: ["wip/nove"],
      };
      saveFilePlan("node-b", { moves: {}, folders: ["resources/zdroje"] });
      // Node A's plan laid over node B's files: every entry is dropped
      // because A's file ids are not in B, which is the write that used to
      // land under B's id.
      const cleaned = applyPlan([file("wip/b.md", "fb")], planA).plan;
      assert.notDeepEqual(cleaned, planA);
      // planForNode is what keeps that pairing from ever happening.
      const current = planForNode({ nodeId: "node-a", plan: planA }, "node-b", loadFilePlan);
      assert.deepEqual(current, { nodeId: "node-b", plan: { moves: {}, folders: ["resources/zdroje"] } });
    });
  });
});
