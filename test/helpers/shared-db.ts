import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { ensureSchemaOn } from "../../apps/server/infra/schema.js";
import { insertIgnore, nowExpr } from "../../apps/server/infra/sql.js";
import type { DbClient } from "../../apps/server/infra/db.js";
import { openTestDb, type TestDbDriver } from "./db.js";
import type { RoutingRule } from "../../apps/server/domain/sync/routing.js";

// Inserts directly into remotes/remote_routing, bypassing upsertRemote's and
// addRule's own writes -- fixtures using these represent a remote that
// already exists (the scenario local-engine tests exercise), which is
// exactly what a local workspace can no longer create from scratch since
// #310's LOCAL_MODE_NO_REMOTE guard. Going through the guarded domain
// functions here would make every test importing makeSharedDb depend on
// PORTUNI_AUTH_MODE=google.
export async function insertRemoteForTests(
  db: DbClient,
  a: { name: string; type: string; config: Record<string, unknown>; created_by: string },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO remotes (name, type, config_json, created_by, created_at)
          VALUES (?, ?, ?, ?, ${nowExpr(db.dialect)})
          ON CONFLICT(name) DO UPDATE SET
            type = excluded.type,
            config_json = excluded.config_json`,
    args: [a.name, a.type, JSON.stringify(a.config), a.created_by],
  });
}

export async function insertRuleForTests(db: DbClient, rule: RoutingRule): Promise<void> {
  await db.execute({
    sql: "INSERT INTO remote_routing (priority, node_type, org_slug, remote_name) VALUES (?, ?, ?, ?)",
    args: [rule.priority, rule.node_type, rule.org_slug, rule.remote_name],
  });
}

export interface SharedDb {
  db: DbClient;
  remoteRoot: string;
  orgId: string;
  nodeId: string;
  orgSyncKey: string;
  nodeSyncKey: string;
}

// Spin up an in-memory DbClient (driver from PORTUNI_TEST_DB, default
// libsql -- see test/helpers/db.ts) that mirrors the production schema
// exactly (DDL + migrations + triggers, all run via ensureSchemaOn).
// Seeds one organization, one project belonging to it, and one fs remote
// routed for everything. Tests get the IDs back and can layer further
// fixtures on top.
//
// `driver` overrides PORTUNI_TEST_DB -- for the test/migration-*.test.ts
// files that call schema-migrations.ts's runMigrationNNN/runMigrations
// directly against the returned db: those functions ARE the libsql
// migration path (PRAGMA table_info, sqlite_master introspection) and have
// no Postgres equivalent -- schema.pg.ts's baseline already carries
// everything they migrate towards, applied as a single step. Pass
// `"libsql"` explicitly from those tests regardless of which driver the
// rest of the matrix run is exercising.
export async function makeSharedDb(driver?: TestDbDriver): Promise<SharedDb> {
  const db = await openTestDb(driver);
  await ensureSchemaOn(db);

  // Test-local user. Distinct from SOLO_USER so we can verify created_by
  // attribution explicitly. ensureSchemaOn already inserted SOLO_USER.
  await db.execute({
    sql: insertIgnore(db.dialect, "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)"),
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
