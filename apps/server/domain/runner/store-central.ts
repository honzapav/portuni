// CentralSessionStore (spec: "domain/runner/store-central.ts"): the
// central/agent-mode implementation of SessionStore, over CentralClient
// instead of a local libsql Client -- "one implementation" (rule 1): the
// session runtime (session-runtime.ts) never changes between local and
// agent mode, only which SessionStore backs it (boot/session-runtime.ts
// binds DbSessionStore locally; agent-router.ts binds this one).
//
// Every method is a thin call into the matching CentralClient method,
// which itself is a thin call into api/sessions.ts's "central record
// half" REST routes -- see that file's header comment for the full route
// list this class is built over.

import type { CentralClient } from "../sync/central/client.js";
import type { SessionRow } from "../../shared/types.js";
import type {
  CreateRunInput,
  CreateRunnerSessionInput,
  ListEventsOptions,
  PatchRunInput,
  PatchSessionInput,
  SessionEventRow,
  SessionRunRow,
  SessionStore,
} from "./store.js";
import type { CanonicalEvent } from "./types.js";

// Batches events appended within a short window into one POST
// /sessions/:id/events call (spec: "add a 50ms coalescing buffer here so a
// burst of tool_call events is one round trip"). Keyed by session id --
// each session's own events always go to that session's own URL, so
// batching only ever applies within one session's own burst.
const COALESCE_WINDOW_MS = 50;

interface PendingAppend {
  runId: string | null;
  events: CanonicalEvent[];
  resolve: (seqs: number[]) => void;
  reject: (err: unknown) => void;
}

export class CentralSessionStore implements SessionStore {
  private readonly pending = new Map<string, PendingAppend[]>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // A SessionStore.patchRun call only carries a run id (no session id), but
  // the REST shape is /sessions/:id/runs/:run_id -- this is populated by
  // every call that ever learns a run's session_id (createRun, listRuns,
  // liveRun) so patchRun can find its way back to the right URL.
  private readonly runSession = new Map<string, string>();

  constructor(private readonly client: CentralClient) {}

  async createSession(input: CreateRunnerSessionInput): Promise<SessionRow> {
    return this.client.createSessionRecord(input);
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return this.client.getSessionRecord(id);
  }

  async patchSession(id: string, patch: PatchSessionInput): Promise<SessionRow> {
    return this.client.patchSessionRecord(id, patch);
  }

  async createRun(input: CreateRunInput): Promise<SessionRunRow> {
    const run = await this.client.createSessionRun(input);
    this.runSession.set(run.id, run.session_id);
    return run;
  }

  async patchRun(runId: string, patch: PatchRunInput): Promise<SessionRunRow> {
    const sessionId = this.runSession.get(runId);
    if (!sessionId) {
      throw new Error(`CentralSessionStore.patchRun: unknown run ${runId} (never created or listed by this store)`);
    }
    return this.client.patchSessionRun(sessionId, runId, patch);
  }

  async listRuns(sessionId: string): Promise<SessionRunRow[]> {
    const runs = await this.client.listSessionRuns(sessionId);
    for (const run of runs) this.runSession.set(run.id, run.session_id);
    return runs;
  }

  async liveRun(sessionId: string): Promise<SessionRunRow | null> {
    const runs = await this.listRuns(sessionId);
    return runs.find((r) => r.ended_at === null) ?? null;
  }

  appendEvents(sessionId: string, runId: string | null, events: CanonicalEvent[]): Promise<number[]> {
    if (events.length === 0) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const list = this.pending.get(sessionId) ?? [];
      list.push({ runId, events, resolve, reject });
      this.pending.set(sessionId, list);
      if (!this.flushTimers.has(sessionId)) {
        const timer = setTimeout(() => {
          void this.flush(sessionId);
        }, COALESCE_WINDOW_MS);
        timer.unref?.();
        this.flushTimers.set(sessionId, timer);
      }
    });
  }

  private async flush(sessionId: string): Promise<void> {
    this.flushTimers.delete(sessionId);
    const batch = this.pending.get(sessionId) ?? [];
    this.pending.delete(sessionId);
    if (batch.length === 0) return;

    const allEvents = batch.flatMap((b) => b.events);
    const runId = batch.find((b) => b.runId !== null)?.runId ?? null;
    try {
      const seqs = await this.client.appendSessionEvents(sessionId, runId, allEvents);
      let offset = 0;
      for (const b of batch) {
        b.resolve(seqs.slice(offset, offset + b.events.length));
        offset += b.events.length;
      }
    } catch (err) {
      for (const b of batch) b.reject(err);
    }
  }

  async listEvents(sessionId: string, opts?: ListEventsOptions): Promise<SessionEventRow[]> {
    return this.client.listSessionEvents(sessionId, opts);
  }
}
