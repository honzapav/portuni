// Schema entry point. Holds the runtime hooks (ensureSchema, seedSoloUser,
// SOLO_USER constant) and re-exports everything that callers outside the
// infra layer need. The bulky reference data lives in:
//
// - schema-triggers.ts: SQL DDL/trigger string constants
// - schema-migrations.ts: numbered migrations + the migration runner

import type { Client } from "@libsql/client";
import { getDb } from "./db.js";
import {
  NODE_TYPES,
  EDGE_RELATIONS,
  EVENT_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
  EVENT_STATUSES,
  FILE_STATUSES,
} from "../shared/popp.js";
import { DDL, DDL_MIGRATION_006 } from "./schema-triggers.js";
import { runMigrations } from "./schema-migrations.js";

// Re-export canonical sets so existing imports from "./schema.js" keep working.
export {
  NODE_TYPES,
  EDGE_RELATIONS,
  EVENT_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
  EVENT_STATUSES,
  FILE_STATUSES,
};
export type {
  NodeType,
  EdgeRelation,
  EventType,
  NodeStatus,
  NodeVisibility,
  EventStatus,
  FileStatus,
} from "../shared/popp.js";

// Re-export the trigger/DDL constants that tests import directly.
export {
  TRIGGER_PREVENT_MULTI_PARENT_ORG,
  TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE,
  DDL_REMOTES_TABLE,
  DDL_REMOTE_ROUTING_TABLE,
  INDEX_REMOTE_ROUTING_PRIORITY,
} from "./schema-triggers.js";

// Re-export migration runners that tests call directly.
export {
  runMigration006,
  runMigration009,
  runMigration010,
  runMigration011,
  runMigration012,
  runMigration013,
} from "./schema-migrations.js";

const SOLO_USER_ID = "01SOLO0000000000000000000";

export const SOLO_USER = SOLO_USER_ID;

async function seedSoloUser(db: Client): Promise<void> {
  const email = process.env.PORTUNI_USER_EMAIL ?? "solo@localhost";
  const name = process.env.PORTUNI_USER_NAME ?? "Solo User";
  await db.execute({
    sql: `INSERT OR IGNORE INTO users (id, email, name, created_at)
          VALUES (?, ?, ?, datetime('now'))`,
    args: [SOLO_USER_ID, email, name],
  });
}

// Apply the full schema (DDL + migration 006 fresh DDL + seed solo user +
// run all idempotent migrations) against an arbitrary libsql client.
// Used by ensureSchema() at startup and by tests against :memory: DBs.
export async function ensureSchemaOn(db: Client): Promise<void> {
  // Migration 013 sync_key NOT-NULL triggers are intentionally NOT in this
  // loop — they reference the sync_key column, which on existing pre-013
  // DBs does not yet exist when ensureSchema runs. The 013 migration
  // handles them idempotently after the column is added.
  for (const sql of [...DDL, ...DDL_MIGRATION_006]) {
    await db.execute(sql);
  }
  await seedSoloUser(db);
  await runMigrations(db);
}

export async function ensureSchema(): Promise<void> {
  await ensureSchemaOn(getDb());
}
