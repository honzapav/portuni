// Auth/identity REST endpoints: login (google mode), /me, device tokens.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import {
  getIdentityContext,
  parseJsonBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import { GoogleAdapter } from "../auth/google-adapter.js";
import { upsertUserFromIdentity } from "../auth/users.js";
import { signSessionToken } from "../auth/session-token.js";
import {
  listDeviceTokens,
  mintDeviceToken,
  revokeDeviceToken,
} from "../auth/device-tokens.js";
import { logAudit } from "../infra/audit.js";

const LoginBody = z.object({ id_token: z.string().min(1) });

export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const ctx = getIdentityContext();
  if (ctx.mode !== "google") {
    respondJson(res, 404, { error: "Login is not available in env auth mode" });
    return;
  }
  try {
    const body = await parseJsonBody(req, res, LoginBody);
    if (!body) return;
    let identity: Awaited<ReturnType<typeof ctx.adapter.verify>>;
    let avatarUrl: string | null = null;
    if (ctx.adapter instanceof GoogleAdapter) {
      const r = await ctx.adapter.verifyWithProfile(body.id_token);
      identity = r.identity;
      avatarUrl = r.avatarUrl;
    } else {
      identity = await ctx.adapter.verify(body.id_token);
    }
    const userId = await upsertUserFromIdentity(getDb(), identity, avatarUrl);
    const access = await ctx.adapter.resolveAccess(identity.email);
    const token = await signSessionToken(
      {
        userId,
        email: identity.email,
        name: identity.name,
        globalScope: access.globalScope,
        groups: access.groups,
      },
      ctx.jwtSecret,
    );
    await logAudit(userId, "login", "user", userId, { via: "google" });
    respondJson(res, 200, {
      token,
      user: {
        id: userId,
        email: identity.email,
        name: identity.name,
        avatar_url: avatarUrl,
        global_scope: access.globalScope,
        groups: access.groups,
      },
    });
  } catch (err) {
    respondJson(res, 401, {
      error: err instanceof Error ? err.message : "Login failed",
    });
  }
}

export async function handleMe(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  respondJson(res, 200, {
    id: identity.userId,
    email: identity.email,
    name: identity.name,
    global_scope: identity.globalScope,
    groups: identity.groups,
    via: identity.via,
  });
}

const MintBody = z.object({ label: z.string().min(1).max(200) });

export async function handleMintDeviceToken(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const body = await parseJsonBody(req, res, MintBody);
    if (!body) return;
    const minted = await mintDeviceToken(getDb(), identity.userId, body.label);
    await logAudit(identity.userId, "mint_device_token", "device_token", minted.id, {
      label: body.label,
    });
    respondJson(res, 201, minted);
  } catch (err) {
    respondError(res, "POST /device-tokens", err);
  }
}

export async function handleListDeviceTokens(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    respondJson(res, 200, await listDeviceTokens(getDb(), identity.userId));
  } catch (err) {
    respondError(res, "GET /device-tokens", err);
  }
}

export async function handleRevokeDeviceToken(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  tokenId: string,
): Promise<void> {
  try {
    const ok = await revokeDeviceToken(getDb(), identity.userId, tokenId);
    if (!ok) {
      respondJson(res, 404, { error: "Token not found" });
      return;
    }
    await logAudit(identity.userId, "revoke_device_token", "device_token", tokenId, {});
    respondJson(res, 200, { revoked: true });
  } catch (err) {
    respondError(res, "DELETE /device-tokens/:id", err);
  }
}
