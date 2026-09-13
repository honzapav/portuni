// DbClient over @electric-sql/pglite (embedded Postgres) -- the local-mode
// driver from B4 onward; introduced here so the interface and its three
// implementations land together (batch B1). Every call site writes `?`
// positional placeholders (libsql's convention); rewritten to `$1, $2, ...`
// here so B3's dialect-neutral SQL pass never has to touch call sites for
// this reason. Named (`Record`) args are never used anywhere in this
// codebase (checked at B1 time) -- only positional arrays are supported.
import { PGlite, type Results } from "@electric-sql/pglite";
import type { DbClient, DbResultSet, DbRow, DbTransactionMode, InStatement, InValue } from "./db.js";
import { rewritePositionalPlaceholders } from "./sql-placeholders.js";

function normalizeStmt(stmt: InStatement): { sql: string; args: InValue[] } {
  if (typeof stmt === "string") return { sql: stmt, args: [] };
  if (stmt.args === undefined) return { sql: stmt.sql, args: [] };
  if (Array.isArray(stmt.args)) return { sql: stmt.sql, args: stmt.args };
  throw new Error("db-pglite: named (object) args are not supported, only positional arrays");
}

function toDbResultSet(res: Results<unknown>): DbResultSet {
  return {
    columns: res.fields.map((f) => f.name),
    rows: res.rows as DbRow[],
    rowsAffected: res.affectedRows ?? 0,
    lastInsertRowid: undefined,
  };
}

export function createPgliteDbClient(dataDir?: string): DbClient {
  const db = new PGlite(dataDir);
  return {
    dialect: "postgres",
    async execute(stmt: InStatement): Promise<DbResultSet> {
      const { sql, args } = normalizeStmt(stmt);
      const res = await db.query(rewritePositionalPlaceholders(sql), args as unknown[]);
      return toDbResultSet(res);
    },
    async batch(stmts: InStatement[], mode?: DbTransactionMode): Promise<DbResultSet[]> {
      void mode; // PGlite's transaction() has no separate read/write/deferred modes.
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
      await db.exec(sql);
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
