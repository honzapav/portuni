// Session live channel TS client (#341,
// docs/superpowers/specs/2026-09-12-runner-and-session-design.md). Exercises
// the direct-WS transport (the dev-mode path -- there is no Tauri runtime
// in this test environment) against a small fake `ws` server standing in
// for apps/server/api/sessions-ws.ts.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";
import { createSessionsClient, createDirectWsTransport } from "../apps/web/src/lib/sessions-client.js";

interface SubscribeCall {
  session_id: string;
  after?: number;
}

class FakeSessionsServer {
  readonly wss: WebSocketServer;
  private readonly sockets = new Set<WsSocket>();
  readonly subscribeCalls: SubscribeCall[] = [];
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
    client.onEvent("S1", (event) => received.push(event.seq));

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
    server.broadcast({ type: "delta", payload: { session_id: "S1", run_id: "R1", text: "streaming..." } });
    await waitUntil(() => deltas.length === 1);
    assert.deepEqual(deltas, ["streaming..."]);

    server.dropAllConnections();
    await waitUntil(() => server.subscribeCalls.length === 2, 5000);
    assert.deepEqual(server.subscribeCalls[1], { session_id: "S1", after: 10 });

    client.disconnect();
  });

  it("dispatches session_state frames globally, not scoped to a subscribed session", async () => {
    const server = await fakeServer();
    const transport = testTransport(server);
    const client = createSessionsClient({ transport });
    clients.push(client);
    const states: string[] = [];
    client.onSessionState((s) => states.push(s.state));
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
});
