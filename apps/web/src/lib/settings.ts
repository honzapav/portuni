// User settings persisted in localStorage: the Showtime integration flag,
// the workspace's open-node set, the file tree's collapsed folders and the
// Files tab's move plan.

import { scopedKey } from "./workspace-storage";
import { planIsEmpty, type FilePlan } from "./file-plan";

// Showtime integration (Settings -> Integrace). Off by default: with it on, a
// `.showtime` deck opens in the rendered preview (the preview.html Showtime
// packs into the bundle) and the preview offers "Otevřít v Showtime" when
// the app is installed. Off, the bundle is a binary file like any other.
const SHOWTIME_KEY = "portuni:showtime";

export function loadShowtimeEnabled(): boolean {
  try {
    return window.localStorage.getItem(SHOWTIME_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowtimeEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(SHOWTIME_KEY, "1");
    else window.localStorage.removeItem(SHOWTIME_KEY);
  } catch {
    // localStorage unavailable -- the flag stays off for this session.
  }
}

// --- Open workspace nodes --------------------------------------------------
//
// The set of nodes the user has open in the Práce view, persisted so the
// working set survives an app restart. Stored as a JSON array of node ids; ids
// that no longer exist are pruned against the graph on load (in App).
// Workspace-scoped (#228): two windows must not share which nodes are open.
const OPEN_NODES_KEY = "openNodes";

export function loadOpenNodes(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(scopedKey(OPEN_NODES_KEY));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function saveOpenNodes(ids: readonly string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(scopedKey(OPEN_NODES_KEY), JSON.stringify(ids));
}

// --- File tree collapsed folders --------------------------------------------
//
// Which folders the user collapsed in a node's file tree, per node, so the
// tree doesn't reset to fully expanded every time the node detail remounts
// (switching node, switching tab and back, app restart). Stored as
// { [nodeId]: string[] } (TreeNode.path values); a node's entry is removed
// once its collapsed set is empty. Workspace-scoped (#228).
const COLLAPSED_FOLDERS_KEY = "fileTreeCollapsed";

export function loadCollapsedFolders(nodeId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(scopedKey(COLLAPSED_FOLDERS_KEY));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    const paths = parsed[nodeId];
    if (!Array.isArray(paths)) return new Set();
    return new Set(paths.filter((p): p is string => typeof p === "string"));
  } catch {
    return new Set();
  }
}

export function saveCollapsedFolders(nodeId: string, paths: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    const key = scopedKey(COLLAPSED_FOLDERS_KEY);
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    const all = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    if (paths.size === 0) {
      delete all[nodeId];
    } else {
      all[nodeId] = Array.from(paths);
    }
    window.localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // localStorage unavailable/full — collapsed state stays in-memory only.
  }
}

// --- File tab move plan -----------------------------------------------------
//
// The Files tab's plan (#445): dragging, "Nová složka" and folder renames edit
// it and nothing else until "Použít". It belongs to the node on this device
// and is never sent anywhere (rule 8 of the spec), so it lives beside the
// collapsed folders: { [nodeId]: FilePlan }, workspace-scoped, a node's entry
// removed once its plan is empty.
const FILE_PLAN_KEY = "fileTreePlan";

function parseFilePlan(value: unknown): FilePlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { moves?: unknown; folders?: unknown };
  const moves: FilePlan["moves"] = {};
  if (raw.moves && typeof raw.moves === "object" && !Array.isArray(raw.moves)) {
    for (const [fileId, target] of Object.entries(raw.moves as Record<string, unknown>)) {
      if (!target || typeof target !== "object") continue;
      const t = target as { section?: unknown; subpath?: unknown };
      if (t.section !== "wip" && t.section !== "outputs" && t.section !== "resources") continue;
      const subpath = typeof t.subpath === "string" ? t.subpath : null;
      moves[fileId] = { section: t.section, subpath };
    }
  }
  const folders = Array.isArray(raw.folders)
    ? raw.folders.filter((p): p is string => typeof p === "string")
    : [];
  return { moves, folders };
}

export function loadFilePlan(nodeId: string): FilePlan {
  const empty: FilePlan = { moves: {}, folders: [] };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(scopedKey(FILE_PLAN_KEY));
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
    return parseFilePlan((parsed as Record<string, unknown>)[nodeId]) ?? empty;
  } catch {
    return empty;
  }
}

export function saveFilePlan(nodeId: string, plan: FilePlan): void {
  if (typeof window === "undefined") return;
  try {
    const key = scopedKey(FILE_PLAN_KEY);
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    const all = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    if (planIsEmpty(plan)) {
      delete all[nodeId];
    } else {
      all[nodeId] = plan;
    }
    if (Object.keys(all).length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // localStorage unavailable/full — the plan stays in-memory only.
  }
}
