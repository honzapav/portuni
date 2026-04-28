import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient, type Client } from "@libsql/client";
import {
  DDL_REMOTES_TABLE,
  DDL_REMOTE_ROUTING_TABLE,
  INDEX_REMOTE_ROUTING_PRIORITY,
  runMigration010,
} from "../../src/infra/schema.js";
import { upsertRemote, addRule } from "../../src/domain/sync/routing.js";

export interface SharedDb {
  db: Client;
  remoteRoot: string;
  orgId: string;
  nodeId: string;
  orgSyncKey: string;
  nodeSyncKey: string;
}

export async function makeSharedDb(): Promise<SharedDb> {
  const db = createClient({ url: ":memory:" });
  await db.execute(
    `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')))`,
  );
  await db.execute(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
    sync_key TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE edges (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES nodes(id),
    target_id TEXT NOT NULL REFERENCES nodes(id), relation TEXT NOT NULL,
    meta TEXT, created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now'))
  )`);
  // Mirror current production schema (post-migration 012): no `local_path`
  // column on `files`. Anything that needs the on-disk path derives it from
  // the per-device mirror + remote_path + sync_key.
  await db.execute(`CREATE TABLE files (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL, filename TEXT NOT NULL,
    remote_name TEXT,
    remote_path TEXT,
    current_remote_hash TEXT,
    last_pushed_by TEXT,
    last_pushed_at DATETIME,
    is_native_format INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'wip', description TEXT, mime_type TEXT,
    created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now')), updated_at DATETIME DEFAULT (datetime('now'))
  )`);
  await db.execute(
    `CREATE TABLE audit_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT, timestamp DATETIME DEFAULT (datetime('now')))`,
  );
  await db.execute(DDL_REMOTES_TABLE);
  await db.execute(DDL_REMOTE_ROUTING_TABLE);
  await db.execute(INDEX_REMOTE_ROUTING_PRIORITY);
  await runMigration010(db);

  await db.execute("INSERT INTO users (id,email,name) VALUES ('U1','a@b','A')");
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
    args: ["E000000000000000000000001", nodeId, orgId, "belongs_to", "U1"],
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
