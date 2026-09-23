// SessionContentStore -- the device's half of a thread, per
// docs/superpowers/specs/2026-09-22-local-sessions-design.md ("The content
// store on the device"). Backed by `content.db`
// (infra/device-content-db.ts) in a personal workspace and in a team
// workspace alike, so there is one code path for content no matter where
// the *record* lives.
//
// What lives here: the transcript (`session_events`), the first message
// (`session_content.brief`) and the inline handoff summary
// (`session_content.handoff_inline`). Everything else about a thread --
// state, runner, instance, runs, scope -- is the record store's
// (`SessionStore` in ./store.ts), which is the central server's in a team
// workspace.
//
// The runtime (#456) routes every event append, every event read and both
// content columns here, in both workspaces; the record store carries none
// of them.

import { ulid } from "ulid";
import { z } from "zod";
import { getDeviceContentDb } from "../../infra/device-content-db.js";
import { getDb } from "../../infra/db.js";
import { dbTimestamp } from "../../infra/sql.js";
import { isCentralServer } from "../../infra/server-config.js";
import type { DbClient, InStatement, InValue } from "../../infra/db.js";
import type { SessionEventRow } from "../../shared/api-types.js";
import type { CanonicalEvent } from "./types.js";

// --- Payload caps (runner spec: "Payload caps") --------------------------

const MAX_ASSISTANT_TEXT_BYTES = 64 * 1024;
const MAX_OUTPUT_EXCERPT_BYTES = 8 * 1024;
const MAX_INPUT_SUMMARY_BYTES = 1024;

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true };
}

// Applies the caps from the runner spec's Events table. Returns a new
// event; never mutates the input. Only assistant_message.text and
// tool_call's output_excerpt/input_summary carry a cap -- every other
// kind's payload is already bounded by what produces it (a title, a path,
// a short reason).
export function capEventPayload(event: CanonicalEvent): CanonicalEvent {
  if (event.kind === "assistant_message") {
    return {
      kind: "assistant_message",
      payload: { text: truncateUtf8(event.payload.text, MAX_ASSISTANT_TEXT_BYTES).text },
    };
  }
  if (event.kind === "tool_call") {
    const p = event.payload;
    let truncated = p.truncated;
    let outputExcerpt = p.output_excerpt;
    if (outputExcerpt !== null) {
      const capped = truncateUtf8(outputExcerpt, MAX_OUTPUT_EXCERPT_BYTES);
      outputExcerpt = capped.text;
      truncated = truncated || capped.truncated;
    }
    const cappedInput = truncateUtf8(p.input_summary, MAX_INPUT_SUMMARY_BYTES);
    return {
      kind: "tool_call",
      payload: { ...p, output_excerpt: outputExcerpt, input_summary: cappedInput.text, truncated },
    };
  }
  return event;
}

// --- Row validators -------------------------------------------------------

export const SessionEventRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  run_id: z.union([z.string(), z.null()]),
  seq: z.number(),
  kind: z.string(),
  payload: z.string(),
  created_at: z.string(),
}) satisfies z.ZodType<SessionEventRow>;

export type SessionContentRow = {
  session_id: string;
  brief: string | null;
  handoff_inline: string | null;
};

const SessionContentRowSchema = z.object({
  session_id: z.string(),
  brief: z.union([z.string(), z.null()]),
  handoff_inline: z.union([z.string(), z.null()]),
}) satisfies z.ZodType<SessionContentRow>;

// Only the keys present are written; an absent key leaves the column as it
// was, an explicit null clears it.
export interface SetSessionContentInput {
  brief?: string | null;
  handoff_inline?: string | null;
}

export interface ListEventsOptions {
  after?: number;
  limit?: number;
}

// The content db is opened asynchronously (infra/device-content-db.ts's
// getDeviceContentDb), while the composition roots that build a runtime
// are synchronous -- so a resolver is accepted as well as a client, and
// every method awaits it. Resolving on each call is what keeps
// setDeviceContentDbForTesting() able to swap the db under a long-lived
// store.
export type SessionContentDb = DbClient | (() => DbClient | Promise<DbClient>);

export class SessionContentStore {
  private readonly resolve: () => DbClient | Promise<DbClient>;

  constructor(db: SessionContentDb) {
    this.resolve = typeof db === "function" ? db : () => db;
  }

  protected db(): DbClient | Promise<DbClient> {
    return this.resolve();
  }

  // seq is assigned inside this one transaction: each INSERT's own
  // COALESCE(MAX(seq),0)+1 subquery sees every row the prior statement in
  // this same batch already inserted, so two events in one call get
  // consecutive seqs without a round trip back into JS between them, and
  // two concurrent appendEvents calls on the same session cannot assign
  // the same seq -- db.batch runs as one transaction, serializing against
  // any other writer.
  async appendEvents(
    sessionId: string,
    runId: string | null,
    events: CanonicalEvent[],
  ): Promise<number[]> {
    if (events.length === 0) return [];
    const now = dbTimestamp();
    const ids = events.map(() => ulid());
    const stmts: InStatement[] = events.map((event, i) => {
      const capped = capEventPayload(event);
      return {
        sql: `INSERT INTO session_events (id, session_id, run_id, seq, kind, payload, created_at)
              SELECT ?, ?, ?, COALESCE((SELECT MAX(seq) FROM session_events WHERE session_id = ?), 0) + 1, ?, ?, ?`,
        args: [ids[i], sessionId, runId, sessionId, capped.kind, JSON.stringify(capped.payload), now],
      };
    });
    await (await this.db()).batch(stmts, "write");

    const placeholders = ids.map(() => "?").join(",");
    const res = await (await this.db()).execute({
      sql: `SELECT id, seq FROM session_events WHERE session_id = ? AND id IN (${placeholders})`,
      args: [sessionId, ...ids],
    });
    const seqById = new Map(res.rows.map((r) => [String(r.id), Number(r.seq)]));
    return ids.map((id) => {
      const seq = seqById.get(id);
      if (seq === undefined) throw new Error(`appendEvents: event ${id} not found after insert`);
      return seq;
    });
  }

  async listEvents(sessionId: string, opts: ListEventsOptions = {}): Promise<SessionEventRow[]> {
    const conds = ["session_id = ?"];
    const args: InValue[] = [sessionId];
    if (opts.after !== undefined) {
      conds.push("seq > ?");
      args.push(opts.after);
    }
    let sql = `SELECT id, session_id, run_id, seq, kind, payload, created_at FROM session_events
               WHERE ${conds.join(" AND ")} ORDER BY seq ASC`;
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      args.push(opts.limit);
    }
    const res = await (await this.db()).execute({ sql, args });
    return res.rows.map((r) => SessionEventRowSchema.parse(r));
  }

  async getContent(sessionId: string): Promise<SessionContentRow | null> {
    const res = await (await this.db()).execute({
      sql: "SELECT session_id, brief, handoff_inline FROM session_content WHERE session_id = ?",
      args: [sessionId],
    });
    if (res.rows.length === 0) return null;
    return SessionContentRowSchema.parse(res.rows[0]);
  }

  // Upsert: the row is created on first write, and only the keys the
  // caller passed are touched -- promoteDraftAndStart writes `brief`,
  // suspend writes `handoff_inline`, neither clobbers the other.
  async setContent(sessionId: string, input: SetSessionContentInput): Promise<SessionContentRow> {
    const sets: string[] = [];
    const args: InValue[] = [sessionId, input.brief ?? null, input.handoff_inline ?? null];
    if (input.brief !== undefined) sets.push("brief = excluded.brief");
    if (input.handoff_inline !== undefined) sets.push("handoff_inline = excluded.handoff_inline");
    const onConflict =
      sets.length === 0
        ? "DO NOTHING"
        : `DO UPDATE SET ${sets.join(", ")}`;
    await (await this.db()).execute({
      sql: `INSERT INTO session_content (session_id, brief, handoff_inline) VALUES (?, ?, ?)
            ON CONFLICT(session_id) ${onConflict}`,
      args,
    });
    const row = await this.getContent(sessionId);
    if (!row) throw new Error(`setContent: ${sessionId} not found after upsert`);
    return row;
  }

  // Everything this device holds for the thread: the content row and its
  // transcript. There is no backup of either (spec, "Principle").
  async deleteContent(sessionId: string): Promise<void> {
    await (await this.db()).batch(
      [
        { sql: "DELETE FROM session_events WHERE session_id = ?", args: [sessionId] },
        { sql: "DELETE FROM session_content WHERE session_id = ?", args: [sessionId] },
      ],
      "write",
    );
  }
}

// The central server's content: the legacy graph-db rows only. A sidecar
// released before #456 still sends its transcript (POST /sessions/:id/events)
// and its brief/inline summary (the record routes) to the central server and
// reads them back from there (GET /sessions/:id/events, resume-info), so on
// the central server those reads and writes go to the SAME rows: the graph
// db's `session_events` (same shape as content.db's, so the event methods
// are inherited unchanged) and the `sessions.brief` / `sessions.handoff_inline`
// columns. It is also what a sync agent downloads on its first boot
// (boot/content-import.ts). The central migration (#462) drops all three.
export class LegacyGraphContentStore extends SessionContentStore {
  override async getContent(sessionId: string): Promise<SessionContentRow | null> {
    const res = await (await this.db()).execute({
      sql: "SELECT id AS session_id, brief, handoff_inline FROM sessions WHERE id = ?",
      args: [sessionId],
    });
    if (res.rows.length === 0) return null;
    const row = SessionContentRowSchema.parse(res.rows[0]);
    return row.brief === null && row.handoff_inline === null ? null : row;
  }

  override async setContent(sessionId: string, input: SetSessionContentInput): Promise<SessionContentRow> {
    const sets: string[] = [];
    const args: InValue[] = [];
    if (input.brief !== undefined) {
      sets.push("brief = ?");
      args.push(input.brief);
    }
    if (input.handoff_inline !== undefined) {
      sets.push("handoff_inline = ?");
      args.push(input.handoff_inline);
    }
    if (sets.length > 0) {
      await (await this.db()).execute({ sql: `UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, args: [...args, sessionId] });
    }
    return (await this.getContent(sessionId)) ?? { session_id: sessionId, brief: null, handoff_inline: null };
  }

  override async deleteContent(sessionId: string): Promise<void> {
    await (await this.db()).batch(
      [
        { sql: "DELETE FROM session_events WHERE session_id = ?", args: [sessionId] },
        { sql: "UPDATE sessions SET brief = NULL, handoff_inline = NULL WHERE id = ?", args: [sessionId] },
      ],
      "write",
    );
  }
}

// The device's own content store over content.db -- what the device-only
// composition roots (the sync agent's runtime and run sweep) bind to.
// getDeviceContentDb() is async and opens the file lazily while those roots
// are synchronous, so the resolver is what is handed over; a test swapping
// the db through setDeviceContentDbForTesting() is picked up by the next
// call either way.
let deviceStore: SessionContentStore | null = null;

export function deviceSessionContentStore(): SessionContentStore {
  if (!deviceStore) deviceStore = new SessionContentStore(() => getDeviceContentDb());
  return deviceStore;
}

// The content store of THIS process, for code that runs in the standalone
// server as well as on a device (the local runtime, resume-info, the
// transport's and the boot sweep's suspend): content.db on a device, the
// legacy graph-db rows on the central server, which never opens a
// content.db. Decided per call, so a test flipping PORTUNI_AUTH_MODE is
// honoured.
let legacyStore: LegacyGraphContentStore | null = null;

export function sessionContentStoreForProcess(): SessionContentStore {
  if (!isCentralServer()) return deviceSessionContentStore();
  if (!legacyStore) legacyStore = new LegacyGraphContentStore(() => getDb());
  return legacyStore;
}
