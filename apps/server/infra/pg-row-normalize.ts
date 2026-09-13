// Shared by db-pg.ts and db-pglite.ts. pg/PGlite return TIMESTAMPTZ
// columns as native JS Date objects; libsql returns DATETIME columns as
// plain strings. DbClient's contract is dialect-neutral rows (DbRow =
// Record<string, DbValue>, no Date), so both pg drivers normalize every
// row through this on the way out -- to the same text shape SQLite's own
// datetime('now') produces ("YYYY-MM-DD HH:MM:SS", second precision, no
// timezone suffix), so a caller that string-compares timestamps (a
// handful of legacy call sites, plus Zod schemas typed `z.string()`) sees
// identical values on both dialects.
import type { DbRow } from "./db.js";

export function normalizePgRow(row: Record<string, unknown>): DbRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString().replace("T", " ").slice(0, 19) : value;
  }
  return out as DbRow;
}
