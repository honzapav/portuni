// Per-window, workspace-namespaced localStorage (#228, desktop multi-window
// phase 2). Every window is now permanently bound to one workspace (its
// "ws:<id>" label, #222) for its whole lifetime, so state that used to be
// "the app's" (there was only ever one window) is actually per-workspace:
// two windows must not share which nodes are open, which folders are
// collapsed in a file tree, whether the detail pane is visible, or the
// central-mode first-login guidance flag. Keys become "portuni:<ws_id>:
// <key>"; global user preferences (theme, agentCommand, terminalLaunch)
// are untouched by this file and stay unscoped.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "./backend-url";

// This window's own workspace id, from its "ws:<id>" label -- synchronous,
// no IPC round trip (getCurrentWindow() just reads metadata Tauri already
// injected into the page before any JS ran). null outside Tauri, or for
// the "bootstrap" window (no workspace exists yet).
export function currentWorkspaceId(): string | null {
  if (!isTauri()) return null;
  try {
    const label = getCurrentWindow().label;
    return label.startsWith("ws:") ? label.slice(3) : null;
  } catch {
    return null;
  }
}

export function namespacedKey(wsId: string, key: string): string {
  return `portuni:${wsId}:${key}`;
}

// Effective localStorage key for a workspace-scoped value: namespaced to
// this window's own workspace when one is known, else the same unscoped
// "portuni:<key>" shape used before #228 (a plain browser / vite-dev build
// has no workspace concept, same fallback every other Tauri-only feature
// in this codebase already uses).
export function scopedKey(key: string): string {
  const wsId = currentWorkspaceId();
  return wsId ? namespacedKey(wsId, key) : `portuni:${key}`;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// The pre-#228 unscoped key -> its namespaced key name.
const MIGRATABLE_KEYS: { old: string; key: string }[] = [
  { old: "portuni:openNodes", key: "openNodes" },
  { old: "portuni:fileTreeCollapsed", key: "fileTreeCollapsed" },
  { old: "portuni:workspace.detailVisible", key: "workspace.detailVisible" },
  { old: "portuni.first-steps-pending", key: "first-steps-pending" },
];

// One-time migration: move each unscoped key above into wsId's namespace,
// then delete the old key. Idempotent -- a key with nothing left to
// migrate (already moved by an earlier launch/window, or never set) is a
// no-op, so calling this unconditionally at every boot is safe; in
// practice it only ever does real work once, since the first
// window/launch to run it deletes the unscoped keys. Pure over a
// StorageLike so it's testable without a real localStorage.
export function migrateUnscopedStorage(storage: StorageLike, wsId: string): void {
  for (const { old, key } of MIGRATABLE_KEYS) {
    const value = storage.getItem(old);
    if (value === null) continue;
    const newKey = namespacedKey(wsId, key);
    // Never clobber a value the new key might already have -- e.g. two
    // windows racing this on first launch after the upgrade. First one to
    // move it wins, matching "moves into the namespace... at first
    // launch" (singular).
    if (storage.getItem(newKey) === null) {
      storage.setItem(newKey, value);
    }
    storage.removeItem(old);
  }
}

// Runs the migration once for this window's own resolved workspace id.
// A no-op outside Tauri or before a workspace exists (the "bootstrap"
// window -- nothing to migrate into yet; the first real ws:<id> window
// picks it up instead). Called once at boot, before anything reads a
// workspace-scoped key (main.tsx, ahead of the React render).
export function migrateUnscopedStorageForCurrentWindow(): void {
  if (typeof window === "undefined") return;
  const wsId = currentWorkspaceId();
  if (!wsId) return;
  migrateUnscopedStorage(window.localStorage, wsId);
}
