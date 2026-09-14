// DbClient over a real libsql Client (Turso, or a local file: db) -- close
// to a passthrough, since DbClient's shape was modeled on libsql's own
// Client in the first place (batch B1). The one adaptation: libsql's `Row`
// is a hybrid array/object; DbClient's contract is plain objects, so rows
// are shallow-copied on the way out.
import type { Client, ResultSet } from "@libsql/client";
import type { DbClient, DbResultSet, DbRow, DbTransactionMode, InStatement } from "./db.js";

function toDbResultSet(rs: ResultSet): DbResultSet {
  return {
    columns: rs.columns,
    rows: rs.rows.map((row) => ({ ...(row as unknown as Record<string, unknown>) }) as DbRow),
    rowsAffected: rs.rowsAffected,
    lastInsertRowid: rs.lastInsertRowid,
  };
}

export function createLibsqlDbClient(client: Client): DbClient {
  return {
    dialect: "sqlite",
    async execute(stmt: InStatement): Promise<DbResultSet> {
      return toDbResultSet(await client.execute(stmt));
    },
    async batch(stmts: InStatement[], mode?: DbTransactionMode): Promise<DbResultSet[]> {
      const results = await client.batch(stmts, mode);
      return results.map(toDbResultSet);
    },
    async executeMultiple(sql: string): Promise<void> {
      await client.executeMultiple(sql);
    },
    close(): void {
      client.close();
    },
  };
}
