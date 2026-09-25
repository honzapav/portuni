// A libsql graph db as it was before migration 040 (#462): sessions still
// carries `brief` and `handoff_inline`, and the graph db has its own
// `session_events`. Built from a current install by adding the two
// columns and the table back (the shapes migrations 034/035 left them in)
// and forgetting that 040 ran, so the next ensureSchemaOn runs it.

import type { DbClient } from "../../apps/server/infra/db.js";
import { SESSION_CONTENT_DROP_MIGRATION_ID } from "../../apps/server/infra/schema-migrations.js";

export async function makeLegacySessionContentSchema(db: DbClient): Promise<void> {
  const pg = db.dialect === "postgres";
  // Postgres has no migration 040 (its baseline is the current shape, no
  // pg-002 before the cutover); the table is the old baseline's.
  await db.executeMultiple(`
    ALTER TABLE sessions ADD COLUMN brief TEXT;
    ALTER TABLE sessions ADD COLUMN handoff_inline TEXT;
    CREATE TABLE session_events (
      id TEXT ${pg ? "NOT NULL" : "PRIMARY KEY"} CHECK(length(id) = 26),
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES session_runs(id) ON DELETE SET NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at ${pg ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "DATETIME NOT NULL DEFAULT (datetime('now'))"},
      ${pg ? "PRIMARY KEY (session_id, seq)" : "UNIQUE(session_id, seq)"}
    );
  `);
  if (!pg) {
    await db.execute({ sql: "DELETE FROM migrations WHERE id = ?", args: [SESSION_CONTENT_DROP_MIGRATION_ID] });
  }
}
