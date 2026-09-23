// Tests for GET /sessions/ws (runner batch, #322): the one WebSocket the
// chat, Relace tab, Práce sidebar and Přehled all use. Boots a real http
// server (same pattern as test/mcp-transport-suspend-on-close.test.ts) with
// a real `ws` client, and injects a google-mode IdentityContext
// (setIdentityContextForTesting, same seam test/api-access.test.ts uses) so
// two distinct users can authenticate with a signed session JWT each --
// env mode's single soloUserId can't represent "a second user".

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { ensureSchema } from "../apps/server/infra/schema.js";
import { getDb, setDbForTesting } from "../apps/server/infra/db.js";
import {
  resetGateCachesForTesting,
  resetIdentityContextForTesting,
  setIdentityContextForTesting,
} from "../apps/server/http/middleware.js";
import { EnvAdapter } from "../apps/server/auth/env-adapter.js";
import { signSessionToken } from "../apps/server/auth/session-token.js";
import { getAdapter, registerAdapter, clearRegistryForTests } from "../apps/server/domain/runner/registry.js";
import { FakeRunnerAdapter, type FakeScriptStep } from "../apps/server/domain/runner/adapters/fake.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { createSessionRuntime } from "../apps/server/domain/runner/session-runtime.js";
import { setSessionRuntimeForTesting } from "../apps/server/boot/session-runtime.js";
import { clearTestContentDb, installTestContentDb } from "./helpers/content-db.js";
import type { ProvisionRunResult } from "../apps/server/domain/runner/provision.js";

const SECRET = "test-secret-at-least-32-chars-long!!";
const U1 = "01U100000000000000000001A";
const U2 = "01U200000000000000000002B";

function stubProvision(): (input: { nodeId: string }) => Promise<ProvisionRunResult> {
  return async (input) => ({
    cwd: "/tmp/mirror",
    orientation: "orientation text",
    mcp: { url: "http://localhost:4011/mcp", token: "tok", homeNodeId: input.nodeId },
    portuniRoot: "/tmp",
    mirrors: ["/tmp/mirror"],
  });
}

async function tokenFor(userId: string, globalScope: "read" | "write" | "manage" = "write"): Promise<string> {
  return signSessionToken(
    { userId, email: `${userId.toLowerCase()}@x.com`, name: userId, globalScope, groups: [], groupIds: [] },
    SECRET,
  );
}

interface Frame {
  id?: string;
  type: string;
  payload: unknown;
}

function openSocket(base: string, token: string): WebSocket {
  const wsBase = base.replace(/^http/, "ws");
  return new WebSocket(`${wsBase}/sessions/ws`, { headers: { authorization: `Bearer ${token}` } });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve({ code }));
  });
}

// Collects every frame received, resolving predicate-matching waiters as
// they arrive so tests don't need to poll.
class FrameCollector {
  frames: Frame[] = [];
  private waiters: Array<{ predicate: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8")) as Frame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (w.predicate(frame)) {
          w.resolve(frame);
          return false;
        }
        return true;
      });
    });
  }

  async waitFor(predicate: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitFor timed out")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }
}

// The runtime instance itself is built ONCE (in before(), below) and never
// swapped between tests -- matching production, where boot/session-
// runtime.ts's getSessionRuntime() is a true process-lifetime singleton.
// sessions-ws.ts's global "*" subscription (for session_state broadcasts)
// is created lazily on the FIRST successful connection and captures
// whichever runtime getSessionRuntime() returns at that moment; swapping in
// a brand new runtime per test (as other runner-batch REST tests do) would
// leave that one-time subscription listening to an abandoned instance.
// Only the fake ADAPTER changes per test -- re-registering under the same
// "fake" id is enough, since the runtime's own `registry: { getAdapter }`
// dependency is a live lookup into the registry module, not a captured
// adapter reference (identical to how boot/session-runtime.ts wires it).
let currentRuntime: ReturnType<typeof createSessionRuntime>;

function installAdapter(script: readonly FakeScriptStep[]): void {
  clearRegistryForTests();
  registerAdapter(new FakeRunnerAdapter({ script }));
}

describe("GET /sessions/ws", () => {
  let tmp: string;
  let handle: HttpServerHandle;
  let base: string;
  let nodeId: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "portuni-sessions-ws-"));
    process.env.TURSO_URL = `file:${join(tmp, "portuni.db")}`;
    setDbForTesting(null);
    await ensureSchema();

    const db = getDb();
    await db.execute({ sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)", args: [U1, "u1@x.com", "U1"] });
    await db.execute({ sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)", args: [U2, "u2@x.com", "U2"] });
    const orgId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'organization', 'Org', 'org', ?)",
      args: [orgId, U1],
    });
    nodeId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'Proj', 'proj', ?)",
      args: [nodeId, U1],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), nodeId, orgId, U1],
    });

    handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false });
    if (!handle.server.listening) {
      await new Promise<void>((resolve) => handle.server.once("listening", resolve));
    }
    const address = handle.server.address() as AddressInfo;
    process.env.PORT = String(address.port);
    resetGateCachesForTesting();
    setIdentityContextForTesting({
      db,
      mode: "google",
      jwtSecret: SECRET,
      adapter: new EnvAdapter({} as NodeJS.ProcessEnv),
      soloUserId: "unused",
    });
    base = `http://127.0.0.1:${address.port}`;

    currentRuntime = createSessionRuntime({
      store: new DbSessionStore(db),
      content: (await installTestContentDb()).content,
      registry: { getAdapter },
      provision: stubProvision(),
    });
    setSessionRuntimeForTesting(currentRuntime);
  });

  after(async () => {
    await handle.shutdown();
    resetIdentityContextForTesting();
    resetGateCachesForTesting();
    setDbForTesting(null);
    setSessionRuntimeForTesting(null);
    clearTestContentDb();
    clearRegistryForTests();
    delete process.env.TURSO_URL;
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    installAdapter([{ wait: "message" }]);
  });

  test("an upgrade with no/invalid bearer is refused with 401", async () => {
    const ws = openSocket(base, "not-a-real-jwt");
    const result = await new Promise<{ code?: number }>((resolve) => {
      ws.once("unexpected-response", (_req, res) => resolve({ code: res.statusCode }));
      ws.once("open", () => resolve({}));
      ws.once("error", () => resolve({}));
    });
    assert.equal(result.code, 401);
  });

  test("subscribe replays persisted events after `after`, then delivers a live run's events", async () => {
    // The script blocks on the FIRST wait step, before emitting anything
    // past run_started + the brief -- otherwise a wait-free script runs to
    // completion synchronously inside startTask(), before the test could
    // ever subscribe in time to see anything "live".
    installAdapter([{ wait: "message" }, { kind: "assistant_message", payload: { text: "final" } }]);
    const runtime = currentRuntime;
    const { session } = await runtime.startTask({ userId: U1, nodeId, brief: "go", runner: "fake" });
    // run_started (seq 1) + the brief as user_message (seq 2) are already
    // persisted by the time startTask() resolves.

    const token = await tokenFor(U1);
    const ws = openSocket(base, token);
    const collector = new FrameCollector(ws);
    await waitOpen(ws);

    ws.send(JSON.stringify({ id: "sub1", type: "subscribe", payload: { session_id: session.id, after: 1 } }));
    await collector.waitFor((f) => f.id === "sub1" && f.type === "reply");

    // The replay is one `events` frame per page, never a frame per event.
    assert.ok(!collector.frames.some((f) => f.type === "event"));
    const pages = collector.frames.filter((f) => f.type === "events");
    assert.equal(pages.length, 1);
    const replayed = (pages[0].payload as { events: { kind: string }[] }).events;
    assert.equal(replayed.length, 1, "after:1 must skip run_started and replay only the brief");
    assert.equal(replayed[0].kind, "user_message");

    // Unblocks the script -- its own assistant_message must arrive live,
    // on the same subscription, after the persisted replay.
    await runtime.sendMessage(session.id, "continue");
    await collector.waitFor(
      (f) => f.type === "event" && (f.payload as { event: { kind: string } }).event.kind === "assistant_message",
    );
    ws.close();
    await waitClose(ws);
  });

  test("a delta never lands in listEvents (not persisted)", async () => {
    installAdapter([
      { wait: "message" },
      { type: "delta", run_id: "r1", channel: "text", text: "chunk" },
      { kind: "assistant_message", payload: { text: "final" } },
    ]);
    const runtime = currentRuntime;
    const { session } = await runtime.startTask({ userId: U1, nodeId, brief: "go", runner: "fake" });

    const token = await tokenFor(U1);
    const ws = openSocket(base, token);
    const collector = new FrameCollector(ws);
    await waitOpen(ws);

    ws.send(JSON.stringify({ id: "sub1", type: "subscribe", payload: { session_id: session.id, after: 0 } }));
    await collector.waitFor((f) => f.id === "sub1" && f.type === "reply");

    await runtime.sendMessage(session.id, "continue");
    await collector.waitFor((f) => f.type === "delta");

    const events = await runtime.listEvents(session.id);
    assert.ok(!events.some((e) => e.kind === "delta"));
    ws.close();
    await waitClose(ws);
  });

  test("message through the socket lands as a user_message event", async () => {
    const token = await tokenFor(U1);
    const ws = openSocket(base, token);
    const collector = new FrameCollector(ws);
    await waitOpen(ws);

    const runtime = currentRuntime;
    const { session } = await runtime.startTask({ userId: U1, nodeId, brief: "go", runner: "fake" });
    ws.send(JSON.stringify({ id: "sub1", type: "subscribe", payload: { session_id: session.id, after: 0 } }));
    await collector.waitFor((f) => f.id === "sub1" && f.type === "reply");

    ws.send(JSON.stringify({ id: "msg1", type: "message", payload: { session_id: session.id, text: "hi there" } }));
    const reply = await collector.waitFor((f) => f.id === "msg1");
    assert.equal(reply.type, "reply");

    const events = await runtime.listEvents(session.id);
    assert.ok(events.some((e) => e.kind === "user_message" && JSON.parse(e.payload).text === "hi there"));
    ws.close();
    await waitClose(ws);
  });

  test("session_state snapshot on connect, and an update when the fake run asks a question", async () => {
    installAdapter([
      { wait: "message" },
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
    const runtime = currentRuntime;
    const { session } = await runtime.startTask({ userId: U1, nodeId, brief: "go", runner: "fake" });

    const token = await tokenFor(U1);
    const ws = openSocket(base, token);
    const collector = new FrameCollector(ws);
    await waitOpen(ws);

    // The whole snapshot is one frame, never a frame per session.
    const snapshotFrame = await collector.waitFor((f) => f.type === "session_states");
    const sessions = (snapshotFrame.payload as { sessions: { session_id: string; state: string; waiting_since: string | null }[] })
      .sessions;
    const snapshot = sessions.find((s) => s.session_id === session.id);
    assert.ok(snapshot);
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.waiting_since, null);
    assert.equal(collector.frames.filter((f) => f.type === "session_states").length, 1);
    assert.ok(!collector.frames.some((f) => f.type === "session_state"));

    // Unblocks the script into the question step -- the resulting
    // state_changed event must fan out as a live session_state update to
    // this already-connected socket, with no subscription needed.
    await runtime.sendMessage(session.id, "continue");
    const update = await collector.waitFor(
      (f) =>
        f.type === "session_state" &&
        (f.payload as { session_id: string; waiting_since: string | null }).session_id === session.id &&
        (f.payload as { waiting_since: string | null }).waiting_since !== null,
    );
    assert.ok((update.payload as { waiting_since: string | null }).waiting_since);
    ws.close();
    await waitClose(ws);
  });

  test("a rename through the runtime fans out as session_state carrying the new name", async () => {
    installAdapter([{ wait: "message" }]);
    const runtime = currentRuntime;
    const { session } = await runtime.startTask({ userId: U1, nodeId, brief: "go", runner: "fake" });

    const token = await tokenFor(U1);
    const ws = openSocket(base, token);
    const collector = new FrameCollector(ws);
    await waitOpen(ws);
    await collector.waitFor((f) => f.type === "session_states");

    await runtime.renameSession(session.id, "Přejmenováno");
    const update = await collector.waitFor(
      (f) =>
        f.type === "session_state" &&
        (f.payload as { session_id: string; name?: string }).session_id === session.id &&
        (f.payload as { name?: string }).name === "Přejmenováno",
    );
    assert.equal((update.payload as { state: string }).state, "running");
    ws.close();
    await waitClose(ws);
  });

  test("a second user who can see the node sees nothing of the owner's thread (#457)", async () => {
    installAdapter([{ wait: "message" }]);
    const runtime = currentRuntime;
    const { session } = await runtime.startTask({ userId: U1, nodeId, brief: "go", runner: "fake" });

    const token = await tokenFor(U2);
    const ws = openSocket(base, token);
    const collector = new FrameCollector(ws);
    await waitOpen(ws);

    // The snapshot burst is U2's own threads; U1's never appears in it.
    ws.send(JSON.stringify({ id: "sub1", type: "subscribe", payload: { session_id: session.id, after: 0 } }));
    const subReply = await collector.waitFor((f) => f.id === "sub1");
    assert.equal(subReply.type, "error");
    assert.equal((subReply.payload as { code: string }).code, "SESSION_NOT_FOUND");
    assert.ok(
      !collector.frames.some(
        (f) => f.type === "session_state" && (f.payload as { session_id: string }).session_id === session.id,
      ),
    );
    assert.ok(
      !collector.frames.some(
        (f) =>
          f.type === "session_states" &&
          (f.payload as { sessions: { session_id: string }[] }).sessions.some((s) => s.session_id === session.id),
      ),
    );

    ws.send(JSON.stringify({ id: "msg1", type: "message", payload: { session_id: session.id, text: "nope" } }));
    const errorReply = await collector.waitFor((f) => f.id === "msg1");
    assert.equal(errorReply.type, "error");
    assert.equal((errorReply.payload as { code: string }).code, "SESSION_NOT_FOUND");

    ws.close();
    await waitClose(ws);
  });

  test("disconnect unsubscribes (the runtime's subscriber count returns to zero)", async () => {
    const runtime = currentRuntime;
    const { session } = await runtime.startTask({ userId: U1, nodeId, brief: "go", runner: "fake" });

    const token = await tokenFor(U1);
    const ws = openSocket(base, token);
    const collector = new FrameCollector(ws);
    await waitOpen(ws);
    ws.send(JSON.stringify({ id: "sub1", type: "subscribe", payload: { session_id: session.id, after: 0 } }));
    await collector.waitFor((f) => f.id === "sub1" && f.type === "reply");

    assert.equal(runtime.subscriberCount(session.id), 1);
    ws.close();
    await waitClose(ws);
    // The close handler runs synchronously with the "close" event; give the
    // event loop one tick to be safe.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runtime.subscriberCount(session.id), 0);
  });
  test("a read-scope caller may subscribe but every mutating frame is refused with FORBIDDEN", async () => {
    const runtime = currentRuntime;
    const { session } = await runtime.startTask({ userId: U1, nodeId, brief: "go", runner: "fake" });

    // U1 owns the session, so sessionAccess alone would allow message and
    // stop -- the refusal must come from the scope tier, same as the REST
    // twins' minScopeForRoute "write".
    const ws = openSocket(base, await tokenFor(U1, "read"));
    const collector = new FrameCollector(ws);
    await waitOpen(ws);
    ws.send(JSON.stringify({ id: "sub", type: "subscribe", payload: { session_id: session.id, after: 0 } }));
    const sub = await collector.waitFor((f) => f.id === "sub");
    assert.equal(sub.type, "reply");

    for (const type of ["message", "interrupt", "continue", "close"] as const) {
      const payload = type === "message" ? { session_id: session.id, text: "hi" } : { session_id: session.id };
      ws.send(JSON.stringify({ id: type, type, payload }));
      const reply = await collector.waitFor((f) => f.id === type);
      assert.equal(reply.type, "error", type);
      assert.equal((reply.payload as { code: string }).code, "FORBIDDEN", type);
    }
    // Nothing reached the runtime: the session is still running with no
    // user_message beyond the brief.
    const events = await runtime.listEvents(session.id, {});
    assert.equal(events.filter((e) => e.kind === "user_message").length, 1);
    ws.close();
    await waitClose(ws);
  });

  test("GET /sessions lists the caller's own sessions only (#457)", async () => {
    const runtime = currentRuntime;
    const own = await runtime.startTask({ userId: U1, nodeId, brief: "mine", runner: "fake" });
    // A chat session with no anchor node belongs to U2 alone: U1 never
    // sees it, U2 does.
    const db = getDb();
    const chatId = ulid();
    await db.execute({
      sql: "INSERT INTO sessions (id, node_id, user_id, session_type, state) VALUES (?, NULL, ?, 'interactive_chat', 'running')",
      args: [chatId, U2],
    });

    const asU1 = await fetch(`${base}/sessions?state=running`, { headers: { authorization: `Bearer ${await tokenFor(U1)}` } });
    assert.equal(asU1.status, 200);
    const u1Ids = ((await asU1.json()) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    assert.ok(u1Ids.includes(own.session.id));
    assert.ok(!u1Ids.includes(chatId));

    const asU2 = await fetch(`${base}/sessions?state=running,suspended`, { headers: { authorization: `Bearer ${await tokenFor(U2)}` } });
    const u2Ids = ((await asU2.json()) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    assert.ok(u2Ids.includes(chatId));
    // U2 can see the project node (org-visible by default), and that says
    // nothing about U1's thread on it any more (#457).
    assert.ok(!u2Ids.includes(own.session.id));

    const bad = await fetch(`${base}/sessions?state=bogus`, { headers: { authorization: `Bearer ${await tokenFor(U1)}` } });
    assert.equal(bad.status, 400);
  });
});
