// Session live channel TS client (#341,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md). Exercises
// the direct-WS transport (the dev-mode path -- there is no Tauri runtime
// in this test environment) against a small fake `ws` server standing in
// for apps/server/api/sessions-ws.ts.
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  createSessionsClient,
  createDirectWsTransport,
  type Transport,
  type WebSocketInstance,
} from "../apps/web/src/lib/sessions-client.js";
import { createSessionStore } from "../apps/web/src/lib/session-store.js";
import { selectMountedThreads, selectNodeRecordIds } from "../apps/web/src/lib/session-selectors.js";
import type { SessionState, SessionSummary } from "../apps/web/src/types.js";

interface SubscribeCall {
  session_id: string;
  after?: number;
}

class FakeSessionsServer {
  readonly wss: WebSocketServer;
  private readonly sockets = new Set<WsSocket>();
  readonly subscribeCalls: SubscribeCall[] = [];
  readonly unsubscribeCalls: string[] = [];
  // When set, requests are recorded but never answered -- the way a server
  // that dies mid-request behaves. Lets a test strand a request on purpose.
  silent = false;

  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as { id?: string; type: string; payload: unknown };
        if (frame.type === "subscribe") {
          this.subscribeCalls.push(frame.payload as SubscribeCall);
        }
        if (frame.type === "unsubscribe") {
          this.unsubscribeCalls.push((frame.payload as { session_id: string }).session_id);
        }
        if (frame.id && !this.silent) {
          socket.send(JSON.stringify({ id: frame.id, type: "reply", payload: { ok: true } }));
        }
      });
    });
  }

  async ready(): Promise<void> {
    if (this.wss.address()) return;
    await new Promise<void>((resolve) => this.wss.once("listening", resolve));
  }

  get url(): string {
    const addr = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${addr.port}`;
  }

  broadcast(frame: unknown): void {
    const text = JSON.stringify(frame);
    for (const s of this.sockets) s.send(text);
  }

  // Simulates a dropped connection (network blip, server restart) rather
  // than a graceful close -- the client's onclose handler fires the same
  // way either way, so this is enough to exercise the reconnect path.
  dropAllConnections(): void {
    for (const s of this.sockets) s.terminate();
    this.sockets.clear();
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
  }
}

// Generous deadline: the whole suite runs many files in parallel, and a
// loaded CI runner can delay a 10 ms reconnect timer well past 2 s.
async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition never became true within " + timeoutMs + "ms");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const servers: FakeSessionsServer[] = [];
// Every client is disconnected here as well as at the end of its own test:
// a client left connected after a failed assertion would otherwise keep
// reconnecting to the closed fake server forever (10 ms backoff, a live
// socket handle each time) and the test process would never exit --
// which node:test reports as nothing at all, not as a failure.
const clients: Array<{ disconnect(): void }> = [];
after(async () => {
  for (const c of clients) c.disconnect();
  await Promise.all(servers.map((s) => s.close()));
});

function testTransport(server: FakeSessionsServer) {
  return createDirectWsTransport(server.url, {
    minBackoffMs: 10,
    maxBackoffMs: 50,
    connectTimeoutMs: 500,
    WebSocket: WsClient,
  });
}

async function fakeServer(): Promise<FakeSessionsServer> {
  const server = new FakeSessionsServer();
  await server.ready();
  servers.push(server);
  return server;
}

describe("sessions-client: direct-WS transport", () => {
  it("subscribes with no `after` on a fresh subscribe, then delivers events in order", async () => {
    const server = await fakeServer();
    const transport = testTransport(server);
    const client = createSessionsClient({ transport });
    clients.push(client);
    const received: number[] = [];
    client.onEvents("S1", (batch) => received.push(...batch.map((e) => e.seq)));

    await client.subscribe("S1");
    await waitUntil(() => server.subscribeCalls.length === 1);
    // JSON.stringify drops an undefined `after` entirely rather than
    // sending it as null -- matches the server's own optional `after` Zod
    // field, where "omitted" is exactly "no afterSeq" (a full replay).
    assert.deepEqual(server.subscribeCalls[0], { session_id: "S1" });

    server.broadcast({ type: "event", payload: { session_id: "S1", event: { kind: "assistant_message", payload: { text: "a" }, seq: 1 } } });
    server.broadcast({ type: "event", payload: { session_id: "S1", event: { kind: "assistant_message", payload: { text: "b" }, seq: 2 } } });
    server.broadcast({ type: "event", payload: { session_id: "S1", event: { kind: "assistant_message", payload: { text: "c" }, seq: 3 } } });
    await waitUntil(() => received.length === 3);
    assert.deepEqual(received, [1, 2, 3]);

    client.disconnect();
  });

  it("re-subscribes with the last seq it saw per session after a dropped connection", async () => {
    const server = await fakeServer();
    const transport = testTransport(server);
    const client = createSessionsClient({ transport });
    clients.push(client);
    const statuses: string[] = [];
    client.onConnectionStatus((s) => statuses.push(s));

    await client.subscribe("S1");
    await waitUntil(() => server.subscribeCalls.length === 1);
    server.broadcast({ type: "event", payload: { session_id: "S1", event: { kind: "run_started", payload: {}, seq: 5 } } });
    await waitUntil(() => statuses.includes("open"));

    server.dropAllConnections();
    await waitUntil(() => statuses.includes("reconnecting"));
    await waitUntil(() => server.subscribeCalls.length === 2, 5000);

    assert.deepEqual(server.subscribeCalls[1], { session_id: "S1", after: 5 });

    client.disconnect();
  });

  // The reconnect's own resubscribe is fire-and-forget: no caller awaits it,
  // so if the connection goes away again before its reply lands, rejecting it
  // produces an unhandled rejection -- which in the webview reaches the
  // window's error reporting, and in the suite fails whichever test happened
  // to be running when it fired (#381).
  it("a resubscribe stranded by a second disconnect does not reject into nowhere", async () => {
    const server = await fakeServer();
    const transport = testTransport(server);
    const client = createSessionsClient({ transport });
    clients.push(client);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await client.subscribe("S1");
      await waitUntil(() => server.subscribeCalls.length === 1);

      // The reconnect's resubscribe is recorded but never answered, so it is
      // still outstanding when the client disconnects underneath it.
      server.silent = true;
      server.dropAllConnections();
      await waitUntil(() => server.subscribeCalls.length === 2, 5000);

      client.disconnect();
      // Two macrotask turns: the rejection has to be delivered and then
      // reported as unhandled, both of which happen after the current one.
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("delta frames never touch the tracked seq, so a resubscribe after a drop still uses the last real event's seq", async () => {
    const server = await fakeServer();
    const transport = testTransport(server);
    const client = createSessionsClient({ transport });
    clients.push(client);
    const deltas: string[] = [];
    client.onDelta("S1", (d) => deltas.push(d.text));

    await client.subscribe("S1");
    await waitUntil(() => server.subscribeCalls.length === 1);
    server.broadcast({ type: "event", payload: { session_id: "S1", event: { kind: "run_started", payload: {}, seq: 10 } } });
    server.broadcast({
      type: "delta",
      payload: { session_id: "S1", run_id: "R1", channel: "text", text: "streaming..." },
    });
    await waitUntil(() => deltas.length === 1);
    assert.deepEqual(deltas, ["streaming..."]);

    server.dropAllConnections();
    await waitUntil(() => server.subscribeCalls.length === 2, 5000);
    assert.deepEqual(server.subscribeCalls[1], { session_id: "S1", after: 10 });

    client.disconnect();
  });

  it("hands a replay page to event listeners as one batch and resubscribes after its last seq", async () => {
    const server = await fakeServer();
    const transport = testTransport(server);
    const client = createSessionsClient({ transport });
    clients.push(client);
    const batches: number[][] = [];
    client.onEvents("S1", (batch) => batches.push(batch.map((e) => e.seq)));

    await client.subscribe("S1");
    await waitUntil(() => server.subscribeCalls.length === 1);
    server.broadcast({
      type: "events",
      payload: {
        session_id: "S1",
        events: Array.from({ length: 150 }, (_, i) => ({ kind: "assistant_message", payload: { text: `m${i}` }, seq: i + 1 })),
      },
    });
    await waitUntil(() => batches.length === 1);
    assert.equal(batches[0].length, 150);

    server.dropAllConnections();
    await waitUntil(() => server.subscribeCalls.length === 2, 5000);
    assert.deepEqual(server.subscribeCalls[1], { session_id: "S1", after: 150 });

    client.disconnect();
  });

  it("dispatches session_state frames globally, not scoped to a subscribed session", async () => {
    const server = await fakeServer();
    const transport = testTransport(server);
    const client = createSessionsClient({ transport });
    clients.push(client);
    const states: string[] = [];
    client.onSessionStates((batch) => states.push(...batch.map((s) => s.state)));
    const statuses: string[] = [];
    client.onConnectionStatus((s) => statuses.push(s));

    await waitUntil(() => statuses.includes("open"));
    server.broadcast({
      type: "session_state",
      payload: { session_id: "S2", state: "running", waiting_since: null, node_id: "N1" },
    });
    await waitUntil(() => states.length === 1);
    assert.deepEqual(states, ["running"]);

    client.disconnect();
  });

  it("hands the connect snapshot to listeners as one batch", async () => {
    const server = await fakeServer();
    const transport = testTransport(server);
    const client = createSessionsClient({ transport });
    clients.push(client);
    const batches: string[][] = [];
    client.onSessionStates((batch) => batches.push(batch.map((s) => s.session_id)));
    const statuses: string[] = [];
    client.onConnectionStatus((s) => statuses.push(s));

    await waitUntil(() => statuses.includes("open"));
    server.broadcast({
      type: "session_states",
      payload: {
        sessions: Array.from({ length: 120 }, (_, i) => ({
          session_id: `S${i}`,
          state: "suspended",
          waiting_since: null,
          node_id: "N1",
        })),
      },
    });
    await waitUntil(() => batches.length === 1);
    assert.equal(batches[0].length, 120);

    client.disconnect();
  });
});

// #429: Práce keeps one mounted SessionChat per open thread and only flips
// which one is visible, so a switch must not re-subscribe. There is no DOM
// here, so this drives the real client through the mount set the real
// selector computes off the real store, reconciled the way React reconciles
// keyed children -- a key that appears mounts (subscribe), a key that
// disappears unmounts (unsubscribe), a key that stays put does nothing.
describe("sessions-client: the mounted-thread set (#429)", () => {
  function row(id: string, node_id: string | null, state: SessionState): SessionSummary {
    return {
      id,
      node_id,
      user_id: "u1",
      session_type: "interactive_task",
      cli: null,
      instance_id: null,
      terminal_id: null,
      brief: null,
      runner: "claude",
      host_id: null,
      host_label: null,
      waiting_since: null,
      state,
      name: id,
      name_is_custom: false,
      handoff_path: null,
      write_count: 0,
      model: null,
      effort: null,
      context_used_tokens: null,
      context_max_tokens: null,
      created_at: "2026-09-22 10:00:00",
      last_active_at: "2026-09-22 10:00:00",
      closed_at: null,
    };
  }

  function keyedReconciler(client: { subscribe(id: string): Promise<void>; unsubscribe(id: string): void }) {
    let mounted: string[] = [];
    return async (next: readonly { id: string }[]) => {
      const ids = next.map((s) => s.id);
      for (const id of mounted) if (!ids.includes(id)) client.unsubscribe(id);
      for (const id of ids) if (!mounted.includes(id)) await client.subscribe(id);
      mounted = ids;
    };
  }

  it("subscribes once per thread and keeps the subscription across switches, unsubscribing only on close", async () => {
    const server = await fakeServer();
    const client = createSessionsClient({ transport: testTransport(server) });
    clients.push(client);

    const store = createSessionStore();
    store.putMany([row("A", "n1", "running"), row("B", "n1", "suspended"), row("C", "n2", "running")]);
    const render = keyedReconciler(client);

    // Two nodes open, A shown.
    await render(selectMountedThreads(store, ["n1", "n2"], "A"));
    await waitUntil(() => server.subscribeCalls.length === 3);

    // Switch to B, then to C, then back to A: the mounted set never changes.
    await render(selectMountedThreads(store, ["n1", "n2"], "B"));
    await render(selectMountedThreads(store, ["n1", "n2"], "C"));
    await render(selectMountedThreads(store, ["n1", "n2"], "A"));

    const subscribesFor = (id: string) => server.subscribeCalls.filter((call) => call.session_id === id).length;
    assert.equal(subscribesFor("A"), 1);
    assert.equal(subscribesFor("B"), 1);
    assert.equal(subscribesFor("C"), 1);
    assert.deepEqual(server.unsubscribeCalls, []);

    // Closing node n2 drops its records and unsubscribes its thread, and
    // only it.
    store.removeMany(selectNodeRecordIds(store, "n2", "A"));
    await render(selectMountedThreads(store, ["n1"], "A"));
    await waitUntil(() => server.unsubscribeCalls.length === 1);
    assert.deepEqual(server.unsubscribeCalls, ["C"]);

    // Closing thread B (the × on its sub-row) unsubscribes B alone.
    store.put(row("B", "n1", "closed"));
    await render(selectMountedThreads(store, ["n1"], "A"));
    await waitUntil(() => server.unsubscribeCalls.length === 2);
    assert.deepEqual(server.unsubscribeCalls, ["C", "B"]);
    assert.equal(subscribesFor("A"), 1);

    client.disconnect();
  });
});

// #496: a request is delivered once, or reported as failed and never sent
// afterwards. Driven over the real direct-WS transport with an in-memory
// socket class and mocked timers, so a 30 s timeout and a reconnect happen
// without waiting for either.
describe("sessions-client: a timed-out or dropped request is never delivered later (#496)", () => {
  class FakeSocket implements WebSocketInstance {
    static readonly OPEN = 1;
    static instances: FakeSocket[] = [];
    readyState = 0;
    readonly sent: Array<{ id?: string; type: string; payload: { session_id?: string; after?: number } }> = [];
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(readonly url: string) {
      FakeSocket.instances.push(this);
    }
    send(data: string): void {
      if (this.readyState !== FakeSocket.OPEN) throw new Error("send on a socket that is not open");
      this.sent.push(JSON.parse(data));
    }
    close(): void {
      this.readyState = 3;
    }
    open(): void {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.({});
    }
    drop(): void {
      this.readyState = 3;
      this.onclose?.({});
    }
    reply(id: string | undefined): void {
      this.onmessage?.({ data: JSON.stringify({ id, type: "reply", payload: { ok: true } }) });
    }
    static last(): FakeSocket {
      return FakeSocket.instances[FakeSocket.instances.length - 1];
    }
    static allSent(type: string) {
      return FakeSocket.instances.flatMap((s) => s.sent.filter((f) => f.type === type));
    }
  }

  // Settles pending promise callbacks; setImmediate is not mocked.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function settle<T>(p: Promise<T>) {
    const state: { done: boolean; error: Error | null } = { done: false, error: null };
    p.then(
      () => (state.done = true),
      (e: Error) => {
        state.done = true;
        state.error = e;
      },
    );
    return state;
  }

  function fakeClient() {
    FakeSocket.instances = [];
    const transport = createDirectWsTransport("ws://fake/sessions/ws", {
      WebSocket: FakeSocket,
      minBackoffMs: 10,
      maxBackoffMs: 10,
      connectTimeoutMs: 600_000,
    });
    const client = createSessionsClient({ transport });
    clients.push(client);
    return client;
  }

  it("a message that times out during an outage is not sent after the reconnect; the resend arrives once", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const client = fakeClient();
      FakeSocket.last().open();
      FakeSocket.last().drop();

      const first = settle(client.message("S1", "ahoj"));
      mock.timers.tick(10);
      const reconnecting = FakeSocket.last();
      assert.equal(FakeSocket.instances.length, 2);

      mock.timers.tick(30_000);
      await flush();
      assert.equal(first.done, true);
      assert.match(String(first.error), /request_timeout/);

      reconnecting.open();
      assert.deepEqual(FakeSocket.allSent("message"), []);

      const resend = settle(client.message("S1", "ahoj"));
      const sent = FakeSocket.allSent("message");
      assert.equal(sent.length, 1);
      reconnecting.reply(sent[0].id);
      await flush();
      assert.deepEqual(resend, { done: true, error: null });
      assert.equal(FakeSocket.allSent("message").length, 1);
      client.disconnect();
    } finally {
      mock.timers.reset();
    }
  });

  it("a message in flight when the connection drops rejects at once and is not sent again", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const client = fakeClient();
      FakeSocket.last().open();
      const inFlight = settle(client.message("S1", "ahoj"));
      assert.equal(FakeSocket.allSent("message").length, 1);

      FakeSocket.last().drop();
      await flush();
      assert.equal(inFlight.done, true);
      assert.match(String(inFlight.error), /disconnected/);

      mock.timers.tick(10);
      FakeSocket.last().open();
      mock.timers.tick(60_000);
      await flush();
      assert.equal(FakeSocket.allSent("message").length, 1);
      client.disconnect();
    } finally {
      mock.timers.reset();
    }
  });

  it("a subscribe that finishes after a long outage resolves without an error, subscribing once per connection", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const client = fakeClient();
      // Subscribed before the first open: nothing goes out until it opens.
      const load = settle(client.subscribe("S1", 0));
      assert.deepEqual(FakeSocket.allSent("subscribe"), []);
      FakeSocket.last().open();
      assert.equal(FakeSocket.allSent("subscribe").length, 1);

      // The connection drops before the reply and stays down past the
      // request timeout.
      FakeSocket.last().drop();
      mock.timers.tick(10);
      mock.timers.tick(120_000);
      await flush();
      assert.equal(load.done, false);

      const reopened = FakeSocket.last();
      reopened.open();
      assert.equal(reopened.sent.filter((f) => f.type === "subscribe").length, 1);
      assert.equal(FakeSocket.allSent("subscribe").length, 2);
      reopened.reply(reopened.sent[0].id);
      await flush();
      assert.deepEqual(load, { done: true, error: null });
      client.disconnect();
    } finally {
      mock.timers.reset();
    }
  });

  it("a timed-out request cancels its own frame on the transport (the Tauri outbox's cancel path)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const sent: string[] = [];
      const cancelled: string[] = [];
      let status: ((s: "open" | "reconnecting" | "closed") => void) | null = null;
      const noop = () => undefined;
      const transport: Transport = {
        send: (frame) => sent.push(frame.id),
        cancel: (id) => cancelled.push(id),
        onFrame: () => noop,
        onStatus: (cb) => {
          status = cb;
          return noop;
        },
        connect: noop,
        disconnect: noop,
      };
      const client = createSessionsClient({ transport });
      clients.push(client);
      (status as unknown as (s: string) => void)("open");
      const req = settle(client.interrupt("S1"));
      mock.timers.tick(30_000);
      await flush();
      assert.match(String(req.error), /request_timeout/);
      assert.deepEqual(cancelled, sent);
      client.disconnect();
    } finally {
      mock.timers.reset();
    }
  });
});
