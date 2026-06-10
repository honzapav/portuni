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
  groups: string[];
}

export interface IdentityAdapter {
  verify(credential: string): Promise<Identity>;
  resolveAccess(email: string): Promise<AccessResolution>;
}
