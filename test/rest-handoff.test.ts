// Showtime handoff (spec docs/superpowers/specs/2026-09-02-showtime-handoff-design.md):
// POST /auth/handoff mints a one-time code bound to the caller's bearer and a
// node; POST /auth/handoff/exchange (public, loopback only) trades it for the
// bearer, the node's MCP URL and its mirror on this device.
//
// Google mode with device tokens so the bearer is a real per-user credential
// and node_access restrictions apply (env mode is always admin and sees every
// node). The HTTP server listens on loopback, so the non-loopback refusal is
// exercised through the handler with a mock socket instead.

process.env.PORT = "14951";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";
delete process.env.PORTUNI_URL;
delete process.env.PORTUNI_AGENT_MODE;

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ulid } from "ulid";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import {
  resetGateCachesForTesting,
  setIdentityContextForTesting,
  resetIdentityContextForTesting,
} from "../apps/server/http/middleware.js";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { mintDeviceToken } from "../apps/server/auth/device-tokens.js";
import type { IdentityAdapter, Identity } from "../apps/server/auth/adapter.js";
import {
  HANDOFF_TTL_MS,
  exchangeHandoff,
  isLoopbackAddress,
  mintHandoff,
  resetHandoffsForTesting,
} from "../apps/server/domain/handoff.js";
import { handleExchangeHandoff } from "../apps/server/api/auth.js";

const base = "http://127.0.0.1:14951";
const JWT_SECRET = "0123456789abcdef0123456789abcdef";
const INSIDER = "01INSIDER00000000000000000";
const OUTSIDER = "01OUTSIDER0000000000000000";

let handle: HttpServerHandle;
let workspace: string;
let db: Client;
let insiderToken: string;
let outsiderToken: string;
let orgId: string;
let openNodeId: string;
let restrictedNodeId: string;

// Access is keyed by email: the insider is in eng@x.com, the outsider is not.
function adapter(): IdentityAdapter {
  return {
    async verify(): Promise<Identity> {
      throw new Error("verify() not used");
    },
    async resolveAccess(email: string) {
      return email === "insider@x.com"
        ? { globalScope: "write" as const, groups: ["eng@x.com"], groupIds: [] }
        : { globalScope: "write" as const, groups: ["other@x.com"], groupIds: [] };
    },
  };
}

async function insertUser(id: string, email: string): Promise<void> {
  await db.execute({
    sql: "INSERT INTO users (id, email, name) VALUES (?, ?, ?)",
    args: [id, email, email.split("@")[0]],
  });
}

async function insertNode(
  parentId: string | null,
  opts: { name: string; type?: string; accessGroup?: string },
): Promise<string> {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
          VALUES (?, ?, ?, 'active', 'team', ?, ?)`,
    args: [id, opts.type ?? "project", opts.name, `k-${id}`, INSIDER],
  });
  if (parentId) {
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), id, parentId, INSIDER],
    });
  }
  if (opts.accessGroup) {
    await db.execute({
      sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
            VALUES (?, 'group', ?, ?, ?)`,
      args: [id, opts.accessGroup, opts.accessGroup, INSIDER],
    });
  }
  return id;
}

function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function mint(nodeId: string, token: string): Promise<string> {
  const res = await post("/auth/handoff", { node_id: nodeId }, token);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as { code: string; expires_in: number };
  assert.equal(body.expires_in, 60);
  assert.ok(body.code.length >= 40, "32 random bytes, base64url");
  return body.code;
}

before(async () => {
  resetGateCachesForTesting();
  resetHandoffsForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-handoff-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);
  setIdentityContextForTesting({
    db,
    mode: "google",
    jwtSecret: JWT_SECRET,
    adapter: adapter(),
    soloUserId: INSIDER,
  });
  await insertUser(INSIDER, "insider@x.com");
  await insertUser(OUTSIDER, "outsider@x.com");
  insiderToken = (await mintDeviceToken(db, INSIDER, "insider")).token;
  outsiderToken = (await mintDeviceToken(db, OUTSIDER, "outsider")).token;
  orgId = await insertNode(null, { name: "Org", type: "organization" });
  openNodeId = await insertNode(orgId, { name: "Open deck project" });
  restrictedNodeId = await insertNode(orgId, { name: "Eng only", accessGroup: "eng@x.com" });

  handle = startHttpServer({ port: 14951, host: "127.0.0.1", registerSigint: false });
  await new Promise((r) => setImmediate(r));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
  resetIdentityContextForTesting();
  resetLocalDbForTests();
  resetHandoffsForTesting();
  await rm(workspace, { recursive: true, force: true });
});

beforeEach(() => resetHandoffsForTesting());

describe("domain/handoff", () => {
  it("expires a code after the TTL and consumes it on exchange", () => {
    const t0 = 1_000_000;
    const { code, expiresIn } = mintHandoff({ token: "tok", nodeId: "N1", userId: "U1" }, t0);
    assert.equal(expiresIn, 60);
    assert.equal(exchangeHandoff(code, t0 + HANDOFF_TTL_MS), null, "expired at the boundary");
    const fresh = mintHandoff({ token: "tok", nodeId: "N1", userId: "U1" }, t0);
    const hit = exchangeHandoff(fresh.code, t0 + 1);
    assert.deepEqual(hit && { token: hit.token, nodeId: hit.nodeId, userId: hit.userId }, {
      token: "tok",
      nodeId: "N1",
      userId: "U1",
    });
    assert.equal(exchangeHandoff(fresh.code, t0 + 2), null, "single use");
  });

  it("recognises loopback peers only", () => {
    assert.ok(isLoopbackAddress("127.0.0.1"));
    assert.ok(isLoopbackAddress("::1"));
    assert.ok(isLoopbackAddress("::ffff:127.0.0.1"));
    assert.ok(!isLoopbackAddress("10.0.0.5"));
    assert.ok(!isLoopbackAddress("::ffff:192.168.1.2"));
    assert.ok(!isLoopbackAddress(undefined));
  });
});

describe("POST /auth/handoff + /auth/handoff/exchange", () => {
  it("mint -> exchange returns the bearer, the node's MCP URL, name and mirror", async () => {
    const mirror = join(workspace, "workflow", "projects", "open-deck");
    await registerMirror(INSIDER, openNodeId, mirror);
    const code = await mint(openNodeId, insiderToken);

    const res = await post("/auth/handoff/exchange", { code });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.token, insiderToken);
    assert.equal(body.mcp_url, `${base}/mcp?home_node_id=${openNodeId}`);
    assert.equal(body.home_node_id, openNodeId);
    assert.equal(body.node_name, "Open deck project");
    assert.equal(body.mirror, mirror);
  });

  it("answers mirror: null for a node without a mirror on this device", async () => {
    const code = await mint(restrictedNodeId, insiderToken);
    const res = await post("/auth/handoff/exchange", { code });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.mirror, null);
    assert.equal(body.node_name, "Eng only");
  });

  it("refuses a second exchange of the same code with 404 HANDOFF_INVALID", async () => {
    const code = await mint(openNodeId, insiderToken);
    assert.equal((await post("/auth/handoff/exchange", { code })).status, 200);
    const again = await post("/auth/handoff/exchange", { code });
    assert.equal(again.status, 404);
    assert.equal(((await again.json()) as { code: string }).code, "HANDOFF_INVALID");
  });

  it("refuses an unknown code with 404 HANDOFF_INVALID", async () => {
    const res = await post("/auth/handoff/exchange", { code: "nope" });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { code: string }).code, "HANDOFF_INVALID");
  });

  it("refuses an expired code with 404", async () => {
    const t0 = Date.now() - HANDOFF_TTL_MS - 1;
    const { code } = mintHandoff({ token: insiderToken, nodeId: openNodeId, userId: INSIDER }, t0);
    const res = await post("/auth/handoff/exchange", { code });
    assert.equal(res.status, 404);
  });

  it("exchange needs no bearer but does need a loopback peer", async () => {
    const { code } = mintHandoff({ token: insiderToken, nodeId: openNodeId, userId: INSIDER });
    const captured = { status: 0, body: "" };
    const req = Readable.from([Buffer.from(JSON.stringify({ code }))]) as unknown as IncomingMessage;
    (req as unknown as { headers: Record<string, string> }).headers = {
      "content-type": "application/json",
    };
    (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: "10.0.0.5" };
    const res = new Writable({
      write(chunk, _enc, cb) {
        captured.body += chunk.toString();
        cb();
      },
    }) as unknown as ServerResponse;
    (res as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => {
      captured.status = s;
    };
    await handleExchangeHandoff(req, res, async () => "x");
    assert.equal(captured.status, 403);
    assert.equal(JSON.parse(captured.body).code, "HANDOFF_NOT_LOOPBACK");
    // The refusal did not consume the code.
    assert.equal((await post("/auth/handoff/exchange", { code })).status, 200);
  });

  it("mint requires a bearer", async () => {
    const res = await post("/auth/handoff", { node_id: openNodeId });
    assert.equal(res.status, 401);
  });

  it("mint refuses a node the caller cannot see, and an unknown node", async () => {
    const hidden = await post("/auth/handoff", { node_id: restrictedNodeId }, outsiderToken);
    assert.equal(hidden.status, 404);
    const missing = await post("/auth/handoff", { node_id: ulid() }, insiderToken);
    assert.equal(missing.status, 404);
    const visible = await post("/auth/handoff", { node_id: openNodeId }, outsiderToken);
    assert.equal(visible.status, 200);
  });

  it("the exchanged bearer is the one that minted, per caller", async () => {
    const code = await mint(openNodeId, outsiderToken);
    const body = (await (await post("/auth/handoff/exchange", { code })).json()) as { token: string };
    assert.equal(body.token, outsiderToken);
  });
});
