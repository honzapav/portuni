// SQL dump of the whole database (schema + data + indexes + triggers).
// Used by scripts/backup-turso.ts; extracted here so the dump logic is
// testable without executing the script's filesystem side effects.
//
// All reads happen inside ONE read transaction: SQLite gives a stable
// snapshot for its duration, so a write landing mid-dump (an agent storing
// a file, a sync run) can no longer produce a dump where an edge references
// a node that was captured in an earlier statement's view of the world.
// A backup that might not restore cleanly fails exactly when it is needed.

import type { Client, Transaction } from "@libsql/client";

export interface DumpProgress {
  table: string;
  rows: number;
}

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

async function dumpWithin(
  tx: Transaction,
  onProgress?: (p: DumpProgress) => void | Promise<void>,
): Promise<string> {
  const chunks: string[] = [
    `-- Portuni Turso backup\n-- ${new Date().toISOString()}\n\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n`,
  ];

  const tables = await tx.execute(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );

  for (const t of tables.rows) {
    const tableName = t.name as string;
    const tableDdl = (t.sql as string | null) ?? "";
    if (tableDdl) chunks.push(`${tableDdl};\n\n`);
    const rows = await tx.execute(`SELECT * FROM "${tableName}"`);
    const cols = rows.columns;
    for (const r of rows.rows) {
      const vals = cols.map((c) => quoteValue((r as Record<string, unknown>)[c]));
      chunks.push(
        `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${vals.join(",")});\n`,
      );
    }
    if (rows.rows.length > 0) chunks.push("\n");
    if (onProgress) await onProgress({ table: tableName, rows: rows.rows.length });
  }

  // Indexes + triggers AFTER the data: restore replays inserts without
  // firing triggers, and index creation on populated tables is faster.
  const idx = await tx.execute(
    "SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
  );
  for (const r of idx.rows) chunks.push(`${r.sql};\n`);
  chunks.push("\nCOMMIT;\nPRAGMA foreign_keys=ON;\n");

  return chunks.join("");
}

export async function dumpDatabaseSql(
  db: Client,
  onProgress?: (p: DumpProgress) => void | Promise<void>,
): Promise<string> {
  const tx = await db.transaction("read");
  try {
    return await dumpWithin(tx, onProgress);
  } finally {
    tx.close();
  }
}
