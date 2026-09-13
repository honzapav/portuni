// Tests for the session/task routes agent-router.ts mounts in central/
// agent mode (runner batch, #323): the SAME session runtime as local mode,
// bound to CentralSessionStore instead of DbSessionStore. In the style of
// test/agent-router.test.ts (a real http server + createAgentRouter(fake)),
// with a fake CentralClient implementing just the session methods for
// real (backed by in-memory maps) and throwing on anything else, since
// these tests never touch file/sync routes.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { ulid } from "ulid";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { createAgentRouter } from "../apps/server/api/agent-router.js";
import { CentralHttpError, type CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { NodeSyncInfo, RegisterFileRecordResult } from "../apps/server/domain/sync/sync-remote-api.js";
import type { RemoteSweepResult } from "../apps/server/domain/sync/remote-sweep.js";
import type { DataSourceRow, SessionRow } from "../apps/server/shared/types.js";
import type {
  CreateRunInput,
  CreateRunnerSessionInput,
  ListEventsOptions,
  PatchRunInput,
  PatchSessionInput,
  SessionEventRow,
  SessionRunRow,
} from "../apps/server/domain/runner/store.js";
import type { CanonicalEvent } from "../apps/server/domain/runner/types.js";
import type { OrientationSummary } from "../apps/server/domain/write-scope.js";
import { registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";

const NODE_ID = "N1";
const NODE_SYNC_INFO: NodeSyncInfo = {
  node: { id: NODE_ID, name: "Proj", type: "project", sync_key: "proj", org_sync_key: "workflow" },
  remote_name: null,
  files: [],
  deleted: [],
};

class FakeCentral implements CentralClient {
  sessions = new Map<string, SessionRow>();
  runs = new Map<string, SessionRunRow>();
  events = new Map<string, SessionEventRow[]>();
  seq = new Map<string, number>();
  nodeVisible = new Set<string>([NODE_ID]);
  orientationValue: OrientationSummary | null = {
    node: { name: "Proj", type: "project", description: null, status: "active", goal: null, lifecycle_state: null },
    responsibilities: [],
    events: [],
    handoff: null,
  };

  async getSessionRecord(id: string): Promise<SessionRow | null> {
    return this.sessions.get(id) ?? null;
  }

  async createSessionRecord(input: CreateRunnerSessionInput): Promise<SessionRow> {
    if (input.node_id && !this.nodeVisible.has(input.node_id)) {
      throw new CentralHttpError("node not found", 404);
    }
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: ulid(),
      node_id: input.node_id,
      user_id: input.user_id,
      session_type: "interactive_task",
      cli: null,
      instance_id: input.instance_id,
      agent_session_id: null,
      terminal_id: null,
      brief: input.brief,
      runner: input.runner,
      host_id: input.host_id,
      waiting_since: null,
      state: "running",
      handoff_path: null,
      handoff_hash: null,
      handoff_inline: null,
      name: "Task",
      name_is_custom: 0,
      created_at: now,
      last_active_at: now,
      closed_at: null,
    };
    this.sessions.set(row.id, row);
    return row;
  }

  async patchSessionRecord(id: string, patch: PatchSessionInput): Promise<SessionRow> {
    const row = this.sessions.get(id);
    if (!row) throw new CentralHttpError("session not found", 404);
    const updated: SessionRow = {
      ...row,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.waiting_since !== undefined ? { waiting_since: patch.waiting_since } : {}),
      ...(patch.handoff_path !== undefined ? { handoff_path: patch.handoff_path } : {}),
      ...(patch.handoff_hash !== undefined ? { handoff_hash: patch.handoff_hash } : {}),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  async createSessionRun(input: CreateRunInput): Promise<SessionRunRow> {
    const run: SessionRunRow = {
      id: ulid(),
      session_id: input.session_id,
      runner: input.runner,
      instance_id: input.instance_id,
      host_id: input.host_id,
      agent_session_id: input.agent_session_id ?? null,
      resumed_from_run_id: input.resumed_from_run_id ?? null,
      started_at: new Date().toISOString(),
      ended_at: null,
      end_reason: null,
      usage: null,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async patchSessionRun(_sessionId: string, runId: string, patch: PatchRunInput): Promise<SessionRunRow> {
    const run = this.runs.get(runId);
    if (!run) throw new CentralHttpError("run not found", 404);
    const updated: SessionRunRow = {
      ...run,
      ...(patch.ended_at !== undefined ? { ended_at: patch.ended_at } : {}),
      ...(patch.end_reason !== undefined ? { end_reason: patch.end_reason } : {}),
      ...(patch.agent_session_id !== undefined ? { agent_session_id: patch.agent_session_id } : {}),
      ...(patch.usage !== undefined ? { usage: JSON.stringify(patch.usage) } : {}),
    };
    this.runs.set(runId, updated);
    return updated;
  }

  async listSessionRuns(sessionId: string): Promise<SessionRunRow[]> {
    return [...this.runs.values()].filter((r) => r.session_id === sessionId);
  }

  async appendSessionEvents(
    sessionId: string,
    runId: string | null,
    events: CanonicalEvent[],
  ): Promise<number[]> {
    const list = this.events.get(sessionId) ?? [];
    let seq = this.seq.get(sessionId) ?? 0;
    const seqs: number[] = [];
    for (const e of events) {
      seq += 1;
      list.push({
        id: ulid(),
        session_id: sessionId,
        run_id: runId,
        seq,
        kind: e.kind,
        payload: JSON.stringify(e.payload),
        created_at: new Date().toISOString(),
      });
      seqs.push(seq);
    }
    this.seq.set(sessionId, seq);
    this.events.set(sessionId, list);
    return seqs;
  }

  async listSessionEvents(sessionId: string, opts?: ListEventsOptions): Promise<SessionEventRow[]> {
    let rows = this.events.get(sessionId) ?? [];
    if (opts?.after !== undefined) rows = rows.filter((r) => r.seq > opts.after!);
    if (opts?.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows;
  }

  async orientation(): Promise<OrientationSummary | null> {
    return this.orientationValue;
  }

  // syncInfo/dataSources are real (not stubs): provisionRunCentral's mirror
  // creation calls syncInfo to resolve the node's type/sync_key before it
  // can pick a local path, and dataSources (best-effort, already caught by
  // the caller) for the mirror's scope config.
  async syncInfo(nodeId: string): Promise<NodeSyncInfo> {
    if (!this.nodeVisible.has(nodeId)) throw new CentralHttpError("node not found", 404);
    return NODE_SYNC_INFO;
  }
  async dataSources(): Promise<DataSourceRow[]> {
    return [];
  }

  // --- unused by these tests ---
  async syncInfoBatch(): Promise<NodeSyncInfo[]> {
    throw new Error("not used in this test");
  }
  async registerFile(): Promise<RegisterFileRecordResult> {
    throw new Error("not used in this test");
  }
  async registerFiles(): Promise<RegisterFileRecordResult[]> {
    throw new Error("not used in this test");
  }
  async createFile(): ReturnType<CentralClient["createFile"]> {
    throw new Error("not used in this test");
  }
  async getFileRaw(): ReturnType<CentralClient["getFileRaw"]> {
    throw new Error("not used in this test");
  }
  async putFileRaw(): ReturnType<CentralClient["putFileRaw"]> {
    throw new Error("not used in this test");
  }
  async renameFile(): Promise<Record<string, unknown>> {
    throw new Error("not used in this test");
  }
  async moveFileRecord(): Promise<Record<string, unknown>> {
    throw new Error("not used in this test");
  }
  async deleteFileRecord(): Promise<Record<string, unknown>> {
    throw new Error("not used in this test");
  }
  async remoteSweep(): Promise<RemoteSweepResult> {
    throw new Error("not used in this test");
  }
  async nodeExists(nodeId: string): Promise<boolean> {
    return this.nodeVisible.has(nodeId);
  }
  async nodeNeighbours(): Promise<string[]> {
    return [];
  }
  invalidateSyncInfo(): void {
    // No cache in this fake.
  }
}

let handle: HttpServerHandle;
let base: string;
let fake: FakeCentral;

function stubScript(script: readonly FakeScriptStep[] = []): void {
  clearRegistryForTests();
  registerAdapter(new FakeRunnerAdapter({ script }));
}

let workspace: string;

describe("agent-router: sessions/tasks", () => {
  before(async () => {
    delete process.env.PORTUNI_AUTH_TOKEN;
    // provisionRunCentral creates a real mirror directory on disk (same as
    // local mode's own provisionRun) -- a task can't start without one.
    workspace = await mkdtemp(join(tmpdir(), "portuni-agent-sessions-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    fake = new FakeCentral();
    handle = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      registerSigint: false,
      router: createAgentRouter(fake, {
        sessionRuntimeOpts: { suspendPollIntervalMs: 10, suspendTimeoutMs: 100 },
      }),
      mountMcp: false,
    });
    if (!handle.server.listening) {
      await new Promise<void>((r) => handle.server.once("listening", r));
    }
    const addr = handle.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
    process.env.PORT = String(addr.port);
    resetGateCachesForTesting();
  });

  after(async () => {
    await handle.shutdown();
    resetGateCachesForTesting();
    clearRegistryForTests();
    resetLocalDbForTests();
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    await rm(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    fake.sessions.clear();
    fake.runs.clear();
    fake.events.clear();
    fake.seq.clear();
    stubScript([]);
  });

  it("POST /sessions records the session, one run, and the run's events on the fake central", async () => {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID, brief: "Fix the bug", runner: "fake" }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { session: SessionRow; run: SessionRunRow };
    assert.equal(body.session.node_id, NODE_ID);
    assert.equal(body.session.brief, "Fix the bug");

    assert.equal(fake.sessions.size, 1);
    assert.equal(fake.runs.size, 1);
    const run = [...fake.runs.values()][0];
    assert.equal(run.session_id, body.session.id);

    const events = fake.events.get(body.session.id) ?? [];
    assert.deepEqual(
      events.map((e) => [e.seq, e.kind]),
      [
        [1, "run_started"],
        [2, "user_message"],
        [3, "run_ended"],
      ],
    );
  });

  it("POST /sessions 400s for an unknown runner without ever touching central", async () => {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID, brief: "x", runner: "nonexistent" }),
    });
    assert.equal(res.status, 400);
    assert.equal(fake.sessions.size, 0);
  });

  it("POST /sessions 404s for a node central does not know about", async () => {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: "unknown-node", brief: "x", runner: "fake" }),
    });
    assert.equal(res.status, 404);
  });

  it("suspend and resume patch the session state on central", async () => {
    stubScript([{ wait: "message" }]);
    const start = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID, brief: "x", runner: "fake" }),
    });
    const { session } = (await start.json()) as { session: SessionRow };

    const suspendRes = await fetch(`${base}/sessions/${session.id}/suspend`, { method: "POST" });
    assert.equal(suspendRes.status, 200);
    assert.equal(fake.sessions.get(session.id)?.state, "suspended");

    const resumeRes = await fetch(`${base}/sessions/${session.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "handoff" }),
    });
    assert.equal(resumeRes.status, 200);
    assert.equal(fake.sessions.get(session.id)?.state, "running");
    assert.equal(fake.runs.size, 2, "resume must create a second run record on central");
  });

  it("GET /sessions/:id/events replays exactly what central holds", async () => {
    const start = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID, brief: "x", runner: "fake" }),
    });
    const { session } = (await start.json()) as { session: SessionRow };

    const res = await fetch(`${base}/sessions/${session.id}/events`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    assert.deepEqual(
      body.events.map((e) => e.kind),
      ["run_started", "user_message", "run_ended"],
    );
  });

  it("a scripted question answered through POST /sessions/:id/questions/:request_id clears waiting", async () => {
    stubScript([
      {
        kind: "question",
        payload: {
          request_id: "req-1",
          type: "approval",
          tool: "x",
          title: "t",
          detail: "d",
          options: null,
          decision: null,
        },
      },
      { wait: "answer" },
    ]);
    const start = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID, brief: "x", runner: "fake" }),
    });
    const { session } = (await start.json()) as { session: SessionRow };
    assert.ok(fake.sessions.get(session.id)?.waiting_since);

    const answerRes = await fetch(`${base}/sessions/${session.id}/questions/req-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: { value: true } }),
    });
    assert.equal(answerRes.status, 202);
    assert.equal(fake.sessions.get(session.id)?.waiting_since, null);
  });
});
