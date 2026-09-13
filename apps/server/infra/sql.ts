// Dialect-neutral SQL fragment helpers (batch B3,
// docs/superpowers/plans/2026-09-12-infra-batch.md). Every call site keeps
// writing `?` positional placeholders (the driver rewrites them, B1) and
// keeps passing `{sql, args}` objects the same way as always -- these
// helpers only replace the handful of SQLite-specific constructs
// (`datetime('now')`, `json_extract`, `INSERT OR IGNORE`) with whichever
// text is correct for the caller's own `DbClient.dialect`, so the same
// query source works against libsql and pg/PGlite alike.
import type { DbDialect } from "./db.js";

// `datetime('now')` (SQLite) vs `CURRENT_TIMESTAMP` (Postgres) -- both
// interpolate directly into a SQL string wherever "right now" is needed
// inside an INSERT/UPDATE, not just a DEFAULT clause (those are schema-time
// and already handled per-dialect in schema.ts vs schema.pg.ts).
export function nowExpr(dialect: DbDialect): string {
  return dialect === "postgres" ? "CURRENT_TIMESTAMP" : "datetime('now')";
}

// json_extract(col, '$.key') (SQLite) vs (col::jsonb ->> 'key') (Postgres).
// `key` is always a bare top-level JSON key in this codebase -- no call
// site extracts a nested or array path, so this never needs to build a
// full JSONPath string.
export function jsonField(dialect: DbDialect, column: string, key: string): string {
  return dialect === "postgres" ? `(${column}::jsonb ->> '${key}')` : `json_extract(${column}, '$.${key}')`;
}

// Rewrites a SQL string's own `INSERT OR IGNORE INTO ...` (SQLite) into
// `INSERT INTO ... ON CONFLICT DO NOTHING` (Postgres) -- a bare
// `ON CONFLICT DO NOTHING` with no target ignores ANY constraint
// violation, the same "any conflict, no error" semantics `OR IGNORE`
// already has, so no caller needs to name its conflicting column(s).
// Call sites keep writing the SQLite form as their SQL source and wrap it
// through this function once; a no-op on the libsql path.
export function insertIgnore(dialect: DbDialect, sql: string): string {
  if (dialect !== "postgres") return sql;
  return `${sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO")} ON CONFLICT DO NOTHING`;
}

// A recursive CTE's seed, expanding a JSON array parameter (`args: [JSON
// .stringify(ids)]`) into one row per string element -- SQLite's
// `json_each(?)` (a table-valued function; its `value` column is what the
// caller's own SELECT list names) vs Postgres's `jsonb_array_elements_text`
// (returns a bare setof text, so the FROM-clause alias itself names the
// single column -- `AS value` makes `SELECT value` work the same way on
// both sides). Callers write `FROM ${jsonArrayElementsText(db.dialect)}` in
// place of a literal `json_each(?)`.
export function jsonArrayElementsText(dialect: DbDialect, placeholder = "?"): string {
  return dialect === "postgres"
    ? `jsonb_array_elements_text(${placeholder}::jsonb) AS value`
    : `json_each(${placeholder})`;
}

// Not one of the plan's named constructs, but the same class of problem:
// error-shape detection that only ever matched libsql's own error text.
// Both libsql (`LibsqlError.code`) and pg/PGlite (`DatabaseError.code`,
// the raw SQLSTATE) attach a `.code`, so both are detectable without
// knowing in advance which dialect raised the error.
const PG_UNIQUE_VIOLATION = "23505";

// Was this error a UNIQUE constraint violation? Narrow on purpose: a
// caller using this already knows which single UNIQUE column its own
// statement could possibly collide on (there is exactly one candidate),
// so "any unique violation" is precise enough without parsing out which
// column/constraint.
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === PG_UNIQUE_VIOLATION) return true;
  return err.message.includes("UNIQUE constraint failed");
}

// A friendly message for a DB-level constraint/trigger rejection --
// SQLite's `RAISE(ABORT, 'msg')` or Postgres's `RAISE EXCEPTION 'msg'`
// (P0001) and the unique/check/fk/not-null violation classes (Postgres
// SQLSTATE 23xxx) -- or null when `err` isn't one of those, so the caller
// can fall through to a generic response. Postgres's own error message is
// already the trigger's raw text (or a reasonably readable constraint
// message); libsql wraps it as "SQLite error: <text>", so that shape still
// needs the regex extraction it always has.
export function constraintViolationMessage(err: Error): string | null {
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && (code === "P0001" || /^23\d{3}$/.test(code))) {
    return err.message;
  }
  if (err.message.includes("SQLITE_CONSTRAINT")) {
    const m = err.message.match(/SQLite error:\s*([^\n]+)/);
    return m ? m[1].trim() : "constraint violation";
  }
  return null;
}
