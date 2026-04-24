import type { Client } from "@libsql/client";
import type { RemoteConfig, RemoteType } from "./types.js";

export interface RemoteRow extends RemoteConfig {
  created_by: string;
  created_at: string;
}

export interface UpsertRemoteArgs {
  name: string;
  type: RemoteType;
  config: Record<string, unknown>;
  created_by: string;
}

export async function upsertRemote(db: Client, a: UpsertRemoteArgs): Promise<void> {
  await db.execute({
    sql: `INSERT INTO remotes (name, type, config_json, created_by, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(name) DO UPDATE SET
            type = excluded.type,
            config_json = excluded.config_json`,
    args: [a.name, a.type, JSON.stringify(a.config), a.created_by],
  });
}

export async function getRemote(db: Client, name: string): Promise<RemoteRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM remotes WHERE name = ?", args: [name] });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    name: row.name as string,
    type: row.type as RemoteType,
    config: JSON.parse(row.config_json as string) as Record<string, unknown>,
    created_by: row.created_by as string,
    created_at: row.created_at as string,
  };
}

export async function listRemotes(db: Client): Promise<RemoteRow[]> {
  const r = await db.execute("SELECT * FROM remotes ORDER BY name ASC");
  return r.rows.map((row) => ({
    name: row.name as string,
    type: row.type as RemoteType,
    config: JSON.parse(row.config_json as string) as Record<string, unknown>,
    created_by: row.created_by as string,
    created_at: row.created_at as string,
  }));
}

export async function deleteRemote(db: Client, name: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM remotes WHERE name = ?", args: [name] });
}

export interface RoutingRule {
  priority: number;
  node_type: string | null;
  org_slug: string | null;
  remote_name: string;
}

export async function addRule(db: Client, rule: RoutingRule): Promise<void> {
  await db.execute({
    sql: "INSERT INTO remote_routing (priority, node_type, org_slug, remote_name) VALUES (?, ?, ?, ?)",
    args: [rule.priority, rule.node_type, rule.org_slug, rule.remote_name],
  });
}

export async function listRules(db: Client): Promise<RoutingRule[]> {
  const r = await db.execute(
    "SELECT priority, node_type, org_slug, remote_name FROM remote_routing ORDER BY priority ASC, id ASC",
  );
  return r.rows.map((row) => ({
    priority: Number(row.priority),
    node_type: (row.node_type as string | null) ?? null,
    org_slug: (row.org_slug as string | null) ?? null,
    remote_name: row.remote_name as string,
  }));
}

export async function replaceRules(db: Client, rules: RoutingRule[]): Promise<void> {
  await db.execute("DELETE FROM remote_routing");
  for (const rule of rules) await addRule(db, rule);
}

// Resolve which remote applies to (nodeType, orgSlug). The spec algorithm:
// match either a literal value or a NULL wildcard for both filters; tie-break
// by ascending priority (then insertion order). A non-null filter on the rule
// must match a non-null call argument; null in the call argument cannot match
// a non-null filter.
export async function resolveRemote(
  db: Client,
  nodeType: string,
  orgSlug: string | null,
): Promise<string | null> {
  const r = await db.execute({
    sql: `SELECT remote_name FROM remote_routing
          WHERE (node_type = ? OR node_type IS NULL)
            AND (org_slug = ? OR org_slug IS NULL)
          ORDER BY priority ASC, id ASC LIMIT 1`,
    args: [nodeType, orgSlug],
  });
  return r.rows.length === 0 ? null : (r.rows[0].remote_name as string);
}
