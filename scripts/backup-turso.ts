// Backup the Turso database to a local SQL file. Reads TURSO_URL +
// TURSO_AUTH_TOKEN from process.env (typically supplied via varlock run --).
// The dump itself lives in src/infra/backup.ts and runs inside a single
// read transaction so concurrent writes cannot tear the snapshot.
//
// Run from project root: npm run backup

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../apps/server/infra/db.js";
import { dumpDatabaseSql } from "../apps/server/infra/backup.js";

// getDb() falls back to `file:./portuni.db` when TURSO_URL is unset, which is
// right for a local dev server and catastrophic for a backup: the run then
// dumps whatever stale SQLite happens to sit in the working directory and
// reports "Backup written" exactly as if it had reached the real database.
// That is how the safety net recorded after incident 2026-06-10 ("before
// every deploy with a migration: npm run backup") came to protect nothing --
// a deploy went out against a 4.4 MB production database backed by a 15 KB
// dump of a July scratch file. A backup must name its target or refuse.
function requireRemoteTarget(): string {
  const url = process.env.TURSO_URL?.trim();
  if (!url) {
    throw new Error(
      "TURSO_URL is not set -- refusing to back up the local fallback database " +
        "(file:./portuni.db). Point TURSO_URL/TURSO_AUTH_TOKEN at the database " +
        "you actually mean to back up.",
    );
  }
  return url;
}

async function main(): Promise<void> {
  const target = requireRemoteTarget();
  // Host only -- the token never reaches the log.
  console.log(`Target: ${target.replace(/^(\w+:\/\/[^/?#]+).*$/, "$1")}`);
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
