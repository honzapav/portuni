// Schema entry point. Holds the runtime hooks (ensureSchema, seedSoloUser,
// SOLO_USER constant) and re-exports everything that callers outside the
// infra layer need. The bulky reference data lives in:
//
// - schema-triggers.ts: SQL DDL/trigger string constants
// - schema-migrations.ts: numbered migrations + the migration runner

import { createHash } from "node:crypto";
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
import { runMigrations, appliedMigrationIds, MIGRATION_IDS } from "./schema-migrations.js";

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
  runMigration021,
  runMigration022,
  runMigration024,
  runMigration027,
  runMigration028,
  runMigration030,
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

// Opt-in full DDL replay. Set PORTUNI_SCHEMA_REPAIR=1 (or pass
// { repair: true }) to force ensureSchemaOn to re-run every
// CREATE ... IF NOT EXISTS even on a database that is already at the current
// schema version. That replay is what silently recreated an accidentally
// dropped table, index or trigger; the version fast path below no longer
// pays for it on every healthy boot, so recovering from a damaged schema is
// now a deliberate act rather than a side effect.
// Fingerprint of the DDL set this build carries, recorded in `migrations`
// alongside the real migration ids once a replay succeeds.
//
// Without it the version fast path would introduce a footgun: adding a table,
// index or trigger to DDL without also adding a migration would silently
// never reach an existing database, because every known migration is already
// recorded there. Keying the fast path on the DDL set as well means any edit
// to DDL costs exactly one more full replay, on the first boot after the
// change, and the boot after that is back to three calls.
function ddlFingerprint(): string {
  const digest = createHash("sha256")
    .update([...DDL, ...DDL_MIGRATION_006].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `ddl:${digest}`;
}

function repairRequested(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.PORTUNI_SCHEMA_REPAIR === "1";
}

export interface EnsureSchemaOptions {
  // Force the full DDL replay even when every known migration is recorded.
  repair?: boolean;
}

// Apply the full schema (DDL + migration 006 fresh DDL + seed solo user +
// run all idempotent migrations) against an arbitrary libsql client.
// Used by ensureSchema() at startup and by tests against :memory: DBs.
//
// A database that already records every migration this build knows about is
// at the current schema version, and replaying 56 CREATE ... IF NOT EXISTS
// statements against it changes nothing. On local SQLite that replay is free;
// against Turso it is 56 sequential network round trips before the sidecar
// binds its port, and it grew by one with every DDL item ever added. Measured
// on a fully migrated database: 91 execute calls, 1.82 s at 20 ms per call.
// The fast path below is three.
export async function ensureSchemaOn(
  db: Client,
  options: EnsureSchemaOptions = {},
): Promise<void> {
  // SQLite defaults to foreign_keys OFF per connection, which silently
  // disables every ON DELETE CASCADE in the schema on local file:/:memory:
  // databases (Turso/sqld enforces FKs server-side regardless). The pragma
  // is connection-scoped and this is the funnel every entry point and test
  // routes its client through. Remote HTTP clients may reject PRAGMA --
  // fine, enforcement is already on over there.
  try {
    await db.execute("PRAGMA foreign_keys = ON");
  } catch {
    /* remote connection; FKs enforced server-side */
  }
  // Version check first: if every migration this build knows about is already
  // recorded, the DDL replay and the migration pass have nothing to do.
  // appliedMigrationIds returns null when the migrations table itself is
  // missing (a database created before it existed), which reads as "cannot
  // tell" and takes the full path.
  const fingerprint = ddlFingerprint();
  if (!repairRequested(options.repair)) {
    const applied = await appliedMigrationIds(db);
    if (applied?.has(fingerprint) && MIGRATION_IDS.every((id) => applied.has(id))) {
      // seedSoloUser stays on the fast path: it is one INSERT OR IGNORE and
      // the solo user row is data, not schema, so no migration marker
      // records whether it is there.
      await seedSoloUser(db);
      return;
    }
  }

  // Migration 013 sync_key NOT-NULL triggers are intentionally NOT in this
  // loop — they reference the sync_key column, which on existing pre-013
  // DBs does not yet exist when ensureSchema runs. The 013 migration
  // handles them idempotently after the column is added.
  for (const sql of [...DDL, ...DDL_MIGRATION_006]) {
    await db.execute(sql);
  }
  await seedSoloUser(db);
  await runMigrations(db);
  // Recorded last: only a replay that got all the way through may license the
  // next boot to skip it.
  await db.execute({
    sql: "INSERT OR IGNORE INTO migrations (id) VALUES (?)",
    args: [fingerprint],
  });
}

export async function ensureSchema(): Promise<void> {
  await ensureSchemaOn(getDb());
}

// Explicit schema repair: full DDL replay plus the migration pass, regardless
// of recorded version. The escape hatch for a database whose schema was
// damaged out from under it.
export async function repairSchemaOn(db: Client): Promise<void> {
  await ensureSchemaOn(db, { repair: true });
}
