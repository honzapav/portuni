// Resolves "who is making this HTTP request" from the Authorization
// header. Pure function over an injected context so tests need no env
// mutation. The http middleware builds the context once per process.

import type { Client } from "@libsql/client";
import type { IdentityAdapter } from "./adapter.js";
import type { GlobalScope } from "./roles.js";
import { verifyDeviceToken } from "./device-tokens.js";
import { verifySessionToken } from "./session-token.js";

export interface RequestIdentity {
  userId: string;
  email: string;
  name: string;
  globalScope: GlobalScope;
  groups: string[];
  via: "env" | "session_jwt" | "device_token";
}

export interface IdentityContext {
  db: Client;
  mode: "env" | "google";
  jwtSecret: string;
  adapter: IdentityAdapter;
  soloUserId: string;
}

function bearerValue(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

export async function resolveRequestIdentity(
  ctx: IdentityContext,
  authorizationHeader: string | undefined,
): Promise<RequestIdentity | null> {
  if (ctx.mode === "env") {
    const identity = await ctx.adapter.verify("");
    const access = await ctx.adapter.resolveAccess(identity.email);
    return {
      userId: ctx.soloUserId,
      email: identity.email,
      name: identity.name,
      globalScope: access.globalScope,
      groups: access.groups,
      via: "env",
    };
  }

  const value = bearerValue(authorizationHeader);
  if (!value) return null;

  if (value.startsWith("ptk_")) {
    const hit = await verifyDeviceToken(ctx.db, value);
    if (!hit) return null;
    const user = await ctx.db.execute({
      sql: "SELECT email, name FROM users WHERE id = ?",
      args: [hit.userId],
    });
    if (user.rows.length === 0) return null;
    const email = String(user.rows[0].email);
    const access = await ctx.adapter.resolveAccess(email);
    return {
      userId: hit.userId,
      email,
      name: String(user.rows[0].name),
      globalScope: access.globalScope,
      groups: access.groups,
      via: "device_token",
    };
  }

  const claims = await verifySessionToken(value, ctx.jwtSecret);
  if (!claims) return null;
  return { ...claims, via: "session_jwt" };
}
