// DbClient over `pg` (managed Postgres) -- the central-server driver from
// B4 onward; introduced here alongside db-pglite.ts so every driver lands
// in one step (batch B1). Not exercised against a live server by the
// automated gate (CI adds no services, per the infra batch plan's global
// constraints) -- covered by the same placeholder-rewrite/arg-normalizing
// unit tests db-pglite.ts's pure helpers get, and by a real Postgres
// deployment once central cuts over (B4/B5).
import { Pool, type QueryResult } from "pg";
import type { DbClient, DbResultSet, DbRow, DbTransactionMode, InStatement, InValue } from "./db.js";
import { rewritePositionalPlaceholders } from "./sql-placeholders.js";

function normalizeStmt(stmt: InStatement): { sql: string; args: InValue[] } {
  if (typeof stmt === "string") return { sql: stmt, args: [] };
  if (stmt.args === undefined) return { sql: stmt.sql, args: [] };
  if (Array.isArray(stmt.args)) return { sql: stmt.sql, args: stmt.args };
  throw new Error("db-pg: named (object) args are not supported, only positional arrays");
}

function toDbResultSet(res: QueryResult): DbResultSet {
  return {
    columns: res.fields.map((f) => f.name),
    rows: res.rows as DbRow[],
    rowsAffected: res.rowCount ?? 0,
    lastInsertRowid: undefined,
  };
}

export function createPgDbClient(connectionString: string): DbClient {
  const pool = new Pool({ connectionString });
  return {
    async execute(stmt: InStatement): Promise<DbResultSet> {
      const { sql, args } = normalizeStmt(stmt);
      const res = await pool.query(rewritePositionalPlaceholders(sql), args);
      return toDbResultSet(res);
    },
    async batch(stmts: InStatement[], mode?: DbTransactionMode): Promise<DbResultSet[]> {
      void mode; // pg's BEGIN/COMMIT has no separate read/write/deferred modes.
      const conn = await pool.connect();
      try {
        await conn.query("BEGIN");
        const out: DbResultSet[] = [];
        try {
          for (const stmt of stmts) {
            const { sql, args } = normalizeStmt(stmt);
            const res = await conn.query(rewritePositionalPlaceholders(sql), args);
            out.push(toDbResultSet(res));
          }
          await conn.query("COMMIT");
        } catch (err) {
          await conn.query("ROLLBACK");
          throw err;
        }
        return out;
      } finally {
        conn.release();
      }
    },
    async executeMultiple(sql: string): Promise<void> {
      const conn = await pool.connect();
      try {
        await conn.query(sql);
      } finally {
        conn.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
