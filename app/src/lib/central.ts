// Thin wrappers for Tauri commands that talk to the central Portuni server.
//
// Security contract (mirrors api/backend-url.ts):
//   - No JWT or secret ever lives in webview JS.
//   - Every call goes through `central_request` (Rust proxy) which pulls the
//     session JWT from Keychain, attaches Authorization and retries on 401.
//   - In a plain browser (Vite dev) isTauri() is false; all functions throw or
//     return gracefully so the UI can show a "desktop only" message.

import { useEffect, useState } from "react";
import { isTauri } from "./backend-url";

export { isTauri };

// Shape returned by the get_data_mode Tauri command.
export type DataMode = {
  mode: "local" | "central";
  server_url: string | null;
};

// Invoke get_data_mode; non-Tauri environments always return local mode.
export async function getDataMode(): Promise<DataMode> {
  if (!isTauri()) return { mode: "local", server_url: null };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DataMode>("get_data_mode");
}

// Module-level cache so all callers share one fetch per app lifetime.
// Resets on HMR in dev (module reload), which is fine.
let dataModeCache: DataMode | null = null;
let dataModePending: Promise<DataMode> | null = null;

async function getDataModeCached(): Promise<DataMode> {
  if (dataModeCache) return dataModeCache;
  if (!dataModePending) {
    dataModePending = getDataMode().then((m) => {
      dataModeCache = m;
      return m;
    });
  }
  return dataModePending;
}

// Hook: resolves data mode once on mount and caches the result.
// Returns null while loading (central mode features should be optimistically
// hidden during loading to avoid flicker on initial render).
export function useDataMode(): DataMode | null {
  const [mode, setMode] = useState<DataMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getDataModeCached().then((m) => {
      if (!cancelled) setMode(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return mode;
}

// Shape returned by auth_status (JWT claims or /me fields depending on path).
export type UserInfo = {
  id?: string;
  email: string;
  name: string;
  avatar_url?: string | null;
  global_scope?: string | null;
  groups?: string[];
};

export type AuthStatus = {
  configured: boolean;
  logged_in: boolean;
  user: UserInfo | null;
};

// Device token row from GET /device-tokens.
export type DeviceToken = {
  id: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

// Response from POST /device-tokens (plaintext token shown ONCE).
export type NewDeviceToken = {
  id: string;
  token: string;
  expires_at: string | null;
};

// --- auth commands -----------------------------------------------------------

export async function authStatus(): Promise<AuthStatus> {
  if (!isTauri()) {
    return { configured: false, logged_in: false, user: null };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AuthStatus>("auth_status");
}

export async function googleLogin(): Promise<UserInfo> {
  if (!isTauri()) {
    throw new Error("Přihlášení přes Google je dostupné jen v desktop aplikaci.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<UserInfo>("google_login");
}

export async function authLogout(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("auth_logout");
}

// --- central REST ------------------------------------------------------------

type CentralResponse = { status: number; body: string };

// Calls central_request Tauri command, parses JSON body, throws on >= 400.
// `body` is passed as a JSON string (same shape as api_request).
export async function centralFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!isTauri()) {
    throw new Error("Centrální server je dostupný jen v desktop aplikaci.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const res = await invoke<CentralResponse>("central_request", {
    method: method.toUpperCase(),
    path,
    body: body ?? null,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = res.body;
  }
  if (res.status >= 400) {
    const msg =
      parsed != null &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as Record<string, unknown>).error === "string"
        ? (parsed as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}
