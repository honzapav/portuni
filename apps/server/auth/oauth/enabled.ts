// Whether the OAuth connector surface (routes in apps/server/api/oauth.ts,
// the poa_ bearer branch and the resource_metadata pointer on /mcp 401s in
// apps/server/http/middleware.ts) is switched on: google auth mode, an
// adapter with interactiveLogin, and PORTUNI_PUBLIC_URL configured. Shared
// by both call sites -- api/oauth.ts imports getIdentityContext from
// http/middleware.ts, so putting this here (rather than in either of those
// two files) avoids a circular import.
// Spec: docs/superpowers/specs/2026-08-31-oauth-connectors-design.md
// ("Endpoints", "Token verification at runtime").

import type { IdentityContext } from "../request-identity.js";

export function canonicalIssuer(): string {
  return (process.env.PORTUNI_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
}

export function isOAuthEnabled(ctx: IdentityContext): boolean {
  return (
    ctx.mode === "google" && ctx.adapter.interactiveLogin != null && canonicalIssuer().length > 0
  );
}
