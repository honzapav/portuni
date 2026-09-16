// Persistence for the runner batch's task model (docs/superpowers/specs/
// 2026-09-12-runner-and-session-design.md, "Model" and "Storage"):
// session_runs (one row per attempt to run a session's task) and
// session_events (the append-only canonical record the chat renders from).
//
// SessionStore is the interface session-runtime.ts (a later issue) is
// written against -- "one implementation" (rule 1) means the runtime never
// talks SQL directly; local mode binds it to DbSessionStore, central mode
// to a thin HTTP client against the same shape (CentralSessionStore,
// #323). Session row mutation (create/rename/state transitions) still goes
// through domain/sessions.ts, which already owns naming and the state
// machine -- DbSessionStore.createSession/patchSession are thin wrappers
// over it, not a second writer.

import { ulid } from "ulid";
import type { DbClient, InStatement, InValue } from "../../infra/db.js";
import { z } from "zod";
import {
  createSession as createSessionRow,
  getSession as getSessionRow,
  transitionSessionState,
} from "../sessions.js";
import type { SessionRow, SessionState } from "../../shared/types.js";
import type { SessionRunRow, SessionEventRow } from "../../shared/api-types.js";
import type { CanonicalEvent, RunEndReason } from "./types.js";

// SessionRunRow/SessionEventRow are defined in shared/api-types.ts (so the
// web can type the REST responses without importing server domain code);
// re-exported here so existing call sites importing them from this module
// keep working unchanged.
export type { SessionRunRow, SessionEventRow } from "../../shared/api-types.js";

// --- Payload caps (spec: "Payload caps") ---------------------------------

const MAX_ASSISTANT_TEXT_BYTES = 64 * 1024;
const MAX_OUTPUT_EXCERPT_BYTES = 8 * 1024;
const MAX_INPUT_SUMMARY_BYTES = 1024;

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true };
}

// Applies the caps from the spec's Events table. Returns a new event; never
// mutates the input. Only assistant_message.text and tool_call's
// output_excerpt/input_summary carry a cap -- every other kind's payload is
// already bounded by what produces it (a title, a path, a short reason).
function capEventPayload(event: CanonicalEvent): CanonicalEvent {
  if (event.kind === "assistant_message") {
    return { kind: "assistant_message", payload: { text: truncateUtf8(event.payload.text, MAX_ASSISTANT_TEXT_BYTES).text } };
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

// --- Row validators (runtime shape check for what comes back off the DB;
// the TS types themselves live in shared/api-types.ts, re-exported above) --

const SessionRunRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  runner: z.string(),
  instance_id: z.union([z.string(), z.null()]),
  host_id: z.union([z.string(), z.null()]),
  agent_session_id: z.union([z.string(), z.null()]),
  resumed_from_run_id: z.union([z.string(), z.null()]),
  started_at: z.string(),
  ended_at: z.union([z.string(), z.null()]),
  end_reason: z.union([
    z.enum(["completed", "interrupted", "suspended", "error", "limit", "host_lost"]),
    z.null(),
  ]),
  usage: z.union([z.string(), z.null()]),
}) satisfies z.ZodType<SessionRunRow>;

const SessionEventRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  run_id: z.union([z.string(), z.null()]),
  seq: z.number(),
  kind: z.string(),
  payload: z.string(),
  created_at: z.string(),
}) satisfies z.ZodType<SessionEventRow>;

// --- SessionStore interface -----------------------------------------------

export interface CreateRunnerSessionInput {
  node_id: string | null;
  user_id: string;
  brief: string | null;
  runner: string;
  instance_id: string | null;
  host_id: string | null;
}

export interface PatchSessionInput {
  state?: SessionState;
  waiting_since?: string | null;
  name?: string;
  handoff_path?: string | null;
  handoff_hash?: string | null;
  // Set together with state: "running" when promoting a draft (#374) --
  // the draft had none of these chosen up front.
  brief?: string;
  runner?: string;
  instance_id?: string | null;
  // Set together with name when the promotion derives it from the first
  // message (#374, "Naming") -- protects it the same way a manual rename
  // does, so a later handoff-title enrichment at suspend never overwrites
  // the user's own words.
  name_is_custom?: boolean;
}

export interface CreateRunInput {
  session_id: string;
  runner: string;
  instance_id: string | null;
  host_id: string | null;
  agent_session_id?: string | null;
  resumed_from_run_id?: string | null;
}

export interface PatchRunInput {
  ended_at?: string;
  end_reason?: RunEndReason;
  agent_session_id?: string | null;
  usage?: unknown;
}

export interface ListEventsOptions {
  after?: number;
  limit?: number;
}

export interface SessionStore {
  createSession(input: CreateRunnerSessionInput): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  patchSession(id: string, patch: PatchSessionInput): Promise<SessionRow>;
  createRun(input: CreateRunInput): Promise<SessionRunRow>;
  patchRun(runId: string, patch: PatchRunInput): Promise<SessionRunRow>;
  listRuns(sessionId: string): Promise<SessionRunRow[]>;
  liveRun(sessionId: string): Promise<SessionRunRow | null>;
  appendEvents(sessionId: string, runId: string | null, events: CanonicalEvent[]): Promise<number[]>;
  listEvents(sessionId: string, opts?: ListEventsOptions): Promise<SessionEventRow[]>;
}

// --- DbSessionStore: the local-mode implementation over libsql -----------

export class DbSessionStore implements SessionStore {
  constructor(private readonly db: DbClient) {}

  async createSession(input: CreateRunnerSessionInput): Promise<SessionRow> {
    return createSessionRow(this.db, input.user_id, {
      node_id: input.node_id,
      session_type: "interactive_task",
      brief: input.brief,
      runner: input.runner,
      instance_id: input.instance_id,
      host_id: input.host_id,
    });
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return getSessionRow(this.db, id);
  }

  async patchSession(id: string, patch: PatchSessionInput): Promise<SessionRow> {
    if (patch.state !== undefined) {
      const existing = await getSessionRow(this.db, id);
      if (!existing) throw new Error(`patchSession: ${id} not found`);
      await transitionSessionState(this.db, existing.user_id, id, patch.state);
    }

    const sets: string[] = [];
    const args: InValue[] = [];
    if (patch.waiting_since !== undefined) {
      sets.push("waiting_since = ?");
      args.push(patch.waiting_since);
    }
    if (patch.name !== undefined) {
      sets.push("name = ?");
      args.push(patch.name);
    }
    if (patch.handoff_path !== undefined) {
      sets.push("handoff_path = ?");
      args.push(patch.handoff_path);
    }
    if (patch.handoff_hash !== undefined) {
      sets.push("handoff_hash = ?");
      args.push(patch.handoff_hash);
    }
    if (patch.brief !== undefined) {
      sets.push("brief = ?");
      args.push(patch.brief);
    }
    if (patch.runner !== undefined) {
      sets.push("runner = ?");
      args.push(patch.runner);
    }
    if (patch.instance_id !== undefined) {
      sets.push("instance_id = ?");
      args.push(patch.instance_id);
    }
    if (patch.name_is_custom !== undefined) {
      sets.push("name_is_custom = ?");
      args.push(patch.name_is_custom ? 1 : 0);
    }
    if (sets.length > 0) {
      args.push(id);
      await this.db.execute({ sql: `UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, args });
    }

    const row = await getSessionRow(this.db, id);
    if (!row) throw new Error(`patchSession: ${id} not found`);
    return row;
  }

  async createRun(input: CreateRunInput): Promise<SessionRunRow> {
    const id = ulid();
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `INSERT INTO session_runs
              (id, session_id, runner, instance_id, host_id, agent_session_id, resumed_from_run_id, started_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.session_id,
        input.runner,
        input.instance_id,
        input.host_id,
        input.agent_session_id ?? null,
        input.resumed_from_run_id ?? null,
        now,
      ],
    });
    return this.mustGetRun(id);
  }

  async patchRun(runId: string, patch: PatchRunInput): Promise<SessionRunRow> {
    const sets: string[] = [];
    const args: InValue[] = [];
    if (patch.ended_at !== undefined) {
      sets.push("ended_at = ?");
      args.push(patch.ended_at);
    }
    if (patch.end_reason !== undefined) {
      sets.push("end_reason = ?");
      args.push(patch.end_reason);
    }
    if (patch.agent_session_id !== undefined) {
      sets.push("agent_session_id = ?");
      args.push(patch.agent_session_id);
    }
    if (patch.usage !== undefined) {
      sets.push("usage = ?");
      args.push(JSON.stringify(patch.usage));
    }
    if (sets.length > 0) {
      args.push(runId);
      await this.db.execute({ sql: `UPDATE session_runs SET ${sets.join(", ")} WHERE id = ?`, args });
    }
    return this.mustGetRun(runId);
  }

  async listRuns(sessionId: string): Promise<SessionRunRow[]> {
    const res = await this.db.execute({
      sql: "SELECT * FROM session_runs WHERE session_id = ? ORDER BY started_at ASC",
      args: [sessionId],
    });
    return res.rows.map((r) => SessionRunRowSchema.parse(r));
  }

  async liveRun(sessionId: string): Promise<SessionRunRow | null> {
    const res = await this.db.execute({
      sql: "SELECT * FROM session_runs WHERE session_id = ? AND ended_at IS NULL LIMIT 1",
      args: [sessionId],
    });
    if (res.rows.length === 0) return null;
    return SessionRunRowSchema.parse(res.rows[0]);
  }

  // seq is assigned inside this one transaction: each INSERT's own
  // COALESCE(MAX(seq),0)+1 subquery sees every row the prior statement in
  // this same batch already inserted, so two events in one call get
  // consecutive seqs without a round trip back into JS between them, and
  // two concurrent appendEvents calls on the same session cannot assign the
  // same seq -- db.batch runs as one transaction, serializing against any
  // other writer.
  async appendEvents(sessionId: string, runId: string | null, events: CanonicalEvent[]): Promise<number[]> {
    if (events.length === 0) return [];
    const now = new Date().toISOString();
    const ids = events.map(() => ulid());
    const stmts: InStatement[] = events.map((event, i) => {
      const capped = capEventPayload(event);
      return {
        sql: `INSERT INTO session_events (id, session_id, run_id, seq, kind, payload, created_at)
              SELECT ?, ?, ?, COALESCE((SELECT MAX(seq) FROM session_events WHERE session_id = ?), 0) + 1, ?, ?, ?`,
        args: [ids[i], sessionId, runId, sessionId, capped.kind, JSON.stringify(capped.payload), now],
      };
    });
    await this.db.batch(stmts, "write");

    const placeholders = ids.map(() => "?").join(",");
    const res = await this.db.execute({
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
    let sql = `SELECT * FROM session_events WHERE ${conds.join(" AND ")} ORDER BY seq ASC`;
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      args.push(opts.limit);
    }
    const res = await this.db.execute({ sql, args });
    return res.rows.map((r) => SessionEventRowSchema.parse(r));
  }

  private async mustGetRun(id: string): Promise<SessionRunRow> {
    const res = await this.db.execute({ sql: "SELECT * FROM session_runs WHERE id = ?", args: [id] });
    if (res.rows.length === 0) throw new Error(`session_runs: ${id} not found`);
    return SessionRunRowSchema.parse(res.rows[0]);
  }
}
