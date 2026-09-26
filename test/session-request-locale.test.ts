// #538: the web sends `locale` with POST /sessions, a message, Předat and
// Pokračovat v nové session, and the server hands it to the session runtime
// (which writes the handoff file and the default thread name in it, #539).
// Asserted on every path those requests take: the personal workspace's own
// REST routes, the sync agent's router in a team workspace, and the live
// channel's frames. A spy runtime records what it was called with.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { authHeaders, useTestBearer } from "./helpers/auth.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { createAgentRouter } from "../apps/server/api/agent-router.js";
import { createSessionsWsServer, type SessionsWsDeps } from "../apps/server/api/sessions-ws.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { setSessionRuntimeForTesting } from "../apps/server/boot/session-runtime.js";
import type { SessionRuntime } from "../apps/server/domain/runner/session-runtime.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import { createSession } from "../apps/server/domain/sessions.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { SessionRow } from "../apps/server/shared/types.js";

interface Call {
  method: string;
  args: unknown[];
}

let calls: Call[] = [];
let row: SessionRow = { id: "S1" } as SessionRow;

// Records every runtime call and answers with the one row the test set up.
const spyRuntime = {
  async createDraft(...args: unknown[]) {
    calls.push({ method: "createDraft", args });
    return row;
  },
  async sendMessage(...args: unknown[]) {
    calls.push({ method: "sendMessage", args });
  },
  async continueSession(...args: unknown[]) {
    calls.push({ method: "continueSession", args });
    return { session: row, run: null };
  },
  async handoff(...args: unknown[]) {
    calls.push({ method: "handoff", args });
    return { session: row, handoff_path: `wip/sessions/${row.id}-handoff.md` };
  },
  async getSession() {
    return row;
  },
  subscribe: () => () => undefined,
} as unknown as SessionRuntime;

function lastCall(method: string): Call {
  const call = calls.filter((c) => c.method === method).at(-1);
  assert.ok(call, `runtime.${method} was not called`);
  return call;
}

const identity: RequestIdentity = {
  userId: "U1",
  email: "u1@x.com",
  name: "U1",
  globalScope: "admin",
  groups: [],
  groupIds: [],
  via: "env",
};

interface Captured {
  statusCode: number;
  body: string;
}

function mockReqRes(path: string, bodyJson: unknown): { req: IncomingMessage; res: ServerResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, body: "" };
  const bodyStr = bodyJson === undefined ? "" : JSON.stringify(bodyJson);
  const req = new Readable({
    read() {
      if (bodyStr) this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = "POST";
  req.url = path;
  req.headers = { "content-type": "application/json" };
  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (code: number) => void }).writeHead = (code: number) => {
    captured.statusCode = code;
  };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };
  return { req, res, captured };
}

type Post = (path: string, body: unknown) => Promise<Captured>;

// The same four requests against either router.
function requestCases(post: Post, ids: () => { sessionId: string; nodeId: string }): void {
  it("POST /sessions hands the locale to the runtime", async () => {
    const res = await post("/sessions", { node_id: ids().nodeId, locale: "cs" });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal((lastCall("createDraft").args[0] as { locale?: string }).locale, "cs");
  });

  it("a message hands the locale to the runtime", async () => {
    const res = await post(`/sessions/${ids().sessionId}/messages`, { text: "hi", locale: "cs" });
    assert.equal(res.statusCode, 202, res.body);
    assert.deepEqual(lastCall("sendMessage").args, [ids().sessionId, "hi", { locale: "cs" }]);
  });

  it("Pokračovat v nové session hands the locale to the runtime", async () => {
    const res = await post(`/sessions/${ids().sessionId}/continue`, { locale: "en" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(lastCall("continueSession").args, [ids().sessionId, { locale: "en" }]);
  });

  it("Předat hands the locale to the runtime", async () => {
    const res = await post(`/sessions/${ids().sessionId}/handoff`, { locale: "cs" });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(lastCall("handoff").args, [ids().sessionId, { locale: "cs" }]);
  });

  it("Předat with no body at all still works, with no locale", async () => {
    const res = await post(`/sessions/${ids().sessionId}/handoff`, undefined);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(lastCall("handoff").args, [ids().sessionId, { locale: undefined }]);
  });

  it("an unsupported locale is a 400 and never reaches the runtime", async () => {
    const res = await post(`/sessions/${ids().sessionId}/messages`, { text: "hi", locale: "de" });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "INVALID_REQUEST");
    assert.equal(calls.length, 0);
  });
}

describe("session requests carry the locale to the runtime (#538)", () => {
  before(() => {
    delete process.env.PORTUNI_WEBVIEW_PROXY_SECRET;
  });

  beforeEach(() => {
    calls = [];
  });

  describe("personal workspace: the local REST routes", () => {
    let dbFixture: SharedDb;
    let sessionId = "";

    beforeEach(async () => {
      dbFixture = await makeSharedDb();
      setDbForTesting(dbFixture.db);
      setSessionRuntimeForTesting(spyRuntime);
      row = await createSession(dbFixture.db, "U1", {
        node_id: dbFixture.nodeId,
        session_type: "interactive_task",
      });
      sessionId = row.id;
    });

    after(() => {
      setSessionRuntimeForTesting(null);
      setDbForTesting(null);
    });

    const post: Post = async (path, body) => {
      const { req, res, captured } = mockReqRes(path, body);
      await routeApiRequest(req, res, new URL(`http://localhost${path}`), identity);
      return captured;
    };
    requestCases(post, () => ({ sessionId, nodeId: dbFixture.nodeId }));
  });

  describe("team workspace: the sync agent's router", () => {
    // No CentralClient method is involved: the runtime is the spy, and
    // nothing about the locale goes to the central server.
    const route = createAgentRouter({} as CentralClient, { sessionRuntime: spyRuntime });

    beforeEach(() => {
      row = { id: "S1" } as SessionRow;
    });

    const post: Post = async (path, body) => {
      const { req, res, captured } = mockReqRes(path, body);
      assert.equal(await route(req, res, new URL(`http://localhost${path}`), identity), true);
      return captured;
    };
    requestCases(post, () => ({ sessionId: "S1", nodeId: "N1" }));
  });

  describe("live channel: message, continue and handoff frames", () => {
    let handle: HttpServerHandle;
    let wsUrl: string;

    const deps: SessionsWsDeps = {
      runtime: () => spyRuntime,
      access: async (_identity, sessionId) => ({ id: sessionId }) as SessionRow,
      snapshot: async () => [],
      canSee: async () => true,
      audit: async () => undefined,
    };

    before(async () => {
      useTestBearer();
      handle = startHttpServer({
        port: 0,
        host: "127.0.0.1",
        registerSigint: false,
        router: async () => false,
        mcpTransport: undefined,
        mountMcp: false,
        sessionsWs: createSessionsWsServer(deps),
      });
      if (!handle.server.listening) {
        await new Promise<void>((r) => handle.server.once("listening", r));
      }
      const addr = handle.server.address() as AddressInfo;
      wsUrl = `ws://127.0.0.1:${addr.port}/sessions/ws`;
      process.env.PORT = String(addr.port);
      resetGateCachesForTesting();
      // The replies to continue and handoff summarise the session row the
      // way the personal workspace does, off the graph db.
      const dbFixture = await makeSharedDb();
      setDbForTesting(dbFixture.db);
      row = await createSession(dbFixture.db, "U1", {
        node_id: dbFixture.nodeId,
        session_type: "interactive_task",
      });
    });

    after(async () => {
      await handle.shutdown();
      resetGateCachesForTesting();
      setDbForTesting(null);
    });

    // Sends one frame and resolves with the reply to it.
    async function sendFrame(type: string, payload: Record<string, unknown>): Promise<{ type: string }> {
      const ws = new WebSocket(wsUrl, { headers: authHeaders() });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        const reply = new Promise<{ type: string }>((resolve) => {
          ws.on("message", (data) => {
            const frame = JSON.parse(data.toString("utf8")) as { id?: string; type: string };
            if (frame.id === "f1") resolve(frame);
          });
        });
        ws.send(JSON.stringify({ id: "f1", type, payload }));
        return await reply;
      } finally {
        ws.close();
      }
    }

    it("the message frame hands the locale to the runtime", async () => {
      const reply = await sendFrame("message", { session_id: row.id, text: "hi", locale: "cs" });
      assert.notEqual(reply.type, "error");
      assert.deepEqual(lastCall("sendMessage").args, [row.id, "hi", { locale: "cs" }]);
    });

    it("the continue frame hands the locale to the runtime", async () => {
      const reply = await sendFrame("continue", { session_id: row.id, locale: "cs" });
      assert.notEqual(reply.type, "error");
      assert.deepEqual(lastCall("continueSession").args, [row.id, { locale: "cs" }]);
    });

    it("the handoff frame hands the locale to the runtime", async () => {
      const reply = await sendFrame("handoff", { session_id: row.id, locale: "en" });
      assert.notEqual(reply.type, "error");
      assert.deepEqual(lastCall("handoff").args, [row.id, { locale: "en" }]);
    });

    it("an unsupported locale is refused as an invalid frame", async () => {
      const reply = await sendFrame("message", { session_id: "S1", text: "hi", locale: "de" });
      assert.equal(reply.type, "error");
      assert.equal(calls.length, 0);
    });
  });
});
