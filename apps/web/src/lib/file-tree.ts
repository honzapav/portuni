// The Files tab's tree shape (#446).
//
// Spec: docs/superpowers/specs/2026-09-22-files-organize-design.md, section
// "Files tab -> Tree". These helpers turn the flat row list the Files tab
// assembles (registered files plus untracked disk files) into the folder
// tree it renders, order its children and aggregate a folder's sync state.
// They are pure, so they are tested from the server's node:test runner
// (test/file-tree.test.ts); DetailPane.files.tsx only renders them.

import type { SyncStatusFile } from "../types";

// Unified leaf model: registered DetailFile or an untracked disk file.
export type TreeFile = {
  relative_path: string;
  filename: string;
  mime_type: string | null;
  fileId: string | null; // null = untracked (not in `files`)
  local_path: string | null;
};

export type TreeNode = {
  name: string;
  path: string;
  children?: Map<string, TreeNode>;
  file?: TreeFile;
};

export function buildFileTree(files: TreeFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const rel = f.relative_path;
    const parts = rel.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const childPath = parts.slice(0, i + 1).join("/");
      let child = cur.children!.get(seg);
      if (!child) {
        child = { name: seg, path: childPath, children: new Map() };
        cur.children!.set(seg, child);
      }
      cur = child;
    }
    const leafName = parts[parts.length - 1];
    cur.children!.set(leafName, { name: leafName, path: rel, file: f });
  }
  return root;
}

// Walk a folder subtree and aggregate sync classes of all files inside.
// Returns the worst color, mirroring the per-tab dot logic. Returns null
// if no file inside is mapped yet (so the folder shows no dot during
// initial load instead of misleading green).
export function aggregateFolderSync(
  node: TreeNode,
  map: Map<string, SyncStatusFile>,
): { color: string; title: string } | null {
  let hasConflict = false;
  let hasPending = false;
  let hasRemoteMissing = false;
  let hasClean = false;
  let any = false;
  const stack: TreeNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.file) {
      const sync = cur.file.fileId ? map.get(cur.file.fileId) : undefined;
      if (!sync) continue;
      any = true;
      if (sync.sync_class === "conflict") hasConflict = true;
      else if (
        sync.sync_class === "push" ||
        sync.sync_class === "pull" ||
        sync.sync_class === "deleted_local"
      ) {
        hasPending = true;
      } else if (sync.sync_class === "remote_missing") hasRemoteMissing = true;
      else if (sync.sync_class === "clean") hasClean = true;
    } else if (cur.children) {
      for (const c of cur.children.values()) stack.push(c);
    }
  }
  if (!any) return null;
  if (hasConflict)
    return { color: "var(--color-danger)", title: "Konflikt uvnitř" };
  if (hasPending)
    return {
      color: "var(--color-node-process)",
      title: "Soubory čekají na synchronizaci",
    };
  if (hasRemoteMissing)
    return {
      color: "var(--color-status-archived)",
      title: "Některé soubory chybí na remote",
    };
  if (hasClean)
    return {
      color: "var(--color-status-active)",
      title: "Vše synchronizováno",
    };
  return null;
}

// Order folder children: directories first (alphabetical), then files
// (alphabetical). Top-level wrapper enforces section order wip / outputs
// / resources / others to match how authors think about the workspace.
export const SECTION_ORDER = ["wip", "outputs", "resources"];

export function sortChildren(node: TreeNode, isRoot: boolean): TreeNode[] {
  const arr = Array.from(node.children!.values());
  if (isRoot) {
    return arr.sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a.name);
      const bi = SECTION_ORDER.indexOf(b.name);
      const aw = ai === -1 ? SECTION_ORDER.length : ai;
      const bw = bi === -1 ? SECTION_ORDER.length : bi;
      if (aw !== bw) return aw - bw;
      return a.name.localeCompare(b.name);
    });
  }
  return arr.sort((a, b) => {
    const aDir = !!a.children;
    const bDir = !!b.children;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// A section root is a top-level folder named wip / outputs / resources. It
// renders as a group heading, not a folder row: no drag, no rename, no
// hover actions (spec, "Tree").
export function isSectionRoot(node: TreeNode, depth: number): boolean {
  return depth === 0 && !node.file && SECTION_ORDER.includes(node.name);
}
