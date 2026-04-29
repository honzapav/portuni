// Backup the Turso database to a local SQL file by enumerating tables and
// emitting CREATE + INSERT statements. Reads TURSO_URL + TURSO_AUTH_TOKEN
// from process.env (typically supplied via varlock run --).
//
// Run from project root: varlock run -- node --import tsx scripts/backup-turso.ts

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../src/infra/db.js";

function quoteValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.isBuffer(v) ? v : Buffer.from(v);
    return `X'${buf.toString("hex")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const db = getDb();
  const dir = join(homedir(), "backups");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = join(dir, `portuni-pre-sync-phase1-${stamp}.sql`);

  let out = `-- Portuni Turso backup\n-- ${new Date().toISOString()}\n\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n`;

  const tables = await db.execute(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  console.log(`Backing up ${tables.rows.length} table(s)...`);

  for (const t of tables.rows) {
    const tableName = t.name as string;
    const tableDdl = (t.sql as string | null) ?? "";
    if (tableDdl) out += `${tableDdl};\n\n`;
    const rows = await db.execute(`SELECT * FROM "${tableName}"`);
    if (rows.rows.length === 0) {
      console.log(`  ${tableName.padEnd(28)} 0 rows`);
      continue;
    }
    const cols = rows.columns;
    for (const r of rows.rows) {
      const vals = cols.map((c) => quoteValue((r as Record<string, unknown>)[c]));
      out += `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${vals.join(",")});\n`;
    }
    out += "\n";
    console.log(`  ${tableName.padEnd(28)} ${rows.rows.length} rows`);
  }

  // Indexes + triggers (so a restore reproduces them).
  const idx = await db.execute(
    "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
  );
  for (const r of idx.rows) out += `${r.sql};\n`;
  out += "\nCOMMIT;\nPRAGMA foreign_keys=ON;\n";

  await writeFile(path, out);
  const size = (out.length / 1024).toFixed(1);
  console.log(`\nBackup written: ${path} (${size} KB)`);
}

main().catch((e) => {
  console.error("Backup failed:", e);
  process.exit(1);
});
