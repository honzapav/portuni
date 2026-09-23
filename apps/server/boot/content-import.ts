// One-time import of a personal workspace's session content into the
// device content db (docs/superpowers/specs/2026-09-22-local-sessions-
// design.md, "The content store on the device": "its session_events and
// the two columns in its graph db are dropped by the same migration as
// central's, after a one-time copy into content.db on first boot").
//
// A personal workspace has always stored everything on the device, so its
// history is sitting in the graph db: `session_events`, `sessions.brief`
// and `sessions.handoff_inline`. #456 moves every new write to
// `content.db`; without this copy the existing transcripts would simply
// stop being readable, and the central migration (#462) would drop them.
//
// Idempotent and keyed on `device_schema.version` (the content db's own
// version row, never MIGRATIONS): the copy is step 2 of the content db's
// history, applied once and then recorded. A team-workspace sidecar never
// calls this -- it has no graph db to copy from.

import type { DbClient } from "../infra/db.js";
import { tableExistsSql } from "../infra/sql.js";
import { readDeviceContentSchemaVersion } from "../infra/device-content-db.js";

// The version the content db carries once the copy has run.
export const DEVICE_CONTENT_IMPORTED_VERSION = 2;

export interface ContentImportResult {
  // False when the copy had already run (version >= 2) -- the ordinary
  // case on every boot after the first.
  ran: boolean;
  events: number;
  contentRows: number;
}

async function tableExists(db: DbClient, name: string): Promise<boolean> {
  const res = await db.execute({ sql: tableExistsSql(db.dialect), args: [name] });
  return res.rows.length > 0;
}

export async function importGraphDbSessionContentOnce(
  contentDb: DbClient,
  graphDb: DbClient,
): Promise<ContentImportResult> {
  const version = await readDeviceContentSchemaVersion(contentDb);
  if (version !== null && version >= DEVICE_CONTENT_IMPORTED_VERSION) {
    return { ran: false, events: 0, contentRows: 0 };
  }

  let events = 0;
  // After the central migration (#462) the table is gone; a workspace that
  // upgraded past it has nothing left to copy, which is not an error.
  if (await tableExists(graphDb, "session_events")) {
    const rows = await graphDb.execute(
      "SELECT id, session_id, run_id, seq, kind, payload, created_at FROM session_events ORDER BY session_id, seq",
    );
    for (const r of rows.rows) {
      // The transcript keeps its ids and seqs: INSERT OR IGNORE-shaped
      // semantics through the UNIQUE(session_id, seq) index, so a copy
      // interrupted halfway resumes without duplicating a row.
      await contentDb.execute({
        sql: `INSERT INTO session_events (id, session_id, run_id, seq, kind, payload, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM session_events WHERE session_id = ? AND seq = ?)`,
        args: [
          String(r.id),
          String(r.session_id),
          r.run_id === null ? null : String(r.run_id),
          Number(r.seq),
          String(r.kind),
          String(r.payload),
          String(r.created_at),
          String(r.session_id),
          Number(r.seq),
        ],
      });
      events++;
    }
  }

  let contentRows = 0;
  if (await tableExists(graphDb, "sessions")) {
    // #462 drops both columns; a workspace already past it selects nothing
    // rather than failing the boot.
    const rows = await graphDb
      .execute("SELECT id, brief, handoff_inline FROM sessions WHERE brief IS NOT NULL OR handoff_inline IS NOT NULL")
      .catch(() => null);
    for (const r of rows?.rows ?? []) {
      await contentDb.execute({
        sql: `INSERT INTO session_content (session_id, brief, handoff_inline) VALUES (?, ?, ?)
              ON CONFLICT(session_id) DO NOTHING`,
        args: [
          String(r.id),
          r.brief === null ? null : String(r.brief),
          r.handoff_inline === null ? null : String(r.handoff_inline),
        ],
      });
      contentRows++;
    }
  }

  if (version === null) {
    await contentDb.execute({
      sql: "INSERT INTO device_schema (version) VALUES (?)",
      args: [DEVICE_CONTENT_IMPORTED_VERSION],
    });
  } else {
    await contentDb.execute({
      sql: "UPDATE device_schema SET version = ?",
      args: [DEVICE_CONTENT_IMPORTED_VERSION],
    });
  }
  return { ran: true, events, contentRows };
}
