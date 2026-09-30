// Which remote/sync surfaces the web shows, by workspace (#575).
//
// A personal workspace (data mode "local") has no remote at all (#310), so
// everything about syncing is hidden there, never merely disabled: the
// footer's unsynced / to-pull pills, the quit guard, the /sync/pending poll,
// Overview's Unsynced counter and the Attention card's sync issues, the
// Unsynced dialog, Settings -> Synchronization, and in the Files tab the
// sync status badges, folder/section/tab sync dots, "Copy Drive link" and
// the conflict / restore actions. What stays are the facts about this disk:
// a file on disk with no record ("untracked") and a record whose file is
// gone ("missing", sync class deleted_local).
//
// While the mode is still unknown (null) every sync surface stays hidden,
// the same optimistic default every other data-mode-gated surface uses; a
// team workspace shows them as soon as the (cached, one-shot) mode lookup
// resolves.
//
// React-free: imported by the root node:test runner.

import type { DataMode } from "./data-mode";
import type { SyncClass } from "../types";

export type DataModeKind = DataMode["mode"] | null | undefined;

// True only once the workspace is known to be a team workspace.
export function showsSyncSurfaces(mode: DataModeKind): boolean {
  return mode === "central";
}

// The personal-workspace hint in the Files tab: only once the workspace is
// known to be personal, never while loading.
export function showsPersonalWorkspaceBanner(mode: DataModeKind): boolean {
  return mode === "local";
}

export type FileRowBadges = {
  // "unregistered": on disk, no record. Shown in both workspaces.
  untracked: boolean;
  // "missing": the record's file is gone from disk (deleted_local). Personal
  // workspace only; a team workspace shows it through the sync badge.
  missing: boolean;
  // The full sync status badge (synced / push / pull / conflict / ...).
  // Team workspace only.
  syncStatus: boolean;
};

// Which badges a file row carries. `tracked` is whether the file has a
// record; `syncClass` its sync class when the status scan has one.
export function fileRowBadges(
  mode: DataModeKind,
  tracked: boolean,
  syncClass: SyncClass | null | undefined,
): FileRowBadges {
  if (showsSyncSurfaces(mode)) {
    return { untracked: !tracked, missing: false, syncStatus: tracked && !!syncClass };
  }
  return {
    untracked: !tracked,
    missing: tracked && syncClass === "deleted_local",
    syncStatus: false,
  };
}
