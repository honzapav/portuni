// Persistence for the RECORD half of a thread (docs/superpowers/specs/
// 2026-09-22-local-sessions-design.md, "Record and content, column by
// column"): that the thread exists, on which node, whose it is, its state,
// runner, instance and its runs. The CONTENT half -- the transcript, the
// first message, the inline handoff summary -- is the device's, and lives
// behind SessionContentStore (./store-content.ts) in both workspaces; this
// store never touches session_events and never carries a brief.
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
import type { DbClient, InValue } from "../../infra/db.js";
import { z } from "zod";
import {
  createSession as createSessionRow,
  createDraftSession as createDraftSessionRow,
  getSession as getSessionRow,
  transitionSessionState,
} from "../sessions.js";
import type { SessionRow, SessionState } from "../../shared/types.js";
import type { SessionRunRow } from "../../shared/api-types.js";
import type { RunEndReason } from "./types.js";
import type { Locale } from "../../shared/i18n/config.js";

// SessionRunRow/SessionEventRow are defined in shared/api-types.ts (so the
// web can type the REST responses without importing server domain code);
// re-exported here so existing call sites importing them from this module
// keep working unchanged.
export type { SessionRunRow } from "../../shared/api-types.js";

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

// --- SessionStore interface -----------------------------------------------

export interface CreateRunnerSessionInput {
  node_id: string | null;
  user_id: string;
  runner: string;
  instance_id: string | null;
  host_id: string | null;
  // #375: the thread's own model/effort override, or null/omitted to use
  // the instance/runner default.
  model?: string | null;
  effort?: string | null;
}

// #374's draft thread: a row that exists from the moment the thread opens,
// before it has a brief or a runner -- the first message resolves both.
// Separate from CreateRunnerSessionInput because none of that input's
// required fields are known yet, not because the storage differs.
export interface CreateDraftSessionInput {
  node_id: string;
  user_id: string;
  model?: string | null;
  effort?: string | null;
  // v2 rule 5 (docs/superpowers/specs/2026-09-21-task-surface-v2-design.md):
  // chosen before the first message. The device resolves the
  // organisation's defaults (session-runtime.ts's resolveDraftDefaults);
  // the store only records. null means "no runner is logged in here".
  runner?: string | null;
  instance_id?: string | null;
  // #539: the language of the POST /sessions that opened the draft; its
  // default name is written in it (English when missing).
  locale?: Locale;
}

export interface PatchSessionInput {
  state?: SessionState;
  waiting_since?: string | null;
  name?: string;
  handoff_path?: string | null;
  handoff_hash?: string | null;
  // Set together with state: "running" when promoting a draft (#374) --
  // the draft had none of these chosen up front. The first message itself
  // is content: it goes to SessionContentStore.setContent, never here
  // (#456).
  runner?: string;
  instance_id?: string | null;
  // Set together with name when the promotion derives it from the first
  // message (#374, "Naming") -- protects it the same way a manual rename
  // does, so a later handoff-title enrichment at suspend never overwrites
  // the user's own words.
  name_is_custom?: boolean;
  // #375: PATCH /sessions/:id sets these; the REST handler ALSO forwards
  // a model change through SessionRuntime.setModel to a live run's Query
  // (this column write alone would never reach an already-running process).
  model?: string | null;
  effort?: string | null;
  // v2 context ring: written by the runtime on every context_usage event.
  context_used_tokens?: number | null;
  context_max_tokens?: number | null;
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


export interface SessionStore {
  createSession(input: CreateRunnerSessionInput): Promise<SessionRow>;
  createDraft(input: CreateDraftSessionInput): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  patchSession(id: string, patch: PatchSessionInput): Promise<SessionRow>;
  createRun(input: CreateRunInput): Promise<SessionRunRow>;
  patchRun(runId: string, patch: PatchRunInput): Promise<SessionRunRow>;
  listRuns(sessionId: string): Promise<SessionRunRow[]>;
  liveRun(sessionId: string): Promise<SessionRunRow | null>;
}

// --- DbSessionStore: the local-mode implementation over libsql -----------

export class DbSessionStore implements SessionStore {
  constructor(private readonly db: DbClient) {}

  async createSession(input: CreateRunnerSessionInput): Promise<SessionRow> {
    return createSessionRow(this.db, input.user_id, {
      node_id: input.node_id,
      session_type: "interactive_task",
      runner: input.runner,
      instance_id: input.instance_id,
      host_id: input.host_id,
      model: input.model ?? null,
      effort: input.effort ?? null,
    });
  }

  async createDraft(input: CreateDraftSessionInput): Promise<SessionRow> {
    return createDraftSessionRow(this.db, input.user_id, input.node_id, {
      model: input.model,
      effort: input.effort,
      runner: input.runner,
      instance_id: input.instance_id,
      locale: input.locale,
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
    if (patch.model !== undefined) {
      sets.push("model = ?");
      args.push(patch.model);
    }
    if (patch.effort !== undefined) {
      sets.push("effort = ?");
      args.push(patch.effort);
    }
    if (patch.context_used_tokens !== undefined) {
      sets.push("context_used_tokens = ?");
      args.push(patch.context_used_tokens);
    }
    if (patch.context_max_tokens !== undefined) {
      sets.push("context_max_tokens = ?");
      args.push(patch.context_max_tokens);
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

  private async mustGetRun(id: string): Promise<SessionRunRow> {
    const res = await this.db.execute({ sql: "SELECT * FROM session_runs WHERE id = ?", args: [id] });
    if (res.rows.length === 0) throw new Error(`session_runs: ${id} not found`);
    return SessionRunRowSchema.parse(res.rows[0]);
  }
}
