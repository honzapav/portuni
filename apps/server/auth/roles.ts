// Global role model. Roles come from Google Workspace group membership
// (or the EnvAdapter, which grants admin). Mapping group-email -> role is
// server configuration (env), not data — see spec §3.

export const GLOBAL_SCOPES = ["read", "write", "manage", "admin"] as const;
export type GlobalScope = (typeof GLOBAL_SCOPES)[number];

const RANK: Record<GlobalScope, number> = { read: 0, write: 1, manage: 2, admin: 3 };

export function scopeAtLeast(actual: GlobalScope, required: GlobalScope): boolean {
  return RANK[actual] >= RANK[required];
}

// 'read' is the implicit floor — no group needed. Only roles above read
// are explicitly configured.
export interface GroupRoleConfig {
  admin: string[];
  manage: string[];
  write: string[];
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function groupRoleConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GroupRoleConfig {
  return {
    admin: parseList(env.PORTUNI_GROUPS_ADMIN),
    manage: parseList(env.PORTUNI_GROUPS_MANAGE),
    write: parseList(env.PORTUNI_GROUPS_WRITE),
  };
}

// Highest matching group wins; any authenticated user gets at least read.
export function resolveGlobalScope(
  groups: string[],
  cfg: GroupRoleConfig,
): GlobalScope {
  const set = new Set(groups.map((g) => g.toLowerCase()));
  if (cfg.admin.some((g) => set.has(g))) return "admin";
  if (cfg.manage.some((g) => set.has(g))) return "manage";
  if (cfg.write.some((g) => set.has(g))) return "write";
  return "read";
}
