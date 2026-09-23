// CentralSessionStore (spec: "domain/runner/store-central.ts"): the
// central/agent-mode implementation of the RECORD half of SessionStore,
// over CentralClient instead of a local libsql Client -- "one
// implementation" (rule 1): the session runtime (session-runtime.ts)
// never changes between local and agent mode, only which SessionStore
// backs it (boot/session-runtime.ts binds DbSessionStore locally;
// agent-router.ts binds this one).
//
// Every method is a thin call into the matching CentralClient method,
// which itself is a thin call into api/sessions.ts's "central record
// half" REST routes -- see that file's header comment for the full route
// list this class is built over.
//
// #456: the transcript, the first message and the inline handoff summary
// never come near this class -- they are the device's content, written
// through SessionContentStore against the device's own content.db in both
// workspaces (docs/superpowers/specs/2026-09-22-local-sessions-design.md,
// "The content store on the device").

import type { CentralClient } from "../sync/central/client.js";
import type { SessionRow } from "../../shared/types.js";
import type {
  CreateDraftSessionInput,
  CreateRunInput,
  CreateRunnerSessionInput,
  PatchRunInput,
  PatchSessionInput,
  SessionRunRow,
  SessionStore,
} from "./store.js";

export class CentralSessionStore implements SessionStore {
  // A SessionStore.patchRun call only carries a run id (no session id), but
  // the REST shape is /sessions/:id/runs/:run_id -- this is populated by
  // every call that ever learns a run's session_id (createRun, listRuns,
  // liveRun) so patchRun can find its way back to the right URL.
  private readonly runSession = new Map<string, string>();

  constructor(private readonly client: CentralClient) {}

  async createSession(input: CreateRunnerSessionInput): Promise<SessionRow> {
    return this.client.createSessionRecord(input);
  }

  async createDraft(input: CreateDraftSessionInput): Promise<SessionRow> {
    return this.client.createDraftSessionRecord(input);
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
    const row = await this.client.patchSessionRun(sessionId, runId, patch);
    // An ended run is never patched again (the runtime's own contract), so
    // its map entry can go -- the map otherwise grows by one per run for
    // the life of the sidecar process.
    if (row.ended_at !== null) this.runSession.delete(runId);
    return row;
  }

  async listRuns(sessionId: string): Promise<SessionRunRow[]> {
    const runs = await this.client.listSessionRuns(sessionId);
    // Only runs that can still be patched need the reverse lookup.
    for (const run of runs) {
      if (run.ended_at === null) this.runSession.set(run.id, run.session_id);
    }
    return runs;
  }

  async liveRun(sessionId: string): Promise<SessionRunRow | null> {
    const runs = await this.listRuns(sessionId);
    return runs.find((r) => r.ended_at === null) ?? null;
  }
}
