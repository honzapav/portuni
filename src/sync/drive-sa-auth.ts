import { createSign, type KeyObject } from "node:crypto";
import type { ServiceAccountKey } from "./drive-config.js";

const SAFETY_WINDOW_S = 120;
const cache = new Map<string, { access_token: string; expires_at: number }>();

export function resetSaTokenCacheForTests(): void { cache.clear(); }

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SignJwtArgs { iss: string; scope: string; aud: string; privateKey: string | KeyObject; sub?: string; }

export async function signJwt(a: SignJwtArgs): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const iat = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { iss: a.iss, scope: a.scope, aud: a.aud, iat, exp: iat + 3600 };
  if (a.sub) payload.sub = a.sub;
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(a.privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

let tokenFetch: (url: string, jwt: string) => Promise<{ access_token: string; expires_in: number }> = async (url, jwt) => {
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`SA token exchange: ${res.status} ${await res.text()}`);
  const b = (await res.json()) as Record<string, unknown>;
  if (typeof b.access_token !== "string") throw new Error("SA token response missing access_token");
  return { access_token: b.access_token, expires_in: Number(b.expires_in ?? 3600) };
};

export function __setTokenFetchForTests(f: typeof tokenFetch): void { tokenFetch = f; }

export async function getDriveAccessToken(sa: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(sa.client_email);
  if (hit && hit.expires_at - now > SAFETY_WINDOW_S) return hit.access_token;
  const jwt = await signJwt({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: sa.token_uri,
    privateKey: sa.private_key,
  });
  const { access_token, expires_in } = await tokenFetch(sa.token_uri, jwt);
  cache.set(sa.client_email, { access_token, expires_at: now + expires_in });
  return access_token;
}
