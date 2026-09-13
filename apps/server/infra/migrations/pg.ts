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
// Each migration runs as ONE `executeMultiple` call, with its own marker
// INSERT appended to the same script: Postgres's simple query protocol
// implicitly wraps a multi-statement script in a single transaction (no
// explicit BEGIN/COMMIT needed), so a mid-migration failure (a typo'd
// CREATE FUNCTION, say) leaves nothing committed and no marker row, and a
// crash between the DDL and the marker cannot happen either -- the next
// boot retries cleanly instead of hitting "already exists" against a
// half-applied schema. The baseline's own statements are idempotent on top
// of that (IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF
// EXISTS before every CREATE TRIGGER).

import type { DbClient } from "../db.js";
import { PG_BASELINE_DDL } from "../schema.pg.js";
import { PG_BASELINE_TRIGGERS } from "../schema-triggers.pg.js";

interface PgMigration {
  id: string;
  // The migration's statements, without the marker INSERT -- ensurePgSchema
  // appends that itself so DDL and marker always commit together.
  statements: readonly string[];
}

const BASELINE: PgMigration = {
  id: "pg-001",
  statements: [...PG_BASELINE_DDL, ...PG_BASELINE_TRIGGERS],
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
    // Marker in the same script (same implicit transaction) as the DDL;
    // the id is a compile-time constant of this module, never user input.
    await db.executeMultiple(
      [...migration.statements, `INSERT INTO migrations (id) VALUES ('${migration.id}')`].join(";\n"),
    );
  }
}
