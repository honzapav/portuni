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

// Data mode lives in ./data-mode (React-free, so non-React callers like
// api.ts can import it without pulling React in). Re-exported here because
// this module is where the rest of the app already looks for it.
export { getDataMode, isCentralMode, type DataMode } from "./data-mode";
import { getDataModeCached, type DataMode } from "./data-mode";

// Hook: resolves data mode once on mount and caches the result.
// Returns null while loading (central mode features should be optimistically
// hidden during loading to avoid flicker on initial render).
export function useDataMode(): DataMode | null {
  const [mode, setMode] = useState<DataMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Rejection must not escape as an unhandled rejection (it did, live:
    // "config awaiting workspace migration"). Log and leave mode null —
    // central-mode UI stays optimistically hidden, same as while loading.
    void getDataModeCached().then(
      (m) => {
        if (!cancelled) setMode(m);
      },
      (e) => {
        console.warn("get_data_mode failed:", e);
      },
    );
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

// Connected chat-client connector from GET /auth/oauth-grants.
export type OAuthGrant = {
  id: string;
  client_id: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
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
