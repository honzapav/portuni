// Auto-update: invoke wrappers around the four Rust commands in
// apps/desktop/src/updater.rs, plus a `useAppUpdate()` hook that owns the
// check/download/restart state machine for the footer button and the
// Settings "Aktualizace" section.
//
// The webview never talks to tauri-plugin-updater directly -- only through
// these Tauri commands (no updater permission in capabilities/default.json).

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "./backend-url";

export type UpdateInfo = {
  version: string;
  current_version: string;
  date: string | null;
};

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UpdateInfo | null>("check_update");
}

export async function installUpdate(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("install_update");
}

export async function restartApp(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_app");
}

export async function getAppVersion(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("get_app_version");
}

export type AppUpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; pct: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type AppUpdate = {
  state: AppUpdateState;
  currentVersion: string | null;
  // Version found by the most recent successful check that found one.
  // Kept around through "downloading"/"ready" (which don't carry an
  // UpdateInfo of their own) so the UI can still show what's being
  // installed and build the "Co je nového" release-notes link.
  updateInfo: UpdateInfo | null;
  // Set after the first check (auto or manual) resolves without error, so
  // the UI can tell "never checked" apart from "checked, up to date" --
  // both are the `idle` state.
  hasChecked: boolean;
  checkNow: () => void;
  install: () => void;
  restart: () => Promise<void>;
};

const CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useAppUpdate(): AppUpdate {
  const [state, setState] = useState<AppUpdateState>({ kind: "idle" });
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [hasChecked, setHasChecked] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateInfoRef = useRef(updateInfo);
  updateInfoRef.current = updateInfo;

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void getAppVersion()
      .then((v) => {
        if (!cancelled) setCurrentVersion(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const checkNow = useCallback(() => {
    if (!isTauri()) return;
    setState({ kind: "checking" });
    void checkForUpdate()
      .then((info) => {
        setHasChecked(true);
        if (info) {
          setUpdateInfo(info);
          setState({ kind: "available", info });
        } else {
          setState({ kind: "idle" });
        }
      })
      .catch((e) => {
        setState({ kind: "error", message: errorMessage(e) });
      });
  }, []);

  // 10s after backend-ready, then every 6h. backend-ready can fire more
  // than once (multi-workspace switches emit it for the active workspace
  // each time), so a later event replaces rather than stacks the timers.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let intervalTimer: ReturnType<typeof setInterval> | null = null;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("backend-ready", () => {
        if (cancelled) return;
        if (checkTimer) clearTimeout(checkTimer);
        checkTimer = setTimeout(() => {
          checkNow();
          if (intervalTimer) clearInterval(intervalTimer);
          intervalTimer = setInterval(checkNow, CHECK_INTERVAL_MS);
        }, CHECK_DELAY_MS);
      });
    })();

    return () => {
      cancelled = true;
      if (checkTimer) clearTimeout(checkTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      unlisten?.();
    };
  }, [checkNow]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ downloaded: number; total: number | null }>(
        "update-progress",
        (e) => {
          if (cancelled) return;
          const { downloaded, total } = e.payload;
          const pct = total ? Math.round((downloaded / total) * 100) : null;
          setState({ kind: "downloading", pct });
        },
      );
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const install = useCallback(() => {
    const kind = stateRef.current.kind;
    if (kind !== "available" && kind !== "error") return;
    if (!updateInfoRef.current) return;
    setState({ kind: "downloading", pct: null });
    void installUpdate()
      .then(() => setState({ kind: "ready" }))
      .catch((e) => setState({ kind: "error", message: errorMessage(e) }));
  }, []);

  // The Cmd+Q-style dirty-editor / unsynced-files guard is wired in a
  // follow-up issue; for now this restarts unconditionally.
  const restart = useCallback(async () => {
    await restartApp();
  }, []);

  return { state, currentVersion, updateInfo, hasChecked, checkNow, install, restart };
}
