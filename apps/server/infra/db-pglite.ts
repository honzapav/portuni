// DbClient over @electric-sql/pglite (embedded Postgres) -- the local-mode
// driver from B4 onward; introduced here so the interface and its three
// implementations land together (batch B1). Every call site writes `?`
// positional placeholders (libsql's convention); rewritten to `$1, $2, ...`
// here so B3's dialect-neutral SQL pass never has to touch call sites for
// this reason. Named (`Record`) args are never used anywhere in this
// codebase (checked at B1 time) -- only positional arrays are supported.
import { PGlite, type Results } from "@electric-sql/pglite";
import type { DbClient, DbResultSet, DbTransactionMode, InStatement, InValue } from "./db.js";
import { rewritePositionalPlaceholders } from "./sql-placeholders.js";
import { normalizePgRow } from "./pg-row-normalize.js";

function normalizeStmt(stmt: InStatement): { sql: string; args: InValue[] } {
  if (typeof stmt === "string") return { sql: stmt, args: [] };
  if (stmt.args === undefined) return { sql: stmt.sql, args: [] };
  if (Array.isArray(stmt.args)) return { sql: stmt.sql, args: stmt.args };
  throw new Error("db-pglite: named (object) args are not supported, only positional arrays");
}

function toDbResultSet(res: Results<unknown>): DbResultSet {
  return {
    columns: res.fields.map((f) => f.name),
    rows: (res.rows as Record<string, unknown>[]).map(normalizePgRow),
    rowsAffected: res.affectedRows ?? 0,
    lastInsertRowid: undefined,
  };
}

export function createPgliteDbClient(dataDir?: string): DbClient {
  const db = new PGlite(dataDir);
  // Session time zone pinned to UTC, same as db-pg.ts: normalizePgRow
  // renders TIMESTAMPTZ as UTC text without a zone suffix, and that text
  // comes back in as a bare literal (db-import, string-compared filters),
  // which Postgres reads in the session zone -- with the host's zone every
  // round trip shifted timestamps by the local offset.
  const ready = db.waitReady.then(() => db.exec("SET TIME ZONE 'UTC'"));
  return {
    dialect: "postgres",
    async execute(stmt: InStatement): Promise<DbResultSet> {
      await ready;
      const { sql, args } = normalizeStmt(stmt);
      const res = await db.query(rewritePositionalPlaceholders(sql), args as unknown[]);
      return toDbResultSet(res);
    },
    async batch(stmts: InStatement[], mode?: DbTransactionMode): Promise<DbResultSet[]> {
      void mode; // PGlite's transaction() has no separate read/write/deferred modes.
      await ready;
      return db.transaction(async (tx) => {
        const out: DbResultSet[] = [];
        for (const stmt of stmts) {
          const { sql, args } = normalizeStmt(stmt);
          const res = await tx.query(rewritePositionalPlaceholders(sql), args as unknown[]);
          out.push(toDbResultSet(res));
        }
        return out;
      });
    },
    async executeMultiple(sql: string): Promise<void> {
      await ready;
      await db.exec(sql);
    },
    async close(): Promise<void> {
      await ready;
      await db.close();
    },
  };
}
