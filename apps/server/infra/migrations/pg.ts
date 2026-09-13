// Migration framework for the pg/PGlite drivers (batch B2,
// docs/superpowers/plans/2026-09-12-infra-batch.md). Separate from
// schema-migrations.ts (libsql-only, untouched by this batch): a disjoint
// id namespace ("pg-NNN" here, "NNN_name" there) in the SAME `migrations`
// table shape (schema.pg.ts's own CREATE TABLE), never both populated in
// the same database. The baseline (every table + every trigger) is itself
// migration `pg-001` -- there is no separate "fresh install" DDL path the
// way schema.ts has one for libsql; applying every known migration in
// order against an empty database *is* the fresh-install path here.
//
// The whole baseline runs as ONE `executeMultiple` call: Postgres's simple
// query protocol implicitly wraps a multi-statement script in a single
// transaction (no explicit BEGIN/COMMIT needed), so a mid-baseline failure
// (a typo'd CREATE FUNCTION, say) leaves nothing committed and no `pg-001`
// marker row -- the next boot retries cleanly instead of hitting
// "relation already exists" against a half-applied schema.

import type { DbClient } from "../db.js";
import { PG_BASELINE_DDL } from "../schema.pg.js";
import { PG_BASELINE_TRIGGERS } from "../schema-triggers.pg.js";

interface PgMigration {
  id: string;
  up: (db: DbClient) => Promise<void>;
}

const BASELINE: PgMigration = {
  id: "pg-001",
  async up(db) {
    await db.executeMultiple([...PG_BASELINE_DDL, ...PG_BASELINE_TRIGGERS].join(";\n"));
  },
};

// Append here as the Postgres schema evolves post-baseline -- same pattern
// as schema-migrations.ts's MIGRATIONS array, just a disjoint id space.
const PG_MIGRATIONS: readonly PgMigration[] = [BASELINE];

export const PG_MIGRATION_IDS: readonly string[] = PG_MIGRATIONS.map((m) => m.id);

export async function ensurePgSchema(db: DbClient): Promise<void> {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const res = await db.execute("SELECT id FROM migrations");
  const applied = new Set(res.rows.map((r) => String(r.id)));

  for (const migration of PG_MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await migration.up(db);
    await db.execute({ sql: "INSERT INTO migrations (id) VALUES (?)", args: [migration.id] });
  }
}
