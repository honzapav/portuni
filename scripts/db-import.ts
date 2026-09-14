// Imports a scripts/db-export.ts export into an EMPTY Postgres/PGlite
// target that already has the baseline schema applied (batch B5,
// docs/runbooks/postgres-cutover.md). The testable logic lives in
// apps/server/infra/db-import.ts; this is the thin CLI wrapper, same shape
// as scripts/backup-turso.ts.
//
// Run: PORTUNI_DATABASE_URL=postgres://... node --import tsx scripts/db-import.ts <inDir>

import { getDb } from "../apps/server/infra/db.js";
import { importDb } from "../apps/server/infra/db-import.js";

async function main(): Promise<void> {
  const inDir = process.argv[2];
  if (!inDir) {
    console.error("Usage: node --import tsx scripts/db-import.ts <inDir>");
    process.exit(1);
  }
  const db = getDb();
  if (db.dialect !== "postgres") {
    throw new Error(
      `db-import: target driver is "${db.dialect}", not postgres -- set PORTUNI_DATABASE_URL ` +
        "to a postgres:// or pglite: target. The target must already have the baseline schema " +
        "applied (see docs/runbooks/postgres-cutover.md).",
    );
  }
  console.log(`Importing from ${inDir} into the postgres target...`);
  const result = await importDb(db, inDir);
  for (const [table, rows] of Object.entries(result.tables)) {
    console.log(`  ${table.padEnd(28)} ${rows} row${rows === 1 ? "" : "s"}`);
  }
  console.log("\nImport complete.");
}

main().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
