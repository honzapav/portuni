// Exports every table to one JSON file per table under <outDir> (batch B5,
// docs/superpowers/plans/2026-09-12-infra-batch.md). The testable logic
// lives in apps/server/infra/db-export.ts; this is the thin CLI wrapper,
// same shape as scripts/backup-turso.ts.
//
// Run: node --import tsx scripts/db-export.ts <outDir>
// (source db from the usual TURSO_URL / PORTUNI_DATABASE_URL env)

import { getDb } from "../apps/server/infra/db.js";
import { exportDb } from "../apps/server/infra/db-export.js";

// getDb() falls back to file:./portuni.db when neither is set -- right for
// a local dev server, wrong for an export meant to leave the real
// database. Same "must name its target or refuse" rule backup-turso.ts's
// requireRemoteTarget applies.
function requireExportSource(): void {
  if (!process.env.TURSO_URL?.trim() && !process.env.PORTUNI_DATABASE_URL?.trim()) {
    throw new Error(
      "Neither TURSO_URL nor PORTUNI_DATABASE_URL is set -- refusing to export " +
        "the local fallback database (file:./portuni.db). Point one of them at " +
        "the database you actually mean to export.",
    );
  }
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node --import tsx scripts/db-export.ts <outDir>");
    process.exit(1);
  }
  requireExportSource();
  const db = getDb();
  console.log(`Exporting (${db.dialect}) to ${outDir}...`);
  const manifest = await exportDb(db, outDir);
  for (const [table, info] of Object.entries(manifest.tables)) {
    console.log(`  ${table.padEnd(28)} ${info.rows} row${info.rows === 1 ? "" : "s"}`);
  }
  console.log(`\nExport written: ${outDir}`);
}

main().catch((e) => {
  console.error("Export failed:", e);
  process.exit(1);
});
