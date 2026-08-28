// Global role scopes as served by GET /me (`global_scope`). Mirrors the
// rank order in apps/server/auth/roles.ts; the server stays the enforcer,
// the UI only uses this to hide/disable affordances the request would
// 403 on anyway.

export const GLOBAL_SCOPES = ["read", "write", "manage", "admin"] as const;
export type GlobalScope = (typeof GLOBAL_SCOPES)[number];

const RANK: Record<GlobalScope, number> = { read: 0, write: 1, manage: 2, admin: 3 };

export function isGlobalScope(value: unknown): value is GlobalScope {
  return typeof value === "string" && (GLOBAL_SCOPES as readonly string[]).includes(value);
}

export function scopeAtLeast(actual: GlobalScope, required: GlobalScope): boolean {
  return RANK[actual] >= RANK[required];
}

// Minimum scope of POST /nodes -- keep in sync with
// apps/server/auth/min-scopes.ts (`minScopeForRoute`).
export const CREATE_NODE_SCOPE: GlobalScope = "read";
