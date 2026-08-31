// OAuth 2.1 connector routes: discovery, authorize, upstream callback,
// consent, token. Mounted directly in http/server.ts *before* the shared
// gates (host/origin/bearer) -- these routes have no bearer token to
// present yet, they are how a client obtains one. Every route 404s unless
// auth mode is "google", the adapter implements interactiveLogin, and
// PORTUNI_PUBLIC_URL is configured -- see isOAuthEnabled().
// Spec: docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Endpoints", "Authorization flow").

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDb } from "../infra/db.js";
import { getIdentityContext } from "../http/middleware.js";
import type { IdentityContext } from "../auth/request-identity.js";
import type { Identity } from "../auth/adapter.js";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from "../auth/oauth/discovery.js";
import { fetchClientMetadata, redirectUriAllowed } from "../auth/oauth/cimd.js";
import { signFlowState, verifyFlowState, type AuthorizeRequest } from "../auth/oauth/flow.js";
import { mintAuthorizationCode, redeemAuthorizationCode, attachGrantToCode } from "../auth/oauth/codes.js";
import { mintGrant, rotateRefreshToken } from "../auth/oauth/grants.js";
import { canonicalIssuer, isOAuthEnabled } from "../auth/oauth/enabled.js";
import { upsertUserFromIdentity } from "../auth/users.js";
import { logAudit } from "../infra/audit.js";
import { renderConsentPage, renderOAuthErrorPage } from "../auth/oauth/consent-page.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // matches grants.ts ACCESS_TTL_MS

function respondNotFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

function respondHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function respondErrorPage(res: ServerResponse, status: number, message: string): void {
  respondHtml(res, status, renderOAuthErrorPage(message));
}

function respondJsonNoStore(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
  res.end(JSON.stringify(body));
}

function respondOAuthTokenError(
  res: ServerResponse,
  status: number,
  error: "invalid_request" | "invalid_grant" | "unsupported_grant_type",
): void {
  respondJsonNoStore(res, status, { error });
}

function redirectTo(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

function isLoopbackRedirect(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function parseFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const raw = await readBody(req);
  return new URLSearchParams(raw);
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

async function handleDiscoveryProtectedResource(res: ServerResponse, ctx: IdentityContext): Promise<void> {
  if (!isOAuthEnabled(ctx)) return respondNotFound(res);
  respondJsonNoStore(res, 200, buildProtectedResourceMetadata(canonicalIssuer()));
}

async function handleDiscoveryAuthorizationServer(res: ServerResponse, ctx: IdentityContext): Promise<void> {
  if (!isOAuthEnabled(ctx)) return respondNotFound(res);
  respondJsonNoStore(res, 200, buildAuthorizationServerMetadata(canonicalIssuer()));
}

async function handleAuthorize(url: URL, res: ServerResponse, ctx: IdentityContext): Promise<void> {
  if (!isOAuthEnabled(ctx)) return respondNotFound(res);

  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const codeChallenge = q.get("code_challenge") ?? "";
  const codeChallengeMethod = q.get("code_challenge_method") ?? "";
  const state = q.get("state") ?? "";
  const resource = q.get("resource") ?? "";
  const scope = q.get("scope") ?? "";

  if (!clientId || !redirectUri || !codeChallenge || !state || !resource) {
    respondErrorPage(res, 400, "Chybí povinný parametr požadavku o autorizaci.");
    return;
  }
  if (codeChallengeMethod !== "S256") {
    respondErrorPage(res, 400, "Podporována je pouze metoda PKCE S256.");
    return;
  }

  const cimd = await fetchClientMetadata(clientId);
  if (!cimd.ok) {
    respondErrorPage(res, 400, `Nepodařilo se ověřit klienta: ${cimd.reason}`);
    return;
  }
  if (!redirectUriAllowed(cimd.doc.redirect_uris, redirectUri)) {
    respondErrorPage(res, 400, "Návratová adresa (redirect_uri) není u tohoto klienta registrována.");
    return;
  }
  if (resource !== `${canonicalIssuer()}/mcp`) {
    respondErrorPage(res, 400, "Neplatný cílový zdroj (resource).");
    return;
  }

  const request: AuthorizeRequest = {
    clientId,
    redirectUri,
    codeChallenge,
    state,
    resource,
    scope,
  };
  const flowToken = await signFlowState({ request }, ctx.jwtSecret);
  // isOAuthEnabled() already checked interactiveLogin is present.
  redirectTo(res, ctx.adapter.interactiveLogin!.redirectUrl(flowToken));
}

async function handleGoogleCallback(url: URL, res: ServerResponse, ctx: IdentityContext): Promise<void> {
  if (!isOAuthEnabled(ctx)) return respondNotFound(res);

  const stateToken = url.searchParams.get("state") ?? "";
  const flow = await verifyFlowState(stateToken, ctx.jwtSecret);
  if (!flow) {
    respondErrorPage(res, 400, "Přihlašovací relace vypršela nebo je neplatná. Zkuste to prosím znovu.");
    return;
  }

  let handled: { identity: Identity; avatarUrl: string | null };
  try {
    handled = await ctx.adapter.interactiveLogin!.handleCallback(url.searchParams);
  } catch (err) {
    respondErrorPage(res, 400, err instanceof Error ? err.message : "Přihlášení přes Google se nezdařilo.");
    return;
  }

  const cimd = await fetchClientMetadata(flow.request.clientId);
  if (!cimd.ok) {
    respondErrorPage(res, 400, `Nepodařilo se ověřit klienta: ${cimd.reason}`);
    return;
  }

  const userId = await upsertUserFromIdentity(getDb(), handled.identity, handled.avatarUrl);
  const continuationToken = await signFlowState(
    {
      request: flow.request,
      identity: {
        userId,
        email: handled.identity.email,
        name: handled.identity.name,
        avatarUrl: handled.avatarUrl,
      },
    },
    ctx.jwtSecret,
  );

  respondHtml(
    res,
    200,
    renderConsentPage({
      email: handled.identity.email,
      name: handled.identity.name,
      avatarUrl: handled.avatarUrl,
      clientName: cimd.doc.client_name ?? new URL(flow.request.clientId).hostname,
      clientId: flow.request.clientId,
      redirectUri: flow.request.redirectUri,
      isLoopback: isLoopbackRedirect(flow.request.redirectUri),
      continuationToken,
    }),
  );
}

async function handleConsent(req: IncomingMessage, res: ServerResponse, ctx: IdentityContext): Promise<void> {
  if (!isOAuthEnabled(ctx)) return respondNotFound(res);

  const form = await parseFormBody(req);
  const token = form.get("token") ?? "";
  const decision = form.get("decision") ?? "";

  const flow = await verifyFlowState(token, ctx.jwtSecret);
  if (!flow?.identity) {
    respondErrorPage(res, 400, "Přihlašovací relace vypršela nebo je neplatná. Zkuste to prosím znovu.");
    return;
  }

  const { request, identity } = flow;
  if (decision !== "allow") {
    redirectTo(res, `${request.redirectUri}?error=access_denied&state=${encodeURIComponent(request.state)}`);
    return;
  }

  const cimd = await fetchClientMetadata(request.clientId);
  const clientName = cimd.ok ? (cimd.doc.client_name ?? new URL(request.clientId).hostname) : request.clientId;

  const minted = await mintAuthorizationCode(getDb(), {
    userId: identity.userId,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    resource: request.resource,
    scope: request.scope,
  });
  await logAudit(identity.userId, "oauth.consent_allow", "oauth_code", minted.codeId, {
    client_id: request.clientId,
    client_name: clientName,
  });

  redirectTo(
    res,
    `${request.redirectUri}?code=${encodeURIComponent(minted.code)}&state=${encodeURIComponent(request.state)}`,
  );
}

async function handleToken(req: IncomingMessage, res: ServerResponse, ctx: IdentityContext): Promise<void> {
  if (!isOAuthEnabled(ctx)) return respondNotFound(res);

  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toString().includes("application/x-www-form-urlencoded")) {
    respondOAuthTokenError(res, 400, "invalid_request");
    return;
  }
  const form = await parseFormBody(req);
  const grantType = form.get("grant_type") ?? "";
  const db = getDb();

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const clientId = form.get("client_id") ?? "";
    const codeVerifier = form.get("code_verifier") ?? "";
    if (!code || !redirectUri || !clientId || !codeVerifier) {
      respondOAuthTokenError(res, 400, "invalid_request");
      return;
    }

    const redeemed = await redeemAuthorizationCode(db, code);
    if (!redeemed.ok) {
      respondOAuthTokenError(res, 400, "invalid_grant");
      return;
    }
    const { code: redeemedCode } = redeemed;
    if (redeemedCode.clientId !== clientId || redeemedCode.redirectUri !== redirectUri) {
      respondOAuthTokenError(res, 400, "invalid_grant");
      return;
    }
    if (!pkceMatches(codeVerifier, redeemedCode.codeChallenge)) {
      respondOAuthTokenError(res, 400, "invalid_grant");
      return;
    }

    const cimd = await fetchClientMetadata(redeemedCode.clientId);
    const clientName = cimd.ok
      ? (cimd.doc.client_name ?? new URL(redeemedCode.clientId).hostname)
      : redeemedCode.clientId;

    const grant = await mintGrant(db, {
      userId: redeemedCode.userId,
      clientId: redeemedCode.clientId,
      clientName,
      resource: redeemedCode.resource,
      scope: redeemedCode.scope,
    });
    await attachGrantToCode(db, redeemedCode.codeId, grant.grantId);
    await logAudit(redeemedCode.userId, "oauth.token_issue", "oauth_grant", grant.grantId, {
      client_id: redeemedCode.clientId,
    });

    respondJsonNoStore(res, 200, {
      access_token: grant.accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: grant.refreshToken,
      scope: redeemedCode.scope,
    });
    return;
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    if (!refreshToken) {
      respondOAuthTokenError(res, 400, "invalid_request");
      return;
    }
    const rotated = await rotateRefreshToken(db, refreshToken);
    if (!rotated.ok) {
      respondOAuthTokenError(res, 400, "invalid_grant");
      return;
    }
    await logAudit(rotated.grant.userId, "oauth.token_refresh", "oauth_grant", rotated.grant.grantId, {});
    respondJsonNoStore(res, 200, {
      access_token: rotated.grant.accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: rotated.grant.refreshToken,
      scope: rotated.grant.scope,
    });
    return;
  }

  respondOAuthTokenError(res, 400, "unsupported_grant_type");
}

// Dispatches an OAuth connector route. Returns false when the path/method
// don't match any route here so the caller falls through to the normal
// gated request handling.
export async function routeOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const ctx = getIdentityContext();

  if (method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    await handleDiscoveryProtectedResource(res, ctx);
    return true;
  }
  if (method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    await handleDiscoveryProtectedResource(res, ctx);
    return true;
  }
  if (method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    await handleDiscoveryAuthorizationServer(res, ctx);
    return true;
  }
  if (method === "GET" && url.pathname === "/oauth/authorize") {
    await handleAuthorize(url, res, ctx);
    return true;
  }
  if (method === "GET" && url.pathname === "/oauth/google/callback") {
    await handleGoogleCallback(url, res, ctx);
    return true;
  }
  if (method === "POST" && url.pathname === "/oauth/consent") {
    await handleConsent(req, res, ctx);
    return true;
  }
  if (method === "POST" && url.pathname === "/oauth/token") {
    await handleToken(req, res, ctx);
    return true;
  }

  return false;
}
