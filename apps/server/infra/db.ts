// The single dialect-neutral client interface every domain/api/mcp file is
// written against (batch B, docs/superpowers/plans/2026-09-12-infra-batch.md,
// B1). `DbClient` is deliberately close to libsql's own `Client` shape
// (execute/batch/executeMultiple/close, `InStatement`/`InValue`/`InArgs`
// keep their libsql names) so this step touches only type imports and the
// two places that used to call `createClient` directly -- every SQL text
// call site (`db.execute({sql, args})`, `db.batch([...], mode)`) is
// unchanged. `db-libsql.ts` wraps a real libsql `Client`; `db-pglite.ts`
// (embedded Postgres, local mode) and `db-pg.ts` (managed Postgres,
// central) are added in this same step but only `PORTUNI_DATABASE_URL`
// opts into them -- everything that doesn't set it keeps today's
// `TURSO_URL`-driven libsql path. One difference from libsql's own `Row`
// type: `rows` here are plain objects (`Record<string, DbValue>`), not
// libsql's hybrid array/object `Row` -- the pg/PGlite drivers only ever
// produce plain objects, so this is what every consumer can rely on
// regardless of which driver answered the query.

import { createClient as createLibsqlClient } from "@libsql/client";
import { createLibsqlDbClient } from "./db-libsql.js";
import { createPgliteDbClient } from "./db-pglite.js";
import { createPgDbClient } from "./db-pg.js";

export type DbValue = null | string | number | bigint | ArrayBuffer;
export type InValue = DbValue | boolean | Uint8Array | Date;
export type InArgs = Array<InValue> | Record<string, InValue>;
export type InStatement = { sql: string; args?: InArgs } | string;
export type DbRow = Record<string, DbValue>;

export interface DbResultSet {
  columns: string[];
  rows: DbRow[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}

export type DbTransactionMode = "write" | "read" | "deferred";

// SQLite-family (libsql) vs Postgres-family (pg/PGlite) -- the only thing
// ensureSchemaOn (B2, schema.ts) needs to pick which baseline/migration
// path applies. Everything else about DbClient is dialect-neutral by
// design; this is the one deliberate exception, since schema application
// itself cannot be (two genuinely different DDL dialects, not just two
// wire protocols).
export type DbDialect = "sqlite" | "postgres";

export interface DbClient {
  readonly dialect: DbDialect;
  execute(stmt: InStatement): Promise<DbResultSet>;
  batch(stmts: InStatement[], mode?: DbTransactionMode): Promise<DbResultSet[]>;
  executeMultiple(sql: string): Promise<void>;
  close(): void | Promise<void>;
}

let client: DbClient | null = null;

const PGLITE_URL_PREFIX = "pglite:";

function createDbClientFromEnv(): DbClient {
  const databaseUrl = process.env.PORTUNI_DATABASE_URL?.trim();
  if (databaseUrl?.startsWith("postgres://") || databaseUrl?.startsWith("postgresql://")) {
    return createPgDbClient(databaseUrl);
  }
  if (databaseUrl?.startsWith(PGLITE_URL_PREFIX)) {
    const dir = databaseUrl.slice(PGLITE_URL_PREFIX.length);
    return createPgliteDbClient(dir === "" ? undefined : dir);
  }
  // file:/libsql: (explicit via PORTUNI_DATABASE_URL, or the legacy
  // TURSO_URL/default path) -- libsql for this step only (B4 retires it).
  const url = databaseUrl || process.env.TURSO_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url) {
    return createLibsqlDbClient(createLibsqlClient({ url, authToken }));
  }
  return createLibsqlDbClient(createLibsqlClient({ url: "file:./portuni.db" }));
}

export function getDb(): DbClient {
  if (!client) {
    client = createDbClientFromEnv();
  }
  return client;
}

// Test-only seam. Lets smoke tests inject an in-memory client so they
// don't pollute the file-backed singleton. Pass null to clear and let
// the next getDb() call recreate from env.
export function setDbForTesting(c: DbClient | null): void {
  client = c;
}
