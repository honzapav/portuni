// Auto-update: invoke wrappers around the four Rust commands in
// apps/desktop/src/updater.rs, plus a `useAppUpdate()` hook that owns the
// check/download/restart state machine for the footer button and the
// Settings "Aktualizace" section.
//
// The webview never talks to tauri-plugin-updater directly, only through
// these Tauri commands (no updater permission in capabilities/default.json).

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "./backend-url";
import { createUpdateScheduler, shouldCheckOnFocus, windowTimerDeps } from "./update-schedule";

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
  // the UI can tell "never checked" apart from "checked, up to date";
  // both are the `idle` state.
  hasChecked: boolean;
  // When the most recent check attempt (success OR error) completed, so a
  // silently-broken schedule is visible in Settings instead of invisible
  // (#274) -- set on every completed attempt, not just successful ones.
  lastCheckedAt: Date | null;
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
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateInfoRef = useRef(updateInfo);
  updateInfoRef.current = updateInfo;
  // Epoch ms, readable synchronously by the focus handler -- lastCheckedAt
  // (state) would only reflect the value as of the last render.
  const lastCheckedAtMsRef = useRef<number | null>(null);

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

  // No check while a download runs or an installed update awaits restart:
  // the running binary is still the old version, so a check would find the
  // same release again and turn "ready" back into "available".
  const checkNow = useCallback(() => {
    if (!isTauri()) return;
    const kind = stateRef.current.kind;
    if (kind === "downloading" || kind === "ready") return;
    setState({ kind: "checking" });
    void checkForUpdate()
      .then((info) => {
        setHasChecked(true);
        lastCheckedAtMsRef.current = Date.now();
        setLastCheckedAt(new Date(lastCheckedAtMsRef.current));
        if (info) {
          setUpdateInfo(info);
          setState({ kind: "available", info });
        } else {
          setState({ kind: "idle" });
        }
      })
      .catch((e) => {
        // Still record the attempt: an error you can SEE (Settings ->
        // Aktualizace's "naposledy zkontrolováno") is diagnosable; a check
        // that silently never ran again looks identical to one that ran
        // and found nothing (#274).
        lastCheckedAtMsRef.current = Date.now();
        setLastCheckedAt(new Date(lastCheckedAtMsRef.current));
        setState({ kind: "error", message: errorMessage(e) });
      });
  }, []);

  // First check ~10s after this hook mounts, then every 6h -- the check has
  // no dependency on the sidecar at all (it only talks to GitHub), so it
  // does not need to wait for one. backend-ready is kept as an ADDITIONAL
  // trigger that resets (never stacks) the schedule: it is per-window
  // (emit_to("ws:<id>", ...)) and can fire more than once for this window
  // (a sidecar restart, or the replay a just-created/restored window gets),
  // and historically it was the ONLY trigger -- which meant a webview whose
  // listener attached after the event had already fired (routine: the event
  // can arrive within a few hundred ms of window creation, well before
  // React has mounted and awaited its dynamic event-module import) never
  // saw it and never scheduled anything at all (#274). A window focus after
  // sitting idle past a full interval (the OS was asleep, or this window
  // was backgrounded through several missed intervals) also triggers an
  // immediate check, same reasoning pollBackendReady's event+poll race
  // guards against for backend readiness.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlistenReady: (() => void) | null = null;
    const scheduler = createUpdateScheduler({
      // windowTimerDeps, not the `{ setTimeout, clearTimeout, ... }`
      // shorthand: the latter makes the scheduler call them with the deps
      // object as `this`, which WKWebView refuses outright.
      ...windowTimerDeps(window),
      checkDelayMs: CHECK_DELAY_MS,
      checkIntervalMs: CHECK_INTERVAL_MS,
    });

    scheduler.schedule(checkNow);

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenReady = await listen("backend-ready", () => {
        if (cancelled) return;
        scheduler.schedule(checkNow);
      });
    })();

    const onFocus = () => {
      if (cancelled) return;
      if (shouldCheckOnFocus(lastCheckedAtMsRef.current, Date.now(), CHECK_INTERVAL_MS)) {
        checkNow();
      }
    };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      scheduler.stop();
      unlistenReady?.();
      window.removeEventListener("focus", onFocus);
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

  // restart_app goes through the same sequential-close quit Cmd+Q uses
  // (#229): every open window gets its own dirty-editor/unsynced-files/
  // running-terminals guard chance before anything closes. A decline in
  // any of them aborts the whole restart -- the update stays installed and
  // this state remains "ready" for a later retry.
  const restart = useCallback(async () => {
    await restartApp();
  }, []);

  return { state, currentVersion, updateInfo, hasChecked, lastCheckedAt, checkNow, install, restart };
}
