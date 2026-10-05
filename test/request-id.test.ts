// #573: one request id end to end. http/server.ts takes the caller's
// X-Portuni-Request-Id (or mints one), echoes it, puts it in respondError's
// body and log line, and the sync agent forwards it to the central server
// when it calls there on that request's behalf.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { authFetch, useTestBearer } from "./helpers/auth.js";
import { startHttpServer, type HttpServerHandle, type StartHttpServerOptions } from "../apps/server/http/server.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { createAgentRouter } from "../apps/server/api/agent-router.js";
import { createHttpCentralClient } from "../apps/server/domain/sync/central/client.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import {
  currentRequestId,
  requestIdFromHeader,
  runWithRequestId,
} from "../apps/server/infra/request-context.js";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function start(router: NonNullable<StartHttpServerOptions["router"]>): Promise<{ handle: HttpServerHandle; base: string }> {
  const handle = startHttpServer({ port: 0, host: "127.0.0.1", registerSigint: false, router, mountMcp: false });
  if (!handle.server.listening) await new Promise<void>((r) => handle.server.once("listening", r));
  const addr = handle.server.address() as AddressInfo;
  process.env.PORT = String(addr.port);
  resetGateCachesForTesting();
  return { handle, base: `http://127.0.0.1:${addr.port}` };
}

describe("request id (#573)", () => {
  let workspace: string;
  let originalRoot: string | undefined;
  let originalPort: string | undefined;
  let handle: HttpServerHandle | null = null;
  const logged: string[] = [];
  const realConsoleError = console.error;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-reqid-"));
    originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
    originalPort = process.env.PORT;
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    useTestBearer();
    resetLocalDbForTests();
    logged.length = 0;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  });

  afterEach(async () => {
    console.error = realConsoleError;
    await handle?.shutdown();
    handle = null;
    resetGateCachesForTesting();
    resetLocalDbForTests();
    if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
    else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    await rm(workspace, { recursive: true, force: true });
  });

  it("echoes an incoming id and runs the handler inside it", async () => {
    let seen: string | undefined;
    const s = await start(async (_req, res) => {
      seen = currentRequestId();
      res.writeHead(200).end("{}");
      return true;
    });
    handle = s.handle;
    const r = await authFetch(`${s.base}/anything`, { headers: { "X-Portuni-Request-Id": "01JABCDEFGHJKMNPQRSTVWXYZ0" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-portuni-request-id"), "01JABCDEFGHJKMNPQRSTVWXYZ0");
    assert.equal(seen, "01JABCDEFGHJKMNPQRSTVWXYZ0");
  });

  it("mints an id when the caller sent none or a malformed one", async () => {
    const s = await start(async (_req, res) => {
      res.writeHead(200).end("{}");
      return true;
    });
    handle = s.handle;
    const none = await authFetch(`${s.base}/anything`);
    assert.match(none.headers.get("x-portuni-request-id") ?? "", ULID);
    const bad = await authFetch(`${s.base}/anything`, { headers: { "X-Portuni-Request-Id": "has space\tand tab" } });
    assert.match(bad.headers.get("x-portuni-request-id") ?? "", ULID);
    assert.match(requestIdFromHeader("x".repeat(65)), ULID);
  });

  it("a 500 carries the same id in the header, the body and the log line", async () => {
    const s = await start(async () => {
      throw new Error("boom");
    });
    handle = s.handle;
    const r = await authFetch(`${s.base}/explode`, { headers: { "X-Portuni-Request-Id": "req-500-abc" } });
    assert.equal(r.status, 500);
    assert.equal(r.headers.get("x-portuni-request-id"), "req-500-abc");
    const body = (await r.json()) as { request_id?: string; code?: string };
    assert.equal(body.code, "INTERNAL_ERROR");
    assert.equal(body.request_id, "req-500-abc");
    assert.ok(logged.some((l) => l.startsWith("[req:req-500-abc]") && l.includes("boom")), logged.join("\n"));
  });

  it("the sync agent forwards the id of the request it serves to the central server", async () => {
    const centralCalls: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      centralCalls.push((init?.headers ?? {}) as Record<string, string>);
      return { status: 404, json: async () => ({ error: "not found", code: "NOT_FOUND" }) } as Response;
    }) as typeof fetch;
    const client = createHttpCentralClient({ baseUrl: "https://central.example", token: "ptk", fetchImpl, syncInfoTtlMs: 0 });
    const s = await start(createAgentRouter(client));
    handle = s.handle;
    const r = await authFetch(`${s.base}/nodes/N1/sync-status`, { headers: { "X-Portuni-Request-Id": "req-agent-1" } });
    assert.equal(r.headers.get("x-portuni-request-id"), "req-agent-1");
    assert.ok(centralCalls.length > 0, "the agent called the central server");
    for (const h of centralCalls) assert.equal(h["x-portuni-request-id"], "req-agent-1");
  });

  it("a central call outside any request (a watcher tick) mints its own id, a retry keeps it", async () => {
    const ids: string[] = [];
    let first = true;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      ids.push(((init?.headers ?? {}) as Record<string, string>)["x-portuni-request-id"]);
      if (first) {
        first = false;
        throw new TypeError("fetch failed");
      }
      return { status: 200, json: async () => ({ node: { id: "N1" }, remote_name: "r", files: [] }) } as Response;
    }) as typeof fetch;
    const client = createHttpCentralClient({ baseUrl: "https://central.example", token: "ptk", fetchImpl, syncInfoTtlMs: 0 });
    await client.syncInfo("N1");
    assert.equal(ids.length, 2);
    assert.match(ids[0], ULID);
    assert.equal(ids[1], ids[0]);
    await runWithRequestId("inside-1", () => client.syncInfo("N1"));
    assert.equal(ids[2], "inside-1");
  });
});
