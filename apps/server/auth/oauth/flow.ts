// Signed, short-TTL (10 min) OAuth authorization-flow state. Carries the
// original /oauth/authorize request -- and, once the Google callback has
// run, the verified identity -- through the redirect to Google and back to
// the consent page. There is no server-side session: the JWT itself is the
// state, signed with the existing PORTUNI_JWT_SECRET (jose, same as
// session-token.ts). It also doubles as the CSRF token for the consent
// POST -- only this server could have produced it, and the consent form
// must echo it verbatim.
// Spec: docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Decisions", "Authorization flow" steps 2, 4-5).

import { SignJWT, jwtVerify } from "jose";

const FLOW_STATE_TTL_SECONDS = 10 * 60;

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope: string;
}

export interface VerifiedIdentity {
  userId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface FlowState {
  request: AuthorizeRequest;
  identity?: VerifiedIdentity;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function isAuthorizeRequest(value: unknown): value is AuthorizeRequest {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.clientId === "string" &&
    typeof r.redirectUri === "string" &&
    typeof r.codeChallenge === "string" &&
    typeof r.state === "string" &&
    typeof r.resource === "string" &&
    typeof r.scope === "string"
  );
}

function isVerifiedIdentity(value: unknown): value is VerifiedIdentity {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.userId === "string" &&
    typeof r.email === "string" &&
    typeof r.name === "string" &&
    (r.avatarUrl === null || typeof r.avatarUrl === "string")
  );
}

export async function signFlowState(state: FlowState, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ request: state.request, identity: state.identity ?? null })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("portuni-oauth-flow")
    .setIssuedAt(now)
    .setExpirationTime(now + FLOW_STATE_TTL_SECONDS)
    .sign(key(secret));
}

export async function verifyFlowState(token: string, secret: string): Promise<FlowState | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: "portuni-oauth-flow",
      algorithms: ["HS256"],
    });
    if (!isAuthorizeRequest(payload.request)) return null;
    const identity = payload.identity;
    if (identity != null && !isVerifiedIdentity(identity)) return null;
    return {
      request: payload.request,
      identity: identity ?? undefined,
    };
  } catch {
    return null;
  }
}
