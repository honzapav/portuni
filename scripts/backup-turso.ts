// Backup the Turso database to a local SQL file. Reads TURSO_URL +
// TURSO_AUTH_TOKEN from process.env (typically supplied via varlock run --).
// The dump itself lives in src/infra/backup.ts and runs inside a single
// read transaction so concurrent writes cannot tear the snapshot.
//
// Run from project root: npm run backup

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../src/infra/db.js";
import { dumpDatabaseSql } from "../src/infra/backup.js";

async function main(): Promise<void> {
  const db = getDb();
  const dir = join(homedir(), "backups");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = join(dir, `portuni-backup-${stamp}.sql`);

  console.log("Backing up...");
  const sql = await dumpDatabaseSql(db, ({ table, rows }) => {
    console.log(`  ${table.padEnd(28)} ${rows} row${rows === 1 ? "" : "s"}`);
  });

  await writeFile(path, sql);
  const size = (sql.length / 1024).toFixed(1);
  console.log(`\nBackup written: ${path} (${size} KB)`);
}

main().catch((e) => {
  console.error("Backup failed:", e);
  process.exit(1);
});
