// The Files tab's move plan (#445).
//
// Spec: docs/superpowers/specs/2026-09-22-files-organize-design.md. Dragging
// files and folders, "Nová složka" and renaming a folder edit a plan and
// nothing else: disk, graph and remote stay as they are until "Použít", which
// runs the existing move route once per planned file (rules 1 and 2). These
// helpers are pure -- the Files tab holds the plan in state, persists it per
// node (loadFilePlan/saveFilePlan in settings.ts) and lays it over a freshly
// polled tree on every refresh (rule 3).

import type { TFunction } from "i18next";

export type Section = "wip" | "outputs" | "resources";

export const SECTIONS: readonly Section[] = ["wip", "outputs", "resources"];

// A move target as the move route expects it: the section plus the folder
// path under it (null = the section root).
export type MoveTarget = { section: Section; subpath: string | null };

export type FilePlan = {
  // file id -> target folder. Keyed by file id, never by path (rule 3).
  moves: Record<string, MoveTarget>;
  // Virtual folders as node-relative paths, e.g. "wip/navrhy/v2" (rule 4).
  folders: string[];
};

export const EMPTY_PLAN: FilePlan = { moves: {}, folders: [] };

// What the plan helpers need from a tree row. DetailPane's TreeFile is a
// superset, so it passes through applyPlan unchanged.
export type PlanFile = {
  relative_path: string;
  filename: string;
  fileId: string | null; // null = untracked, not in `files` (rule 5)
};

export type PlanResult =
  | { ok: true; plan: FilePlan }
  | { ok: false; reason: PlanReason };

// Why a plan step, a drag or a folder action is refused (spec, Errors). A
// code with the names it needs, never text: planReasonText renders it from
// the `files` catalog, one message per code (i18n spec, rule 7).
export type PlanReason =
  | { code: "no_mirror" }
  | { code: "untracked" }
  | { code: "file_gone" }
  | { code: "drag_outside_sections" }
  | { code: "not_a_folder" }
  | { code: "target_outside_sections" }
  | { code: "file_exists"; name: string }
  | { code: "folder_has_untracked"; name: string }
  | { code: "section_move" }
  | { code: "into_itself" }
  | { code: "section_rename" }
  | { code: "invalid_folder_name" }
  | { code: "folder_exists"; name: string }
  | { code: "path_empty" }
  | { code: "path_outside_sections" }
  | { code: "path_needs_name" };

type FilesT = TFunction<"files">;

const PLAN_REASON_TEXT: {
  [C in PlanReason["code"]]: (t: FilesT, r: Extract<PlanReason, { code: C }>) => string;
} = {
  no_mirror: (t) => t(($) => $.plan_reason.no_mirror, { ns: "files" }),
  untracked: (t) => t(($) => $.plan_reason.untracked, { ns: "files" }),
  file_gone: (t) => t(($) => $.plan_reason.file_gone, { ns: "files" }),
  drag_outside_sections: (t) => t(($) => $.plan_reason.drag_outside_sections, { ns: "files" }),
  not_a_folder: (t) => t(($) => $.plan_reason.not_a_folder, { ns: "files" }),
  target_outside_sections: (t) => t(($) => $.plan_reason.target_outside_sections, { ns: "files" }),
  file_exists: (t, r) => t(($) => $.plan_reason.file_exists, { ns: "files", name: r.name }),
  folder_has_untracked: (t, r) =>
    t(($) => $.plan_reason.folder_has_untracked, { ns: "files", name: r.name }),
  section_move: (t) => t(($) => $.plan_reason.section_move, { ns: "files" }),
  into_itself: (t) => t(($) => $.plan_reason.into_itself, { ns: "files" }),
  section_rename: (t) => t(($) => $.plan_reason.section_rename, { ns: "files" }),
  invalid_folder_name: (t) => t(($) => $.plan_reason.invalid_folder_name, { ns: "files" }),
  folder_exists: (t, r) => t(($) => $.plan_reason.folder_exists, { ns: "files", name: r.name }),
  path_empty: (t) => t(($) => $.plan_reason.path_empty, { ns: "files" }),
  path_outside_sections: (t) => t(($) => $.plan_reason.path_outside_sections, { ns: "files" }),
  path_needs_name: (t) => t(($) => $.plan_reason.path_needs_name, { ns: "files" }),
};

export function planReasonText(reason: PlanReason, t: FilesT): string {
  const render = PLAN_REASON_TEXT[reason.code] as (t: FilesT, r: PlanReason) => string;
  return render(t, reason);
}

// A tree row after the plan is laid over it: `planned_from` is the folder the
// file still sits in today, so the row can strike it through (null = the file
// is not part of the plan).
export type PlannedFile<F extends PlanFile> = F & { planned_from: string | null };

export type PlannedMove = { fileId: string; target: MoveTarget; path: string };

// --- paths ----------------------------------------------------------------

export function folderPathOf(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? "" : relativePath.slice(0, i);
}

export function basenameOf(relativePath: string): string {
  const i = relativePath.lastIndexOf("/");
  return i === -1 ? relativePath : relativePath.slice(i + 1);
}

export function targetToFolderPath(target: MoveTarget): string {
  return target.subpath ? `${target.section}/${target.subpath}` : target.section;
}

// "wip/navrhy/v2" -> { section: "wip", subpath: "navrhy/v2" }; null for a path
// that is not under one of the three sections (rule: only those move).
export function folderPathToTarget(folderPath: string): MoveTarget | null {
  const parts = folderPath.split("/");
  const section = parts[0];
  if (!isSection(section)) return null;
  const rest = parts.slice(1);
  if (rest.some((seg) => !isSafeSegment(seg))) return null;
  return { section, subpath: rest.length === 0 ? null : rest.join("/") };
}

export function isSection(value: string): value is Section {
  return value === "wip" || value === "outputs" || value === "resources";
}

// Same rules the server's assertSafeSegment applies, plus the surrounding
// whitespace a hand-typed folder name can carry.
function isSafeSegment(seg: string): boolean {
  if (seg === "" || seg === "." || seg === "..") return false;
  if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return false;
  if (seg !== seg.trim()) return false;
  return true;
}

function joinPath(folderPath: string, name: string): string {
  return folderPath === "" ? name : `${folderPath}/${name}`;
}

function depthOf(path: string): number {
  return path.split("/").length;
}

// --- plan reading ---------------------------------------------------------

function effectivePathOf(file: PlanFile, plan: FilePlan): string {
  const target = file.fileId ? plan.moves[file.fileId] : undefined;
  if (!target) return file.relative_path;
  return joinPath(targetToFolderPath(target), basenameOf(file.relative_path));
}

// Every folder path a file really sits in today (its own ancestors), used to
// tell a virtual folder from a real one and to refuse a new folder whose
// path already exists ("Nová složka", #448).
export function folderPathsOf(files: readonly PlanFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.relative_path.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

function clonePlan(plan: FilePlan): FilePlan {
  return { moves: { ...plan.moves }, folders: [...plan.folders] };
}

// Set or clear one entry: a file planned back into the folder it already
// lives in has no entry at all.
function setMove(moves: Record<string, MoveTarget>, file: PlanFile, targetFolder: string): void {
  const fileId = file.fileId;
  if (!fileId) return;
  const target = folderPathToTarget(targetFolder);
  if (!target) return;
  if (targetFolder === folderPathOf(file.relative_path)) delete moves[fileId];
  else moves[fileId] = target;
}

// --- applyPlan ------------------------------------------------------------

// Lay the plan over freshly polled tree files: planned paths substituted, the
// virtual folders that are still virtual, and the cleaned plan (rule 3 --
// an entry whose file is gone or already sits at its target is dropped; a
// folder that some real file already sits in is not virtual any more).
export function applyPlan<F extends PlanFile>(
  files: readonly F[],
  plan: FilePlan,
): { files: PlannedFile<F>[]; folders: string[]; plan: FilePlan } {
  const byId = new Map<string, F>();
  for (const f of files) if (f.fileId) byId.set(f.fileId, f);

  const moves: Record<string, MoveTarget> = {};
  for (const [fileId, target] of Object.entries(plan.moves)) {
    const file = byId.get(fileId);
    if (!file) continue; // the file is gone
    const targetFolder = targetToFolderPath(target);
    if (!folderPathToTarget(targetFolder)) continue; // unusable target
    if (folderPathOf(file.relative_path) === targetFolder) continue; // already there
    moves[fileId] = target;
  }

  const real = folderPathsOf(files);
  const folders: string[] = [];
  for (const path of plan.folders) {
    if (folders.includes(path)) continue;
    if (!folderPathToTarget(path)) continue;
    if (real.has(path)) continue; // an applied move made it real (rule 4)
    folders.push(path);
  }
  folders.sort();

  const cleaned: FilePlan = { moves, folders };
  const out = files.map((f): PlannedFile<F> => {
    const target = f.fileId ? moves[f.fileId] : undefined;
    if (!target) return { ...f, planned_from: null };
    const from = folderPathOf(f.relative_path);
    return {
      ...f,
      relative_path: joinPath(targetToFolderPath(target), basenameOf(f.relative_path)),
      planned_from: from,
    };
  });
  return { files: out, folders, plan: cleaned };
}

// --- planMove -------------------------------------------------------------

// Plan one file into `targetFolder`. `occupied` is the effective path of every
// file in the tree (applyPlan's output), so a target taken by a real or an
// already planned file is refused at the drop, not at apply (rule 6).
export function planMove(
  plan: FilePlan,
  file: PlanFile,
  targetFolder: string,
  occupied: ReadonlySet<string>,
): PlanResult {
  if (!file.fileId) return { ok: false, reason: { code: "untracked" } };
  const target = folderPathToTarget(targetFolder);
  if (!target) {
    return { ok: false, reason: { code: "target_outside_sections" } };
  }
  const name = basenameOf(file.relative_path);
  const home = folderPathOf(file.relative_path);
  const moves = { ...plan.moves };
  if (targetFolder === home) {
    delete moves[file.fileId];
    return { ok: true, plan: { moves, folders: [...plan.folders] } };
  }
  const newPath = joinPath(targetFolder, name);
  if (newPath !== effectivePathOf(file, plan) && occupied.has(newPath)) {
    return { ok: false, reason: { code: "file_exists", name } };
  }
  moves[file.fileId] = target;
  return { ok: true, plan: { moves, folders: [...plan.folders] } };
}

// --- folder moves and renames ---------------------------------------------

// Shared body of a folder drag and a folder rename: every registered file
// effectively under `folderPath` is planned into the matching place under
// `newFolderPath` (rule 10), the virtual folder entries under it follow, and
// a single untracked file inside refuses the whole thing (rule 5) so a folder
// never ends up half moved.
function replanFolder(
  plan: FilePlan,
  folderPath: string,
  newFolderPath: string,
  files: readonly PlanFile[],
  occupied: ReadonlySet<string>,
): PlanResult {
  const prefix = `${folderPath}/`;
  const inside = files.filter((f) => effectivePathOf(f, plan).startsWith(prefix));
  const untracked = inside.find((f) => !f.fileId);
  if (untracked) {
    return {
      ok: false,
      reason: { code: "folder_has_untracked", name: basenameOf(untracked.relative_path) },
    };
  }
  const leaving = new Set(inside.map((f) => effectivePathOf(f, plan)));
  const moves = { ...plan.moves };
  const taken = new Set<string>();
  for (const f of inside) {
    const newPath = newFolderPath + effectivePathOf(f, plan).slice(folderPath.length);
    if ((occupied.has(newPath) && !leaving.has(newPath)) || taken.has(newPath)) {
      return { ok: false, reason: { code: "file_exists", name: basenameOf(newPath) } };
    }
    taken.add(newPath);
    const targetFolder = folderPathOf(newPath);
    if (!folderPathToTarget(targetFolder)) {
      return { ok: false, reason: { code: "target_outside_sections" } };
    }
    setMove(moves, f, targetFolder);
  }
  const folders = plan.folders.map((p) =>
    p === folderPath
      ? newFolderPath
      : p.startsWith(prefix)
        ? newFolderPath + p.slice(folderPath.length)
        : p,
  );
  return { ok: true, plan: { moves, folders } };
}

// Drag a whole folder into `targetFolder`: one planned move per registered
// file under it. Refused for a folder dropped into itself or its own subtree.
export function planFolderMove(
  plan: FilePlan,
  folderPath: string,
  targetFolder: string,
  files: readonly PlanFile[],
  occupied: ReadonlySet<string>,
): PlanResult {
  if (folderPath.split("/").length < 2) {
    return { ok: false, reason: { code: "section_move" } };
  }
  if (!folderPathToTarget(targetFolder)) {
    return { ok: false, reason: { code: "target_outside_sections" } };
  }
  if (targetFolder === folderPath || targetFolder.startsWith(`${folderPath}/`)) {
    return { ok: false, reason: { code: "into_itself" } };
  }
  const newFolderPath = joinPath(targetFolder, basenameOf(folderPath));
  if (newFolderPath === folderPath) return { ok: true, plan: clonePlan(plan) };
  return replanFolder(plan, folderPath, newFolderPath, files, occupied);
}

// Rename a folder: a real one becomes one planned move per file under it
// (rule 10, the old folder leaves the tree because nothing is in it any more),
// a virtual one is renamed in `folders` and every entry under it retargeted.
export function planFolderRename(
  plan: FilePlan,
  folderPath: string,
  newName: string,
  files: readonly PlanFile[],
  occupied: ReadonlySet<string>,
): PlanResult {
  const parts = folderPath.split("/");
  if (parts.length < 2 || !isSection(parts[0])) {
    return { ok: false, reason: { code: "section_rename" } };
  }
  if (!isSafeSegment(newName)) {
    return { ok: false, reason: { code: "invalid_folder_name" } };
  }
  const newFolderPath = [...parts.slice(0, -1), newName].join("/");
  if (newFolderPath === folderPath) return { ok: true, plan: clonePlan(plan) };
  const existing = new Set<string>(plan.folders);
  for (const path of occupied) {
    const segs = path.split("/");
    for (let i = 1; i < segs.length; i++) existing.add(segs.slice(0, i).join("/"));
  }
  if (existing.has(newFolderPath)) {
    return { ok: false, reason: { code: "folder_exists", name: newName } };
  }
  return replanFolder(plan, folderPath, newFolderPath, files, occupied);
}

// --- planFolder -----------------------------------------------------------

// "Nová složka" / "Nová podsložka": a virtual folder, a row in the tree and
// nothing else until an applied move puts a file in it (rule 4).
export function planFolder(
  plan: FilePlan,
  path: string,
  existingFolders: ReadonlySet<string>,
): PlanResult {
  // The form prefills "wip/", so one trailing slash is the user typing a
  // folder name and stopping, not an empty segment.
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  if (trimmed === "") return { ok: false, reason: { code: "path_empty" } };
  const parts = trimmed.split("/");
  if (!isSection(parts[0])) {
    return { ok: false, reason: { code: "path_outside_sections" } };
  }
  if (parts.length < 2) {
    return { ok: false, reason: { code: "path_needs_name" } };
  }
  for (const seg of parts.slice(1)) {
    if (!isSafeSegment(seg)) return { ok: false, reason: { code: "invalid_folder_name" } };
  }
  if (existingFolders.has(trimmed) || plan.folders.includes(trimmed)) {
    return { ok: false, reason: { code: "folder_exists", name: trimmed } };
  }
  return { ok: true, plan: { moves: { ...plan.moves }, folders: [...plan.folders, trimmed] } };
}

// --- pruneEmptyFolders ----------------------------------------------------

// Every folder path that holds something under `plan`: the ancestors of every
// file's effective path.
function occupiedFolders(files: readonly PlanFile[], plan: FilePlan): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const parts = effectivePathOf(f, plan).split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

// Rule 4, the other half of applyPlan's cleaning: a virtual folder that the
// edit just emptied -- its last file was dragged out or its plan entry was
// undone -- leaves the plan. A folder that held nothing before the edit
// either (the one "Nová složka" has just created, or an untouched one) stays:
// an empty row is exactly what a freshly created folder is until a file
// lands in it.
export function pruneEmptyFolders(
  prev: FilePlan,
  next: FilePlan,
  files: readonly PlanFile[],
): FilePlan {
  const before = occupiedFolders(files, prev);
  const after = occupiedFolders(files, next);
  const folders = next.folders.filter((path) => after.has(path) || !before.has(path));
  if (folders.length === next.folders.length) return next;
  return { moves: next.moves, folders };
}

// --- plan size ------------------------------------------------------------

// Rule 1: the plan bar is up while the plan is not empty, and „Zahodit" is the
// escape hatch that drops the plan with no effect anywhere. Both kinds of
// entry are a change waiting to be used -- a planned move and a virtual folder
// alike -- so both are counted and both keep the bar up; a plan holding only a
// new folder is otherwise unreachable and the folder can never be removed
// (#452).
export function planChangeCount(plan: FilePlan): number {
  return Object.keys(plan.moves).length + plan.folders.length;
}

export function isPlanEmpty(plan: FilePlan): boolean {
  return planChangeCount(plan) === 0;
}

// What „Použít" has to do: only the moves. A virtual folder has nothing to
// apply -- it becomes real when an applied move puts the first file in it --
// so a plan of folders alone leaves „Použít" disabled instead of running an
// empty loop.
export function planApplyCount(plan: FilePlan): number {
  return Object.keys(plan.moves).length;
}

// --- orderMoves -----------------------------------------------------------

// Apply order: shallower targets first, then by path, so a folder's files land
// together and the tree refresh between moves reads sensibly.
export function orderMoves(plan: FilePlan): PlannedMove[] {
  return Object.entries(plan.moves)
    .map(([fileId, target]) => ({ fileId, target, path: targetToFolderPath(target) }))
    .sort((a, b) => {
      const d = depthOf(a.path) - depthOf(b.path);
      if (d !== 0) return d;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0;
    });
}

// --- the plan's node ------------------------------------------------------

// The held plan together with the node it was loaded for. The pairing is part
// of the value because the Files tab is never remounted on a node switch
// (App.tsx keeps the previous node detail while the new one loads), so a
// render can otherwise pair node B's files with node A's plan and the tree's
// cleaning pass then writes the cleaned remains under B's id (#451).
export type NodeFilePlan = { nodeId: string; plan: FilePlan };

// Rule 8: the plan belongs to the node. The held plan is the answer only for
// the node it was loaded for; for any other node the answer is a fresh load,
// computed during render so no render ever sees the other node's plan and no
// write can ever reach the wrong node's entry.
export function planForNode(
  held: NodeFilePlan,
  nodeId: string,
  load: (id: string) => FilePlan,
): NodeFilePlan {
  if (held.nodeId === nodeId) return held;
  return { nodeId, plan: load(nodeId) };
}
