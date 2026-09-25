// #531: every error a session route, the sync agent's router or the live
// channel sends carries a stable `code` from shared/error-codes.ts and the
// `params` the web's catalog message interpolates; `error`/`message` is
// English and for logs only.
//
// (a) a SessionHandoffError with params reaches the REST body
//     `{ error, code, params }` and the live channel's error frame
//     `{ type: "error", id, payload: { code, message, params } }`.
// (b) team workspace: an error the central server answers (a coded 409 or
//     404 with params, raised here by a fake CentralClient) reaches the HTTP
//     response of the sync agent's router with the same status, code and
//     params.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { authHeaders, useTestBearer } from "./helpers/auth.js";
import { createAgentRouter } from "../apps/server/api/agent-router.js";
import { createSessionsWsServer, errorFrameFor, type SessionsWsDeps } from "../apps/server/api/sessions-ws.js";
import { respondSessionRefusal, sessionRefusal } from "../apps/server/api/session-refusals.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { SessionHandoffError, type SessionRuntime } from "../apps/server/domain/runner/session-runtime.js";
import { CentralHttpError, type CentralClient } from "../apps/server/domain/sync/central/client.js";
import { isErrorCode } from "../apps/server/shared/error-codes.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import type { SessionRow } from "../apps/server/shared/types.js";

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

function mockReqRes(
  method: string,
  path: string,
  bodyJson?: unknown,
): { req: IncomingMessage; res: ServerResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, body: "" };
  const bodyStr = bodyJson === undefined ? "" : JSON.stringify(bodyJson);
  const req = new Readable({
    read() {
      if (bodyStr) this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
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

function runElsewhere(): SessionHandoffError {
  return new SessionHandoffError(
    "HANDOFF_RUN_ELSEWHERE",
    "the thread is running on device MacBook Pro; it can only be handed off there",
    { host: "MacBook Pro" },
  );
}

const fakeRuntime = {
  async handoff(): Promise<never> {
    throw runElsewhere();
  },
  subscribe: () => () => undefined,
} as unknown as SessionRuntime;

describe("session refusals carry code and params (#531)", () => {
  before(() => {
    delete process.env.PORTUNI_WEBVIEW_PROXY_SECRET;
  });

  it("sessionRefusal keeps the error's params; every refusal code is an ErrorCode", () => {
    const refusal = sessionRefusal(runElsewhere());
    assert.deepEqual(refusal, {
      status: 409,
      code: "HANDOFF_RUN_ELSEWHERE",
      message: "the thread is running on device MacBook Pro; it can only be handed off there",
      params: { host: "MacBook Pro" },
    });
    for (const code of [
      "HANDOFF_NOT_ALLOWED",
      "HANDOFF_NO_MIRROR",
      "HANDOFF_RUN_ELSEWHERE",
      "HANDOFF_TRANSCRIPT_ELSEWHERE",
      "SESSION_TRANSCRIPT_ELSEWHERE",
      "HANDOFF_NO_CONTENT",
      "HANDOFF_FILE_NOT_HERE",
      "HANDOFF_PATH_INVALID",
      "NO_LIVE_RUN",
    ]) {
      assert.ok(isErrorCode(code), code);
    }
  });

  it("REST: respondSessionRefusal answers 409 { error, code, params }", () => {
    const { res, captured } = mockReqRes("POST", "/x");
    assert.equal(respondSessionRefusal(res, runElsewhere()), true);
    assert.equal(captured.statusCode, 409);
    assert.deepEqual(JSON.parse(captured.body), {
      error: "the thread is running on device MacBook Pro; it can only be handed off there",
      code: "HANDOFF_RUN_ELSEWHERE",
      params: { host: "MacBook Pro" },
    });
  });

  it("REST: a refusal with no params carries no params key", () => {
    const { res, captured } = mockReqRes("POST", "/x");
    respondSessionRefusal(res, new SessionHandoffError("HANDOFF_NO_CONTENT", "not here yet"));
    assert.deepEqual(JSON.parse(captured.body), { error: "not here yet", code: "HANDOFF_NO_CONTENT" });
  });

  it("sync agent router: POST /sessions/:id/handoff relays code and params", async () => {
    const route = createAgentRouter({} as CentralClient, { sessionRuntime: fakeRuntime });
    const path = "/sessions/S1/handoff";
    const { req, res, captured } = mockReqRes("POST", path);
    assert.equal(await route(req, res, new URL(`http://localhost${path}`), identity), true);
    assert.equal(captured.statusCode, 409);
    const body = JSON.parse(captured.body) as { code: string; params: unknown; error: string };
    assert.equal(body.code, "HANDOFF_RUN_ELSEWHERE");
    assert.deepEqual(body.params, { host: "MacBook Pro" });
  });

  it("errorFrameFor maps refusals, central coded errors and anything else", () => {
    assert.deepEqual(errorFrameFor(runElsewhere()), {
      code: "HANDOFF_RUN_ELSEWHERE",
      message: "the thread is running on device MacBook Pro; it can only be handed off there",
      params: { host: "MacBook Pro" },
    });
    assert.deepEqual(
      errorFrameFor(new CentralHttpError("session S1 not found", 404, "SESSION_NOT_FOUND", undefined, { id: "S1" })),
      { code: "SESSION_NOT_FOUND", message: "session S1 not found", params: { id: "S1" } },
    );
    assert.deepEqual(errorFrameFor(new CentralHttpError("boom", 502, "SOMETHING")), {
      code: "INTERNAL_ERROR",
      message: "internal error",
    });
    assert.deepEqual(errorFrameFor(new Error("boom")), { code: "INTERNAL_ERROR", message: "internal error" });
  });

  describe("live channel: the handoff frame", () => {
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
      process.env.PORT = String(addr.port);
      resetGateCachesForTesting();
    });

    after(async () => {
      await handle.shutdown();
      resetGateCachesForTesting();
    });

    async function reply(frame: Record<string, unknown>): Promise<{ id?: string; type: string; payload: unknown }> {
      const ws = new WebSocket(wsUrl, { headers: authHeaders() });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        const answer = new Promise<{ id?: string; type: string; payload: unknown }>((resolve) => {
          ws.on("message", (data) => {
            const f = JSON.parse(data.toString("utf8")) as { id?: string; type: string; payload: unknown };
            if (f.id === frame.id) resolve(f);
          });
        });
        ws.send(JSON.stringify(frame));
        return await answer;
      } finally {
        ws.close();
      }
    }

    it("a refused Předat is { type: error, id, payload: { code, message, params } }", async () => {
      const frame = await reply({ id: "h1", type: "handoff", payload: { session_id: "S1" } });
      assert.deepEqual(frame, {
        id: "h1",
        type: "error",
        payload: {
          code: "HANDOFF_RUN_ELSEWHERE",
          message: "the thread is running on device MacBook Pro; it can only be handed off there",
          params: { host: "MacBook Pro" },
        },
      });
    });

    it("a malformed frame that carries an id gets INVALID_REQUEST", async () => {
      const frame = await reply({ id: "bad1", type: "handoff", payload: {} });
      assert.equal(frame.type, "error");
      assert.equal((frame.payload as { code: string }).code, "INVALID_REQUEST");
    });
  });
});

// A team-workspace device: no mirror here, so the file routes go straight to
// the central server through the CentralClient, and what it answers is what
// the web gets.
describe("team workspace: central errors reach the agent router's response (#531)", () => {
  let savedRoot: string | undefined;

  before(() => {
    delete process.env.PORTUNI_WEBVIEW_PROXY_SECRET;
    // No workspace root: this device has no mirror for any node.
    savedRoot = process.env.PORTUNI_WORKSPACE_ROOT;
    delete process.env.PORTUNI_WORKSPACE_ROOT;
  });

  after(() => {
    if (savedRoot !== undefined) process.env.PORTUNI_WORKSPACE_ROOT = savedRoot;
  });

  const fakeCentral = {
    async putFileRaw(): Promise<never> {
      throw new CentralHttpError("file changed on the remote: wip/a.md", 409, "CONFLICT", "v2", { path: "wip/a.md" });
    },
    async getFileRaw(): Promise<never> {
      throw new CentralHttpError("file not found: wip/a.md", 404, "NOT_FOUND", undefined, { path: "wip/a.md" });
    },
    async deleteFileRecord(nodeId: string, fileId: string): Promise<never> {
      if (fileId === "F-uncoded") throw new CentralHttpError("not found", 404);
      throw new CentralHttpError(`file ${fileId} not found`, 404, "FILE_NOT_FOUND", undefined, { fileId, nodeId });
    },
  } as unknown as CentralClient;
  const route = createAgentRouter(fakeCentral, { sessionRuntime: fakeRuntime });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const { req, res, captured } = mockReqRes(method, path, body);
    assert.equal(await route(req, res, new URL(`http://localhost${path}`), identity), true);
    return { status: captured.statusCode, body: JSON.parse(captured.body) as Record<string, unknown> };
  }

  it("PUT /nodes/:id/file: a central 409 keeps its code, params and currentVersion", async () => {
    const r = await call("PUT", `/nodes/N1/file?path=${encodeURIComponent("wip/a.md")}`, { content: "x" });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, {
      currentVersion: "v2",
      error: "file changed on the remote: wip/a.md",
      code: "CONFLICT",
      params: { path: "wip/a.md" },
    });
  });

  it("GET /nodes/:id/file: a central 404 keeps its code and params", async () => {
    const r = await call("GET", `/nodes/N1/file?path=${encodeURIComponent("wip/a.md")}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "NOT_FOUND");
    assert.deepEqual(r.body.params, { path: "wip/a.md" });
  });

  it("DELETE /nodes/:id/files/:fid: a coded central 404 is relayed, an uncoded one is NODE_NOT_FOUND", async () => {
    const coded = await call("DELETE", "/nodes/N1/files/F1?confirmed=true");
    assert.equal(coded.status, 404);
    assert.equal(coded.body.code, "FILE_NOT_FOUND");
    assert.deepEqual(coded.body.params, { fileId: "F1", nodeId: "N1" });

    const uncoded = await call("DELETE", "/nodes/N1/files/F-uncoded?confirmed=true");
    assert.equal(uncoded.status, 404);
    assert.equal(uncoded.body.code, "NODE_NOT_FOUND");
    assert.equal(uncoded.body.params, undefined);
  });

  it("the device's own refusals carry a code too", async () => {
    const r = await call("DELETE", "/nodes/N1/files/F1");
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "CONFIRMATION_REQUIRED");
  });
});
