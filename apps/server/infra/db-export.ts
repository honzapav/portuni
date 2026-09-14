// Postgres cutover, batch B5 (docs/superpowers/plans/2026-09-12-infra-batch.md):
// central data leaves Turso once, every local workspace leaves its SQLite
// once, same tool both ways. Exports every table's rows to one JSON file
// per table, in a fixed row order (by primary key) so two exports of
// unchanged data produce byte-identical output. Dialect-agnostic on
// purpose: works against any DbClient (a Turso/libsql source or a
// Postgres/PGlite one) since it only ever runs `SELECT * FROM t ORDER BY
// <pk>` -- no dialect-specific SQL.
//
// `migrations` is deliberately NOT one of the exported tables: its rows are
// dialect-specific bookkeeping (libsql's "NNN_name" ids vs Postgres's
// "pg-NNN"), not user data. The import target already has its own correct
// migrations state from having the baseline applied before import ever
// runs (see docs/runbooks/postgres-cutover.md) -- importing the source's
// raw ids would just pollute it with meaningless entries. The source's own
// applied migration ids are recorded in the manifest purely for reference.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DbClient, DbRow } from "./db.js";

// Topological (FK-safe) order -- the same order schema.pg.ts's
// PG_BASELINE_DDL creates tables in. Every table a fresh install of either
// dialect has as of migration 035 / pg-001, except `migrations` itself.
export const TABLE_ORDER: readonly string[] = [
  "users",
  "nodes",
  "device_tokens",
  "node_access",
  "access_requests",
  "oauth_grants",
  "oauth_codes",
  "sessions",
  "session_runs",
  "session_events",
  "session_scope",
  "edges",
  "audit_log",
  "pending_file_ops",
  "files",
  "events",
  "remotes",
  "remote_routing",
  "actors",
  "responsibilities",
  "responsibility_assignments",
  "data_sources",
  "tools",
];

// Deterministic row order per table -- primary key column(s), in the same
// order each table's own CREATE TABLE declares the PK.
export const ORDER_BY: Readonly<Record<string, string>> = {
  users: "id",
  nodes: "id",
  device_tokens: "id",
  node_access: "node_id, kind, principal",
  access_requests: "id",
  oauth_grants: "id",
  oauth_codes: "id",
  sessions: "id",
  session_runs: "id",
  session_events: "session_id, seq",
  session_scope: "session_id, node_id",
  edges: "id",
  audit_log: "id",
  pending_file_ops: "id",
  files: "id",
  events: "id",
  remotes: "name",
  remote_routing: "id",
  actors: "id",
  responsibilities: "id",
  responsibility_assignments: "responsibility_id, actor_id",
  data_sources: "id",
  tools: "id",
};

export interface TableManifestEntry {
  rows: number;
  sha256: string;
}

export interface ExportManifest {
  exported_at: string;
  dialect: string;
  tables: Record<string, TableManifestEntry>;
  // Reference only -- see the file header for why these are never imported.
  source_migrations: string[];
}

// Content checksum, independent of any incidental JSON.stringify spacing
// differences a future refactor might introduce -- a caller comparing two
// exports should compare this, not the raw file bytes.
function checksumOf(rows: DbRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export async function exportTable(db: DbClient, table: string): Promise<DbRow[]> {
  const orderBy = ORDER_BY[table];
  if (!orderBy) throw new Error(`db-export: no ORDER BY configured for table "${table}"`);
  const res = await db.execute(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
  return res.rows;
}

export async function exportDb(db: DbClient, outDir: string): Promise<ExportManifest> {
  // The dump carries everything the database does -- audit_log, e-mail
  // addresses, session transcripts -- so it is owner-readable only, the
  // directory included (mkdir's mode applies to the leaf it creates).
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const tables: Record<string, TableManifestEntry> = {};
  for (const table of TABLE_ORDER) {
    const rows = await exportTable(db, table);
    await writeFile(join(outDir, `${table}.json`), JSON.stringify(rows, null, 2), { mode: 0o600 });
    tables[table] = { rows: rows.length, sha256: checksumOf(rows) };
  }

  let sourceMigrations: string[] = [];
  try {
    const m = await db.execute("SELECT id FROM migrations ORDER BY id");
    sourceMigrations = m.rows.map((r) => String(r.id));
  } catch {
    // No migrations table at all -- an ancient pre-tracking DB. Not fatal;
    // the export itself is still complete and usable.
  }

  const manifest: ExportManifest = {
    exported_at: new Date().toISOString(),
    dialect: db.dialect,
    tables,
    source_migrations: sourceMigrations,
  };
  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}
