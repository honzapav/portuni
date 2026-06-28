// Short-lived Portuni session JWT, issued by POST /auth/login after the
// IdentityAdapter verified the IdP credential. HS256 with a server-side
// secret (PORTUNI_JWT_SECRET) — only this server signs and verifies.
// Groups/scope are baked in; the 1h TTL bounds membership staleness
// alongside the 15-min adapter cache.

import { SignJWT, jwtVerify } from "jose";
import { GLOBAL_SCOPES, type GlobalScope } from "./roles.js";

export interface SessionClaims {
  userId: string;
  email: string;
  name: string;
  globalScope: GlobalScope;
  groups: string[];
}

const DEFAULT_TTL_SECONDS = 60 * 60;

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(
  claims: SessionClaims,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: claims.email,
    name: claims.name,
    scope: claims.globalScope,
    groups: claims.groups,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer("portuni")
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key(secret));
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: "portuni",
      algorithms: ["HS256"],
    });
    const scope = payload.scope as string;
    if (!(GLOBAL_SCOPES as readonly string[]).includes(scope)) return null;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      return null;
    }
    return {
      userId: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : "",
      globalScope: scope as GlobalScope,
      groups: Array.isArray(payload.groups)
        ? payload.groups.filter((g): g is string => typeof g === "string")
        : [],
    };
  } catch {
    return null;
  }
}
