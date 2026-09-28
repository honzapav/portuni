// One-time import of the session content that predates the device content
// db (docs/superpowers/specs/2026-09-22-local-sessions-design.md, "The
// content store on the device" and "The central migration"). #456 moves
// every new write of a thread's content -- the transcript, the first
// message, the inline handoff summary -- into this device's `content.db`;
// what a personal workspace wrote before is in its graph db
// (`session_events`, `sessions.brief`, `sessions.handoff_inline`), and
// importGraphDbSessionContentOnce copies it over.
//
// The copy is step 2 of content.db's own version history
// (infra/device-content-db.ts): the version is raised only when every
// thread was copied. A failure anywhere leaves it where it was and the next
// boot tries again. The copy is per thread and each thread is one
// transaction, so a thread is either all here or not at all, and a retry
// skips what an earlier attempt already copied.
//
// It runs BEFORE ensureSchema (#462): migration 040 drops the same table
// and columns, and a boot whose copy did not complete holds that migration
// back (ensureSchemaOn's holdSessionContentDrop), so the graph db keeps the
// content until content.db has it.
//
// A team workspace's sync agent used to download the legacy content its
// older sidecar had sent to the central server; every device did that
// before the central migration dropped it there, and the download is gone
// with it (#462).

import type { DbClient, InStatement } from "../infra/db.js";
import { getDb } from "../infra/db.js";
import { ensureSchema } from "../infra/schema.js";
import { columnExistsSql, normalizeDbTimestamp, tableExistsSql } from "../infra/sql.js";
import { getDeviceContentDb, readDeviceContentSchemaVersion } from "../infra/device-content-db.js";
import type { SessionEventRow } from "../shared/api-types.js";

// The version the content db carries once the copy has run completely.
export const DEVICE_CONTENT_IMPORTED_VERSION = 2;

export interface ContentImportResult {
  // False when the copy had already run (version >= 2) -- the ordinary
  // case on every boot after the first.
  ran: boolean;
  // Rows actually written by THIS call: a thread an earlier attempt already
  // copied counts zero.
  events: number;
  contentRows: number;
  // Threads whose copy failed. Non-zero means the version was not raised.
  failed: number;
}

// One thread's pre-content.db content.
export interface LegacySessionContent {
  session_id: string;
  brief: string | null;
  handoff_inline: string | null;
  events: SessionEventRow[];
}

async function tableExists(db: DbClient, name: string): Promise<boolean> {
  const res = await db.execute({ sql: tableExistsSql(db.dialect), args: [name] });
  return res.rows.length > 0;
}

async function columnExists(db: DbClient, table: string, column: string): Promise<boolean> {
  const res = await db.execute({ sql: columnExistsSql(db.dialect), args: [table, column] });
  return res.rows.length > 0;
}

// Copies one thread in ONE transaction. Idempotent:
//   - its events are skipped when the first of them is already here (the
//     transaction makes "the first is here" mean "all are here");
//   - the content row keeps whatever this device wrote since (COALESCE), so
//     a newer brief or inline summary is never overwritten by the old one.
// A thread that already has events here -- written after the upgrade,
// before an import that failed on an earlier boot finally ran -- keeps them
// after the imported ones: they are shifted above the imported seqs inside
// the same transaction (seq is an order, gaps are fine).
export async function copyLegacySessionContent(
  contentDb: DbClient,
  input: LegacySessionContent,
): Promise<{ events: number; contentRow: boolean }> {
  const id = input.session_id;
  const stmts: InStatement[] = [];

  let copyEvents = input.events.length > 0;
  if (copyEvents) {
    const first = await contentDb.execute({
      sql: "SELECT 1 FROM session_events WHERE id = ?",
      args: [input.events[0].id],
    });
    copyEvents = first.rows.length === 0;
  }
  if (copyEvents) {
    const top = Math.max(...input.events.map((e) => e.seq));
    // Shift by (current max + imported max): every new value is above every
    // old one, so the UPDATE never collides with a row it has not moved yet.
    stmts.push({
      sql: `UPDATE session_events
               SET seq = seq + (SELECT COALESCE(MAX(seq), 0) FROM session_events WHERE session_id = ?) + ?
             WHERE session_id = ?`,
      args: [id, top, id],
    });
    for (const e of input.events) {
      stmts.push({
        sql: `INSERT INTO session_events (id, session_id, run_id, seq, kind, payload, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [e.id, id, e.run_id, e.seq, e.kind, e.payload, normalizeDbTimestamp(e.created_at)],
      });
    }
  }

  let writeContent = false;
  if (input.brief !== null || input.handoff_inline !== null) {
    const existing = await contentDb.execute({
      sql: "SELECT brief, handoff_inline FROM session_content WHERE session_id = ?",
      args: [id],
    });
    const row = existing.rows[0];
    const brief = row?.brief ?? null;
    const inline = row?.handoff_inline ?? null;
    writeContent =
      (brief === null && input.brief !== null) || (inline === null && input.handoff_inline !== null);
  }
  if (writeContent) {
    stmts.push({
      sql: `INSERT INTO session_content (session_id, brief, handoff_inline) VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              brief = COALESCE(session_content.brief, excluded.brief),
              handoff_inline = COALESCE(session_content.handoff_inline, excluded.handoff_inline)`,
      args: [id, input.brief, input.handoff_inline],
    });
  }

  if (stmts.length === 0) return { events: 0, contentRow: false };
  await contentDb.batch(stmts, "write");
  return { events: copyEvents ? input.events.length : 0, contentRow: writeContent };
}

async function markImported(contentDb: DbClient, version: number | null): Promise<void> {
  if (version === null) {
    await contentDb.execute({
      sql: "INSERT INTO device_schema (version) VALUES (?)",
      args: [DEVICE_CONTENT_IMPORTED_VERSION],
    });
  } else {
    await contentDb.execute({
      sql: "UPDATE device_schema SET version = ? WHERE version < ?",
      args: [DEVICE_CONTENT_IMPORTED_VERSION, DEVICE_CONTENT_IMPORTED_VERSION],
    });
  }
}

// Runs the per-thread copies and raises the version only when none failed.
// `list` failing throws (nothing is marked); a thread failing is counted,
// logged and left for the next boot, and the rest still go through.
async function importOnce(
  contentDb: DbClient,
  list: () => Promise<string[]>,
  load: (sessionId: string) => Promise<LegacySessionContent>,
  label: string,
): Promise<ContentImportResult> {
  const version = await readDeviceContentSchemaVersion(contentDb);
  if (version !== null && version >= DEVICE_CONTENT_IMPORTED_VERSION) {
    return { ran: false, events: 0, contentRows: 0, failed: 0 };
  }
  const result: ContentImportResult = { ran: true, events: 0, contentRows: 0, failed: 0 };
  for (const sessionId of await list()) {
    try {
      const copied = await copyLegacySessionContent(contentDb, await load(sessionId));
      result.events += copied.events;
      if (copied.contentRow) result.contentRows++;
    } catch (e) {
      result.failed++;
      console.error(`[boot] ${label}: session ${sessionId} not copied, retried on the next boot:`, e);
    }
  }
  if (result.failed === 0) await markImported(contentDb, version);
  return result;
}

// --- Personal workspace: out of the graph db ------------------------------

export async function importGraphDbSessionContentOnce(
  contentDb: DbClient,
  graphDb: DbClient,
): Promise<ContentImportResult> {
  // Each source is checked explicitly: after the central migration (#462)
  // the table and the two columns are gone, and a workspace past it has
  // nothing to copy. A read that fails for any other reason throws, so the
  // version is not raised over content that was never copied.
  const hasEvents = await tableExists(graphDb, "session_events");
  const hasSessions = await tableExists(graphDb, "sessions");
  const hasBrief = hasSessions && (await columnExists(graphDb, "sessions", "brief"));
  const hasInline = hasSessions && (await columnExists(graphDb, "sessions", "handoff_inline"));

  const list = async (): Promise<string[]> => {
    const ids = new Set<string>();
    if (hasEvents) {
      const res = await graphDb.execute("SELECT DISTINCT session_id FROM session_events");
      for (const r of res.rows) ids.add(String(r.session_id));
    }
    const conds = [...(hasBrief ? ["brief IS NOT NULL"] : []), ...(hasInline ? ["handoff_inline IS NOT NULL"] : [])];
    if (conds.length > 0) {
      const res = await graphDb.execute(`SELECT id FROM sessions WHERE ${conds.join(" OR ")}`);
      for (const r of res.rows) ids.add(String(r.id));
    }
    return [...ids].sort();
  };

  const load = async (sessionId: string): Promise<LegacySessionContent> => {
    const events: SessionEventRow[] = [];
    if (hasEvents) {
      const res = await graphDb.execute({
        sql: "SELECT id, session_id, run_id, seq, kind, payload, created_at FROM session_events WHERE session_id = ? ORDER BY seq",
        args: [sessionId],
      });
      for (const r of res.rows) {
        events.push({
          id: String(r.id),
          session_id: String(r.session_id),
          run_id: r.run_id === null ? null : String(r.run_id),
          seq: Number(r.seq),
          kind: String(r.kind),
          payload: String(r.payload),
          created_at: String(r.created_at),
        });
      }
    }
    let brief: string | null = null;
    let inline: string | null = null;
    const cols = [...(hasBrief ? ["brief"] : []), ...(hasInline ? ["handoff_inline"] : [])];
    if (cols.length > 0) {
      const res = await graphDb.execute({ sql: `SELECT ${cols.join(", ")} FROM sessions WHERE id = ?`, args: [sessionId] });
      const row = res.rows[0];
      if (row && hasBrief && row.brief !== null && row.brief !== undefined) brief = String(row.brief);
      if (row && hasInline && row.handoff_inline !== null && row.handoff_inline !== undefined) {
        inline = String(row.handoff_inline);
      }
    }
    return { session_id: sessionId, brief, handoff_inline: inline, events };
  };

  return importOnce(contentDb, list, load, "session content import");
}

// --- Boot entry points ------------------------------------------------------

function logImport(label: string, r: ContentImportResult): void {
  if (!r.ran) return;
  if (r.events > 0 || r.contentRows > 0) {
    console.log(`[boot] ${label}: ${r.events} event(s), ${r.contentRows} content row(s) copied into content.db`);
  }
  if (r.failed > 0) console.error(`[boot] ${label}: ${r.failed} session(s) failed; the import runs again on the next boot`);
}

// The personal workspace's boot step, shared by both entry points that can
// be one (index.ts standalone, desktop.ts local branch): opens content.db
// and copies the graph db's session content into it, before ensureSchema
// and before the server serves a request. Never fatal -- a failure is
// logged and retried on the next boot. Answers whether content.db now holds
// everything (version >= 2): the caller holds migration 040 back when not.
export async function importPersonalWorkspaceSessionContentOnBoot(): Promise<boolean> {
  try {
    const contentDb = await getDeviceContentDb();
    const result = await importGraphDbSessionContentOnce(contentDb, getDb());
    logImport("session content import", result);
    const version = await readDeviceContentSchemaVersion(contentDb);
    return version !== null && version >= DEVICE_CONTENT_IMPORTED_VERSION;
  } catch (e) {
    console.error("[boot] session content import failed; it runs again on the next boot:", e);
    return false;
  }
}

// The personal workspace's schema step, shared by both entry points that
// can be one (index.ts standalone, desktop.ts local branch): the copy into
// content.db first, then ensureSchema -- whose migration 040 drops that
// content from the graph db, and is held back on a boot whose copy did not
// complete (#462). The central server calls ensureSchema directly.
export async function ensurePersonalWorkspaceSchema(): Promise<void> {
  const contentCopied = await importPersonalWorkspaceSessionContentOnBoot();
  await ensureSchema({ holdSessionContentDrop: !contentCopied });
}
