// Client bindings for Nastaveni -> Synchronizace (Google Drive connect).
//
// REST calls go through apiFetch (bearer-authed, proxied through Tauri
// api_request in desktop mode -- see backend-url.ts). The two Tauri
// commands (google_drive_connect, google_client_configured) are invoked
// directly and guarded by isTauri() -- outside Tauri there is no OAuth
// loopback listener and no config.json to read, so they degrade to a
// thrown error / false rather than crashing.

import { apiFetch, isTauri } from "./backend-url";

export type DriveTarget = { id: string; name: string };

export type DriveStatus = {
  configured: boolean;
  connected: boolean;
  account_email: string | null;
  target: { kind: "my_drive" | "shared_drive"; name: string } | null;
};

export type TestDriveResult = { ok: boolean; code?: string };

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Mirrors api.ts's throwForStatus: the backend returns {error: "..."} bodies
// (e.g. "target requires exactly one of shared_drive_id | my_drive") that
// are worth surfacing verbatim instead of just the bare status code.
async function throwForStatus(res: Response, label: string): Promise<never> {
  let detail = "";
  try {
    const body = (await res.clone().json()) as { error?: string };
    if (body?.error) detail = body.error;
  } catch {
    /* body not JSON -- fall through */
  }
  if (!detail) detail = await res.text().catch(() => "");
  throw new Error(detail ? `${label}: ${res.status} ${detail}` : `${label}: ${res.status}`);
}

export async function fetchDriveStatus(): Promise<DriveStatus> {
  const res = await apiFetch("/sync/drive/status");
  if (!res.ok) await throwForStatus(res, "GET /sync/drive/status failed");
  return readJson<DriveStatus>(res);
}

// 409 { error: "not_connected" } is not an error for this call site -- it
// just means there is nothing to list yet. Map it to an empty list so
// callers don't need to special-case it.
export async function fetchDriveTargets(): Promise<DriveTarget[]> {
  const res = await apiFetch("/sync/drive/targets");
  if (res.status === 409) return [];
  if (!res.ok) await throwForStatus(res, "GET /sync/drive/targets failed");
  const body = await readJson<{ shared_drives: DriveTarget[] }>(res);
  return body.shared_drives;
}

export async function setDriveTarget(
  sel: { shared_drive_id: string } | { my_drive: true },
): Promise<void> {
  const res = await apiFetch("/sync/drive/target", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sel),
  });
  if (!res.ok) await throwForStatus(res, "POST /sync/drive/target failed");
}

export async function testDrive(): Promise<TestDriveResult> {
  const res = await apiFetch("/sync/drive/test", { method: "POST" });
  if (!res.ok) await throwForStatus(res, "POST /sync/drive/test failed");
  return readJson<TestDriveResult>(res);
}

export async function disconnectDrive(): Promise<void> {
  const res = await apiFetch("/sync/drive/disconnect", { method: "POST" });
  if (!res.ok) await throwForStatus(res, "POST /sync/drive/disconnect failed");
}

// Runs the PKCE + loopback OAuth flow in Rust and POSTs the refresh token
// straight to the sidecar (webview never sees it -- security rule 1).
// Returns the shared drives from the same round trip so the caller can
// populate the target select without an extra fetchDriveTargets() call.
export async function connectDrive(): Promise<{
  account_email: string;
  shared_drives: DriveTarget[];
}> {
  if (!isTauri()) {
    throw new Error("Propojení Google Drive je dostupné jen v desktop aplikaci.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ account_email: string; shared_drives: DriveTarget[] }>(
    "google_drive_connect",
  );
}

// Whether google_client_id/google_client_secret are set in config.json for
// the active workspace. false outside Tauri (no config.json to read) and
// on invoke failure.
export async function googleClientConfigured(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("google_client_configured");
  } catch {
    return false;
  }
}

// --- Once-per-session status cache -------------------------------------------
//
// Task 8 (node-detail "files are local only" banner) reuses this so every
// consumer on the page shares one GET /sync/drive/status per session
// instead of firing it once per mounted component.

let statusPromise: Promise<DriveStatus> | null = null;

export function invalidateSyncStatusCache(): void {
  statusPromise = null;
}

export function getCachedDriveStatus(): Promise<DriveStatus | null> {
  if (!statusPromise) {
    statusPromise = fetchDriveStatus().catch((e) => {
      statusPromise = null;
      throw e;
    });
  }
  return statusPromise.catch(() => null);
}
