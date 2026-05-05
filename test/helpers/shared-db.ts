import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn } from "../../src/infra/schema.js";
import { upsertRemote, addRule } from "../../src/domain/sync/routing.js";

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
  await upsertRemote(db, {
    name: "test-fs",
    type: "fs",
    config: { root: remoteRoot },
    created_by: "U1",
  });
  await addRule(db, { priority: 10, node_type: null, org_slug: null, remote_name: "test-fs" });
  return { db, remoteRoot, orgId, nodeId, orgSyncKey, nodeSyncKey };
}
