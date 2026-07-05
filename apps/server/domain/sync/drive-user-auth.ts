// User-OAuth counterpart of drive-sa-auth: exchanges a stored Google
// refresh token for a short-lived access token. Endpoint is hardcoded to
// Google's OAuth server -- the refresh token grant must never be POSTed
// anywhere else (same reasoning as assertSafeTokenUri for SA).
import type { DeviceToken } from "./types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SAFETY_WINDOW_S = 120;
const cache = new Map<string, { access_token: string; expires_at: number }>();

export function resetUserTokenCacheForTests(): void { cache.clear(); }

export class DriveAuthError extends Error {
  readonly code = "TOKEN_INVALID";
  constructor(message: string) { super(message); this.name = "DriveAuthError"; }
}

type TokenFetch = (params: URLSearchParams) => Promise<{ access_token: string; expires_in: number }>;

let tokenFetch: TokenFetch = async (params) => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    if (text.includes("invalid_grant")) throw new DriveAuthError(`Google refresh rejected: ${text}`);
    throw new Error(`Google token endpoint: ${res.status} ${text}`);
  }
  const b = JSON.parse(text) as Record<string, unknown>;
  if (typeof b.access_token !== "string") throw new Error("token response missing access_token");
  return { access_token: b.access_token, expires_in: Number(b.expires_in ?? 3600) };
};

export function __setUserTokenFetchForTests(f: TokenFetch): void { tokenFetch = f; }

export async function getUserAccessToken(t: DeviceToken): Promise<string> {
  if (!t.refresh_token || !t.client_id || !t.client_secret) {
    throw new Error("refresh_token mode requires refresh_token, client_id and client_secret");
  }
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(t.refresh_token);
  if (hit && hit.expires_at - now > SAFETY_WINDOW_S) return hit.access_token;
  const { access_token, expires_in } = await tokenFetch(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: t.client_id,
    client_secret: t.client_secret,
  }));
  cache.set(t.refresh_token, { access_token, expires_at: now + expires_in });
  return access_token;
}
