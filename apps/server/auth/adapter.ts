// Identity adapter contract. The backend authorization layer only ever
// sees Identity + AccessResolution; which IdP produced them is invisible.
// Portuni session JWTs and device tokens are verified by the server core
// (src/http/identity.ts), NOT by adapters — adapters verify IdP
// credentials only (Google ID token, env identity, future Microsoft...).

import type { GlobalScope } from "./roles.js";

export interface Identity {
  email: string;
  name: string;
  // Stable IdP-scoped subject ("env:<email>" for EnvAdapter, Google `sub`
  // for GoogleAdapter). Stored as users.google_sub for Google.
  sub: string;
}

export interface AccessResolution {
  globalScope: GlobalScope;
  groups: string[]; // emails (role mapping, ACL backward compatibility)
  groupIds: string[]; // Directory group IDs (ACL matching)
}

export interface IdentityAdapter {
  verify(credential: string): Promise<Identity>;
  resolveAccess(email: string): Promise<AccessResolution>;
  // Domain groups picker for the sharing UI (GET /auth/groups). Only
  // implemented by GoogleAdapter -- adapters without it make the endpoint
  // respond 501 google_mode_only.
  listDomainGroups?: (
    query: string,
  ) => Promise<Array<{ id: string; email: string; name: string }>>;
  // Interactive (browser redirect) login, the upstream half of the OAuth
  // connector flow (docs/superpowers/specs/2026-08-31-oauth-connectors-design.md).
  // Only implemented by GoogleAdapter -- adapters without it make the
  // /oauth/* routes 404 (env mode is loopback-only, no upstream IdP to
  // redirect to).
  interactiveLogin?: {
    redirectUrl(state: string): string;
    handleCallback(
      params: URLSearchParams,
    ): Promise<{ identity: Identity; avatarUrl: string | null }>;
  };
}
