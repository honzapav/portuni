// Drag and drop and "Použít" for the Files tab's move plan (#447).
//
// Spec: docs/superpowers/specs/2026-09-22-files-organize-design.md, sections
// "Dragging" and "Tree with a plan". Everything the drag can refuse (rules 5
// and 9) and the apply loop itself (rules 2 and 7) live here as pure
// functions, so they are tested from the server's node:test runner
// (test/file-drag.test.ts); DetailPane.files.tsx only wires DOM events to
// them.

import {
  basenameOf,
  folderPathOf,
  folderPathToTarget,
  orderMoves,
  type FilePlan,
  type MoveTarget,
  type PlanFile,
} from "./file-plan";

// Reasons a row cannot be dragged, shown as the row's title (spec, Errors).
export const NO_MIRROR_REASON = "Nejdřív vytvoř mirror uzlu";
export const UNTRACKED_REASON = "Soubor ještě není zaregistrovaný";
export const OUTSIDE_SECTIONS_REASON =
  "Přesouvat lze jen soubory ve složkách wip, outputs a resources";
export const NOT_A_FOLDER_REASON = "Tuhle složku přesunout nelze";

export type DragCheck = { draggable: boolean; reason: string | null };

// Rule 5 (only a registered file moves, and only within the three sections)
// and rule 9 (no mirror on this device, no plan). `file` carries the path the
// file really has today, not its planned one.
export function fileDragCheck(file: PlanFile, hasMirror: boolean): DragCheck {
  if (!hasMirror) return { draggable: false, reason: NO_MIRROR_REASON };
  if (!file.fileId) return { draggable: false, reason: UNTRACKED_REASON };
  if (!folderPathToTarget(folderPathOf(file.relative_path))) {
    return { draggable: false, reason: OUTSIDE_SECTIONS_REASON };
  }
  return { draggable: true, reason: null };
}

// A folder is dragged as its files (rule 10), so a single untracked file
// inside refuses the whole folder -- a folder never ends up half moved.
// `files` carry their effective paths (applyPlan's output): what the tree
// shows is what the drag moves.
export function folderDragCheck(
  folderPath: string,
  files: readonly PlanFile[],
  hasMirror: boolean,
): DragCheck {
  if (!hasMirror) return { draggable: false, reason: NO_MIRROR_REASON };
  if (folderPath.split("/").length < 2 || !folderPathToTarget(folderPath)) {
    return { draggable: false, reason: NOT_A_FOLDER_REASON };
  }
  const prefix = `${folderPath}/`;
  const untracked = files.find((f) => !f.fileId && f.relative_path.startsWith(prefix));
  if (untracked) {
    return {
      draggable: false,
      reason: `Ve složce je neregistrovaný soubor ${basenameOf(untracked.relative_path)}`,
    };
  }
  return { draggable: true, reason: null };
}

// Where a drop on this row lands: a folder row (real, virtual or a section
// root) is the target itself, a file row targets the folder it sits in
// (spec, Dragging).
export function dropTargetFolder(row: { path: string; isFile: boolean }): string {
  return row.isFile ? folderPathOf(row.path) : row.path;
}

// --- apply ----------------------------------------------------------------

export type ApplyProgress = { index: number; total: number; fileId: string };

export type ApplyOutcome = {
  // What is left planned afterwards: nothing on success, the failed entry
  // and everything after it on a failure (rule 7).
  plan: FilePlan;
  done: number;
  failure: { fileId: string; message: string } | null;
};

// "Použít": the existing move route once per planned file, in orderMoves
// order, stopping at the first failure (rules 2 and 7). The moves already
// done stay done; their entries leave the plan.
export async function applyMoves(
  plan: FilePlan,
  move: (fileId: string, target: MoveTarget) => Promise<unknown>,
  onProgress?: (progress: ApplyProgress) => void,
): Promise<ApplyOutcome> {
  const moves = orderMoves(plan);
  const remaining: FilePlan["moves"] = {};
  let done = 0;
  let failure: ApplyOutcome["failure"] = null;
  for (let i = 0; i < moves.length; i++) {
    const entry = moves[i];
    if (failure) {
      remaining[entry.fileId] = entry.target;
      continue;
    }
    onProgress?.({ index: i, total: moves.length, fileId: entry.fileId });
    try {
      await move(entry.fileId, entry.target);
      done += 1;
    } catch (e) {
      failure = { fileId: entry.fileId, message: e instanceof Error ? e.message : String(e) };
      remaining[entry.fileId] = entry.target;
    }
  }
  return { plan: { moves: remaining, folders: [...plan.folders] }, done, failure };
}

// --- hover expand ---------------------------------------------------------

// A collapsed folder expands after the cursor rests on it this long.
export const HOVER_EXPAND_MS = 600;

export type TimerFns = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const REAL_TIMERS: TimerFns = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type HoverExpand = {
  // The cursor is over `path`; restarts the timer when the path changes.
  over(path: string): void;
  // The drag left every target, or ended.
  cancel(): void;
};

// Expand-on-hover for a collapsed folder during a drag. The timer is
// injected so the 600 ms wait is tested without a sleep.
export function createHoverExpand(
  expand: (path: string) => void,
  timers: TimerFns = REAL_TIMERS,
  delayMs: number = HOVER_EXPAND_MS,
): HoverExpand {
  let handle: unknown = null;
  let current: string | null = null;
  const cancel = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
    current = null;
  };
  return {
    over(path: string) {
      if (current === path) return;
      cancel();
      current = path;
      handle = timers.setTimeout(() => {
        handle = null;
        current = null;
        expand(path);
      }, delayMs);
    },
    cancel,
  };
}
