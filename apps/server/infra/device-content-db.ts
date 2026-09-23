// The device content database (`content.db`), per
// docs/superpowers/specs/2026-09-22-local-sessions-design.md, "The content
// store on the device".
//
// Portuni owns no content: the central server holds the session *record*
// (that a thread exists, on which node, whose it is, its state, runner,
// runs and scope), the device that ran the thread holds the *content*
// (the first message, every transcript event, the inline handoff summary).
// This file is where that content lives on the device -- a second libsql
// file next to `runners.json` in the runner data dir, opened by the
// sidecar in a personal workspace and by the sync agent in a team
// workspace alike. The central server never opens one.
//
// It deliberately does NOT go through `getDb()`, `schema.ts` or
// `MIGRATIONS`:
//   - `getDb()` is the graph db, which a team-workspace device does not
//     have at all;
//   - `MIGRATIONS`/`PG_BASELINE_DDL` are the two-dialect story for the
//     graph db, and this file is libsql on a device, always.
//
// Schema versioning is the `device_schema.version` row and the numbered
// step list below -- never a `MIGRATIONS` entry.
//
// Version history (a bump adds a numbered step here and raises
// DEVICE_CONTENT_SCHEMA_VERSION; every step must be safe to re-run):
//   1. session_content, session_events, device_schema (the DDL below).

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { createLibsqlDbClient } from "./db-libsql.js";
import type { DbClient } from "./db.js";
import { resolveRunnerDataDir } from "../domain/runner/data-dir.js";

export const DEVICE_CONTENT_DB_FILENAME = "content.db";

// Raised together with a new numbered step in the history above.
export const DEVICE_CONTENT_SCHEMA_VERSION = 1;

// The three tables of the content db. No foreign keys: the session id is
// the central server's, and there is no `sessions` table here to point at.
export const DDL_SESSION_CONTENT = `CREATE TABLE IF NOT EXISTS session_content (
    session_id TEXT PRIMARY KEY,
    brief TEXT,
    handoff_inline TEXT
  )`;

// Same shape session_events has in schema.ts today, minus the two foreign
// keys. seq is assigned by domain/runner/store-content.ts, monotonic per
// session, never reused.
export const DDL_SESSION_EVENTS_CONTENT = `CREATE TABLE IF NOT EXISTS session_events (
    id TEXT PRIMARY KEY CHECK(length(id) = 26),
    session_id TEXT NOT NULL,
    run_id TEXT,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, seq)
  )`;

export const DDL_DEVICE_SCHEMA = `CREATE TABLE IF NOT EXISTS device_schema (
    version INTEGER NOT NULL
  )`;

export const DEVICE_CONTENT_DDL = [
  DDL_SESSION_CONTENT,
  DDL_SESSION_EVENTS_CONTENT,
  DDL_DEVICE_SCHEMA,
];

// `content.db` sits next to `runners.json`: PORTUNI_DATA_DIR when set (the
// desktop sidecar and the sync agent both set it), process.cwd() otherwise
// (the standalone server) -- the same rule resolveRunnerDataDir() applies
// to every other piece of device-local state.
export function resolveDeviceContentDbPath(dataDir?: string): string {
  return join(dataDir ?? resolveRunnerDataDir(), DEVICE_CONTENT_DB_FILENAME);
}

// Applies the DDL and makes sure the single device_schema row exists.
// Idempotent: every statement is CREATE TABLE IF NOT EXISTS and the
// version row is only inserted when the table is empty.
export async function ensureDeviceContentSchema(db: DbClient): Promise<void> {
  for (const ddl of DEVICE_CONTENT_DDL) {
    await db.execute(ddl);
  }
  const res = await db.execute("SELECT version FROM device_schema LIMIT 1");
  if (res.rows.length === 0) {
    await db.execute({
      sql: "INSERT INTO device_schema (version) VALUES (?)",
      args: [DEVICE_CONTENT_SCHEMA_VERSION],
    });
  }
}

export async function readDeviceContentSchemaVersion(db: DbClient): Promise<number | null> {
  const res = await db.execute("SELECT version FROM device_schema LIMIT 1");
  if (res.rows.length === 0) return null;
  return Number(res.rows[0].version);
}

// Opens (creating on first use) a content db at an explicit location. The
// caller owns the returned client and closes it; the process-wide one is
// getDeviceContentDb() below.
export async function openDeviceContentDb(dataDir?: string): Promise<DbClient> {
  const path = resolveDeviceContentDbPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = createLibsqlDbClient(createClient({ url: `file:${path}` }));
  await ensureDeviceContentSchema(db);
  return db;
}

// Lazy, idempotent process singleton. Concurrent first callers share the
// one in-flight open rather than racing two CREATE TABLE passes.
let contentDb: DbClient | null = null;
let opening: Promise<DbClient> | null = null;

export async function getDeviceContentDb(): Promise<DbClient> {
  if (contentDb) return contentDb;
  if (!opening) {
    opening = openDeviceContentDb()
      .then((db) => {
        contentDb = db;
        return db;
      })
      .finally(() => {
        opening = null;
      });
  }
  return opening;
}

// Test-only seam, mirroring setDbForTesting(): inject a client (typically
// one openDeviceContentDb() made in a temp dir) or pass null to clear.
export function setDeviceContentDbForTesting(db: DbClient | null): void {
  contentDb = db;
}

export async function closeDeviceContentDb(): Promise<void> {
  const db = contentDb;
  contentDb = null;
  if (db) await db.close();
}
