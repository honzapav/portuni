// #530: NO_LIVE_RUN comes from the error's type (NoLiveRunError), never
// from its message text, on all three paths a message reaches the runtime:
// the local REST route, the sync agent's router and the live channel's
// `message` frame. A fake runtime throws; the client's code is asserted.

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
import { NoLiveRunError, type SessionRuntime } from "../apps/server/domain/runner/session-runtime.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import { createSession } from "../apps/server/domain/sessions.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { SessionRow } from "../apps/server/shared/types.js";

// What the fake runtime's sendMessage throws next.
let nextError: () => Error = () => new Error("unset");

function rewordedNoLiveRun(sessionId: string): Error {
  const err = new NoLiveRunError("sendMessage", sessionId);
  err.message = "reworded text";
  return err;
}

function plainErrorWithOldText(sessionId: string): Error {
  return new Error(`sendMessage: session ${sessionId} has no live run`);
}

const fakeRuntime = {
  async sendMessage(): Promise<void> {
    throw nextError();
  },
  subscribe: () => () => undefined,
} as unknown as SessionRuntime;

const identity: RequestIdentity = {
  userId: "U1",
  email: "u1@x.com",
  name: "U1",
  globalScope: "write",
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
  const bodyStr = JSON.stringify(bodyJson);
  const req = new Readable({
    read() {
      this.push(Buffer.from(bodyStr));
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

describe("NO_LIVE_RUN comes from the error type, not its message (#530)", () => {
  before(() => {
    delete process.env.PORTUNI_WEBVIEW_PROXY_SECRET;
  });

  describe("local REST: POST /sessions/:id/messages", () => {
    let dbFixture: SharedDb;
    let sessionId: string;

    beforeEach(async () => {
      dbFixture = await makeSharedDb();
      setDbForTesting(dbFixture.db);
      setSessionRuntimeForTesting(fakeRuntime);
      const session = await createSession(dbFixture.db, "U1", {
        node_id: dbFixture.nodeId,
        session_type: "interactive_task",
      });
      sessionId = session.id;
    });

    after(() => {
      setSessionRuntimeForTesting(null);
      setDbForTesting(null);
    });

    async function post(): Promise<Captured> {
      const path = `/sessions/${sessionId}/messages`;
      const { req, res, captured } = mockReqRes(path, { text: "hi" });
      await routeApiRequest(req, res, new URL(`http://localhost${path}`), identity);
      return captured;
    }

    it("a reworded NoLiveRunError is a 409 NO_LIVE_RUN", async () => {
      nextError = () => rewordedNoLiveRun(sessionId);
      const res = await post();
      assert.equal(res.statusCode, 409);
      assert.equal(JSON.parse(res.body).code, "NO_LIVE_RUN");
    });

    it("a plain Error saying 'has no live run' is a generic 500, not NO_LIVE_RUN", async () => {
      nextError = () => plainErrorWithOldText(sessionId);
      const res = await post();
      assert.equal(res.statusCode, 500);
      assert.notEqual(JSON.parse(res.body).code, "NO_LIVE_RUN");
    });
  });

  describe("sync agent router: POST /sessions/:id/messages", () => {
    const route = createAgentRouter({} as CentralClient, { sessionRuntime: fakeRuntime });

    async function post(sessionId: string): Promise<Captured> {
      const path = `/sessions/${sessionId}/messages`;
      const { req, res, captured } = mockReqRes(path, { text: "hi" });
      assert.equal(await route(req, res, new URL(`http://localhost${path}`), identity), true);
      return captured;
    }

    it("a reworded NoLiveRunError is a 409 NO_LIVE_RUN", async () => {
      nextError = () => rewordedNoLiveRun("S1");
      const res = await post("S1");
      assert.equal(res.statusCode, 409);
      assert.equal(JSON.parse(res.body).code, "NO_LIVE_RUN");
    });

    it("a plain Error saying 'has no live run' is a generic 500, not NO_LIVE_RUN", async () => {
      nextError = () => plainErrorWithOldText("S1");
      const res = await post("S1");
      assert.equal(res.statusCode, 500);
      assert.notEqual(JSON.parse(res.body).code, "NO_LIVE_RUN");
    });
  });

  describe("live channel: the message frame", () => {
    let handle: HttpServerHandle;
    let wsUrl: string;

    const deps: SessionsWsDeps = {
      runtime: () => fakeRuntime,
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
      // The host allowlist is derived from PORT.
      process.env.PORT = String(addr.port);
      resetGateCachesForTesting();
    });

    after(async () => {
      await handle.shutdown();
      resetGateCachesForTesting();
    });

    // Sends one message frame and resolves with the error reply to it.
    async function sendMessageFrame(sessionId: string): Promise<{ code: string }> {
      const ws = new WebSocket(wsUrl, { headers: authHeaders() });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        const reply = new Promise<{ type: string; payload: { code: string } }>((resolve) => {
          ws.on("message", (data) => {
            const frame = JSON.parse(data.toString("utf8")) as { id?: string; type: string; payload: { code: string } };
            if (frame.id === "m1") resolve(frame);
          });
        });
        ws.send(JSON.stringify({ id: "m1", type: "message", payload: { session_id: sessionId, text: "hi" } }));
        const frame = await reply;
        assert.equal(frame.type, "error");
        return frame.payload;
      } finally {
        ws.close();
      }
    }

    it("a reworded NoLiveRunError is an error reply with NO_LIVE_RUN", async () => {
      nextError = () => rewordedNoLiveRun("S1");
      assert.equal((await sendMessageFrame("S1")).code, "NO_LIVE_RUN");
    });

    it("a plain Error saying 'has no live run' is INTERNAL_ERROR, not NO_LIVE_RUN", async () => {
      nextError = () => plainErrorWithOldText("S1");
      assert.equal((await sendMessageFrame("S1")).code, "INTERNAL_ERROR");
    });
  });
});
