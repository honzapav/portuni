import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn } from "../../apps/server/infra/schema.js";
import type { RoutingRule } from "../../apps/server/domain/sync/routing.js";

// Inserts directly into remotes/remote_routing, bypassing upsertRemote's and
// addRule's own writes -- fixtures using these represent a remote that
// already exists (the scenario local-engine tests exercise), which is
// exactly what a local workspace can no longer create from scratch since
// #310's LOCAL_MODE_NO_REMOTE guard. Going through the guarded domain
// functions here would make every test importing makeSharedDb depend on
// PORTUNI_AUTH_MODE=google.
export async function insertRemoteForTests(
  db: Client,
  a: { name: string; type: string; config: Record<string, unknown>; created_by: string },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO remotes (name, type, config_json, created_by, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(name) DO UPDATE SET
            type = excluded.type,
            config_json = excluded.config_json`,
    args: [a.name, a.type, JSON.stringify(a.config), a.created_by],
  });
}

export async function insertRuleForTests(db: Client, rule: RoutingRule): Promise<void> {
  await db.execute({
    sql: "INSERT INTO remote_routing (priority, node_type, org_slug, remote_name) VALUES (?, ?, ?, ?)",
    args: [rule.priority, rule.node_type, rule.org_slug, rule.remote_name],
  });
}

export interface SharedDb {
  db: Client;
  remoteRoot: string;
  orgId: string;
  nodeId: string;
  orgSyncKey: string;
  nodeSyncKey: string;
}

// Spin up an in-memory libsql client that mirrors the production schema
// exactly (DDL + migrations + triggers, all run via ensureSchemaOn).
// Seeds one organization, one project belonging to it, and one fs remote
// routed for everything. Tests get the IDs back and can layer further
// fixtures on top.
export async function makeSharedDb(): Promise<SharedDb> {
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);

  // Test-local user. Distinct from SOLO_USER so we can verify created_by
  // attribution explicitly. ensureSchemaOn already inserted SOLO_USER.
  await db.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)",
    args: ["U1", "a@b", "A"],
  });

  const orgId = "N0000000000000000000000ORG";
  const nodeId = "N000000000000000000000PROJ";
  const orgSyncKey = "workflow";
  const nodeSyncKey = "stan-gws";

  await db.execute({
    sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
    args: [orgId, "organization", "Workflow", orgSyncKey, "U1"],
  });
  await db.execute({
    sql: "INSERT INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
    args: [nodeId, "project", "Stan GWS", nodeSyncKey, "U1"],
  });
  await db.execute({
    sql: "INSERT INTO edges (id,source_id,target_id,relation,created_by) VALUES (?,?,?,?,?)",
    args: [ulid(), nodeId, orgId, "belongs_to", "U1"],
  });

  const remoteRoot = await mkdtemp(join(tmpdir(), "portuni-shareddb-remote-"));
  await insertRemoteForTests(db, {
    name: "test-fs",
    type: "fs",
    config: { root: remoteRoot },
    created_by: "U1",
  });
  await insertRuleForTests(db, { priority: 10, node_type: null, org_slug: null, remote_name: "test-fs" });
  return { db, remoteRoot, orgId, nodeId, orgSyncKey, nodeSyncKey };
}
