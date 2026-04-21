// scripts/unmark-006.ts -- one-off repair script for migration 006 drift.
// Deletes the 006 marker from the `migrations` table so the next server
// start re-runs the (now idempotent) migration.

import "varlock/auto-load";
import { getDb } from "../src/db.js";

async function main() {
  const db = getDb();
  const before = await db.execute("SELECT * FROM migrations WHERE id = '006_people_responsibilities'");
  console.log("Before unmark (006 row count):", before.rows.length);
  await db.execute("DELETE FROM migrations WHERE id = '006_people_responsibilities'");
  const after = await db.execute("SELECT id FROM migrations ORDER BY applied_at");
  console.log("Migrations after unmark:", after.rows.map((r) => r.id));
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
