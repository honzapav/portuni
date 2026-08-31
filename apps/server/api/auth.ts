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
import { upsertUserFromIdentity, listUsers, listUsersAdmin, inviteUser, UserExistsError } from "../auth/users.js";
import { signSessionToken } from "../auth/session-token.js";
import {
  listDeviceTokens,
  mintDeviceToken,
  revokeDeviceToken,
} from "../auth/device-tokens.js";
import { listGrantsForUser, revokeGrant } from "../auth/oauth/grants.js";
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
        groupIds: access.groupIds,
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

// GET /auth/oauth-grants: connected chat-client connectors (Settings ->
// "Připojené aplikace"), owner-scoped -- same shape/scope tier as device
// tokens, minus the plaintext-token concern since a grant's tokens never
// round-trip through this list.
export async function handleListOAuthGrants(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    respondJson(res, 200, await listGrantsForUser(getDb(), identity.userId));
  } catch (err) {
    respondError(res, "GET /auth/oauth-grants", err);
  }
}

// DELETE /auth/oauth-grants/:id (owner only): revokes access and refresh
// immediately -- the connector must re-consent to reconnect.
export async function handleRevokeOAuthGrant(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  grantId: string,
): Promise<void> {
  try {
    const ok = await revokeGrant(getDb(), identity.userId, grantId);
    if (!ok) {
      respondJson(res, 404, { error: "Grant not found" });
      return;
    }
    await logAudit(identity.userId, "revoke_oauth_grant", "oauth_grant", grantId, {});
    respondJson(res, 200, { revoked: true });
  } catch (err) {
    respondError(res, "DELETE /auth/oauth-grants/:id", err);
  }
}

// GET /auth/users (manage): ACL picker source -- id/name/email/avatar_url only.
export async function handleListAccountUsers(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const users = await listUsers(getDb());
    respondJson(res, 200, { users });
  } catch (err) {
    respondError(res, "GET /auth/users", err);
  }
}

// GET /auth/users/admin (admin): full account list with invited flag and
// each user's resolved global_scope (via the identity adapter).
export async function handleListUsersAdmin(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const db = getDb();
    const rows = await listUsersAdmin(db);
    const adapter = getIdentityContext().adapter;
    // Resolve each row independently -- one unresolvable email (invited
    // external/typo address the directory can't look up in google mode)
    // must not 500 the whole admin tab. Promise.all would reject on the
    // first rejection; Promise.allSettled keeps the others intact and we
    // fall back to global_scope: null for the failed row.
    const accessResolutions = await Promise.allSettled(
      rows.map((row) => adapter.resolveAccess(row.email)),
    );
    const users = rows.map((row, i) => {
      const resolution = accessResolutions[i];
      return {
        ...row,
        global_scope: resolution.status === "fulfilled" ? resolution.value.globalScope : null,
      };
    });
    respondJson(res, 200, { users });
  } catch (err) {
    respondError(res, "GET /auth/users/admin", err);
  }
}

const InviteUserBody = z.object({ email: z.string().email() });

// POST /auth/users/invite (admin): creates a placeholder user row so it can
// be granted access before the invitee's first login.
export async function handleInviteUser(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const body = await parseJsonBody(req, res, InviteUserBody);
    if (!body) return;
    const invited = await inviteUser(getDb(), body.email);
    await logAudit(identity.userId, "user.invite", "user", invited.id, { email: invited.email });
    respondJson(res, 201, invited);
  } catch (err) {
    if (err instanceof UserExistsError) {
      respondJson(res, 409, { error: err.message });
      return;
    }
    respondError(res, "POST /auth/users/invite", err);
  }
}

// Public desktop OAuth client config. The onboarding wizard fetches this
// from just a server URL so a teammate never types client id/secret by
// hand. A Google *desktop app* OAuth client's secret is non-confidential
// by Google's own definition (it ships inside every installed app), so
// serving it unauthenticated is deliberate. Env is read per request so
// tests (and ops) can flip it without a restart.
export function handleDesktopConfig(res: ServerResponse): void {
  const id = (process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_ID ?? "").trim();
  const secret = (process.env.PORTUNI_DESKTOP_GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!id || !secret) {
    respondJson(res, 404, { error: "desktop config not available" });
    return;
  }
  respondJson(res, 200, { google_client_id: id, google_client_secret: secret });
}
