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
import { createAgentSessionRuntime } from "../apps/server/boot/session-runtime.js";
import { createAgentSessionsWsDeps, createSessionsWsServer } from "../apps/server/api/sessions-ws.js";
import WebSocket from "ws";
import { createClient } from "@libsql/client";
import { createLibsqlDbClient } from "../apps/server/infra/db-libsql.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { CentralHttpError, type CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { NodeSyncInfo, RegisterFileRecordResult } from "../apps/server/domain/sync/sync-remote-api.js";
import type { RemoteSweepResult } from "../apps/server/domain/sync/remote-sweep.js";
import type { DataSourceRow, SessionRow } from "../apps/server/shared/types.js";
import type {
  CreateDraftSessionInput,
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

  async listSessionRecords(opts: { states: readonly string[]; limit?: number }): Promise<SessionRow[]> {
    return [...this.sessions.values()].filter((s) => opts.states.includes(s.state)).slice(0, opts.limit);
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

  async createDraftSessionRecord(input: CreateDraftSessionInput): Promise<SessionRow> {
    if (!this.nodeVisible.has(input.node_id)) {
      throw new CentralHttpError("node not found", 404);
    }
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: ulid(),
      node_id: input.node_id,
      user_id: input.user_id,
      session_type: "interactive_task",
      cli: null,
      instance_id: null,
      agent_session_id: null,
      terminal_id: null,
      brief: null,
      runner: null,
      host_id: null,
      waiting_since: null,
      state: "draft",
      handoff_path: null,
      handoff_hash: null,
      handoff_inline: null,
      name: "Nový úkol",
      name_is_custom: 0,
      model: input.model ?? null,
      effort: input.effort ?? null,
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
      // Draft promotion (#374) sends these too, and central's own
      // PatchSessionBody accepts them -- a fake that dropped them would
      // leave the promoted row without a runner to resume under.
      ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
      ...(patch.runner !== undefined ? { runner: patch.runner } : {}),
      ...(patch.instance_id !== undefined ? { instance_id: patch.instance_id } : {}),
      ...(patch.name_is_custom !== undefined ? { name_is_custom: patch.name_is_custom ? 1 : 0 } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
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
  // #407: the node's organization, as central would answer it -- the
  // runtime's org-default resolution in this mode goes through here.
  nodeOrgs = new Map<string, string>();
  async nodeOrganizationId(nodeId: string): Promise<string | null> {
    return this.nodeOrgs.get(nodeId) ?? null;
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
let emptyDb: ReturnType<typeof createLibsqlDbClient>;

describe("agent-router: sessions/tasks", () => {
  before(async () => {
    delete process.env.PORTUNI_AUTH_TOKEN;
    // provisionRunCentral creates a real mirror directory on disk (same as
    // local mode's own provisionRun) -- a task can't start without one.
    workspace = await mkdtemp(join(tmpdir(), "portuni-agent-sessions-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    fake = new FakeCentral();
    // The agent sidecar has no graph db: make getDb() answer an EMPTY
    // in-memory client for the duration, so anything in the agent's socket
    // or routes that reaches for the local db (audit_log, say) fails here
    // the way it would in the real sidecar, instead of hitting whatever
    // portuni.db happens to sit in cwd.
    emptyDb = createLibsqlDbClient(createClient({ url: ":memory:" }));
    setDbForTesting(emptyDb);
    // Exactly desktop.ts's agent-mode wiring: one runtime shared by the
    // REST routes and the live channel.
    const sessionRuntime = createAgentSessionRuntime(fake, { suspendPollIntervalMs: 10, suspendTimeoutMs: 100 });
    handle = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      registerSigint: false,
      router: createAgentRouter(fake, { sessionRuntime }),
      mcpTransport: undefined,
      mountMcp: false,
      sessionsWs: createSessionsWsServer(createAgentSessionsWsDeps(fake, sessionRuntime)),
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
    setDbForTesting(null);
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
        // #378: nobody closed this run explicitly, so it falls through to
        // the auto-summary/suspend path and gets its handoff event too.
        [4, "handoff"],
      ],
    );
  });

  // #374 shipped with central/agent-mode drafts unimplemented (a 501), but
  // the UI creates a draft for EVERY new thread -- so in central mode no
  // task could be started at all until the record half learned this shape.
  it("POST /sessions with no brief creates a draft on central, no run", async () => {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { session: SessionRow; run: SessionRunRow | null };
    assert.equal(body.run, null);
    assert.equal(body.session.state, "draft");
    assert.equal(body.session.node_id, NODE_ID);
    assert.equal(body.session.brief, null);
    assert.equal(body.session.runner, null);
    assert.equal(fake.sessions.size, 1);
    assert.equal(fake.runs.size, 0);
  });

  it("a draft's model/effort reach central, and its first message promotes it to running", async () => {
    const created = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID, model: "sonnet", effort: "medium" }),
    });
    assert.equal(created.status, 201);
    const { session } = (await created.json()) as { session: SessionRow };
    assert.equal(session.model, "sonnet");
    assert.equal(session.effort, "medium");

    const sent = await fetch(`${base}/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Udělej to" }),
    });
    assert.equal(sent.status, 202);
    // The scripted fake adapter can finish before this assertion runs, and
    // #378 suspends a session on any run end -- what matters here is that
    // the draft was promoted and got a run, not which side of the finish
    // line it is on.
    const promoted = fake.sessions.get(session.id);
    assert.notEqual(promoted?.state, "draft");
    assert.equal(promoted?.runner, "fake");
    assert.equal(fake.runs.size, 1);
  });

  it("POST /sessions 404s for a draft on a node central does not know about", async () => {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: "unknown-node" }),
    });
    assert.equal(res.status, 404);
    assert.equal(fake.sessions.size, 0);
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

  it("continue closes the old session and starts a new, running one on central (#378)", async () => {
    stubScript([{ wait: "message" }]);
    const start = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID, brief: "x", runner: "fake" }),
    });
    const { session } = (await start.json()) as { session: SessionRow };

    const continueRes = await fetch(`${base}/sessions/${session.id}/continue`, { method: "POST" });
    assert.equal(continueRes.status, 200);
    const { session: continued } = (await continueRes.json()) as { session: SessionRow };
    assert.notEqual(continued.id, session.id);

    assert.equal(fake.sessions.get(session.id)?.state, "closed");
    assert.equal(fake.sessions.get(continued.id)?.state, "running");
    assert.equal(fake.runs.size, 2, "continue must create a second run record on central");
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
      // #378: nobody closed this run explicitly, so it falls through to the
      // auto-summary/suspend path and gets its handoff event too.
      ["run_started", "user_message", "run_ended", "handoff"],
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
  it("GET /sessions/ws is mounted in agent mode: a task started over REST streams on the socket", async () => {
    stubScript([{ wait: "message" }, { kind: "assistant_message", payload: { text: "done" } }]);
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/sessions/ws`);
    const frames: Array<{ id?: string; type: string; payload: unknown }> = [];
    const waiters: Array<{ pred: (f: (typeof frames)[number]) => boolean; resolve: () => void }> = [];
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8")) as (typeof frames)[number];
      frames.push(frame);
      for (const w of waiters.splice(0)) {
        if (w.pred(frame)) w.resolve();
        else waiters.push(w);
      }
    });
    const waitFor = (pred: (f: (typeof frames)[number]) => boolean): Promise<void> =>
      frames.some(pred) ? Promise.resolve() : new Promise((resolve) => waiters.push({ pred, resolve }));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node_id: NODE_ID, brief: "stream me", runner: "fake" }),
    });
    assert.equal(res.status, 201);
    const { session } = (await res.json()) as { session: SessionRow };

    // A reply OR an error settles the wait; the assertion then says which.
    const replyTo = async (id: string) => {
      await waitFor((f) => f.id === id);
      const frame = frames.find((f) => f.id === id)!;
      assert.equal(frame.type, "reply", `${id}: ${JSON.stringify(frame.payload)}`);
    };
    ws.send(JSON.stringify({ id: "sub", type: "subscribe", payload: { session_id: session.id, after: 0 } }));
    await replyTo("sub");
    // run_started + the brief replayed from the fake central's own log.
    assert.ok(frames.some((f) => f.type === "event" && (f.payload as { event: { kind: string } }).event.kind === "user_message"));

    ws.send(JSON.stringify({ id: "msg", type: "message", payload: { session_id: session.id, text: "go on" } }));
    await replyTo("msg");
    await waitFor(
      (f) => f.type === "event" && (f.payload as { event: { kind: string } }).event.kind === "assistant_message",
    );
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
  });
});
