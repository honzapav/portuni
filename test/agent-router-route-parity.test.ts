// Parity between the desktop's routing table and the sync agent's router.
//
// apps/server/shared/device-local-routes.json is the one list of routes the
// desktop webview sends to THIS device's sidecar in a team workspace
// (is_local_only_path, apps/desktop/src/lib.rs, matches request paths
// against its patterns). This test proves the other half: every route
// on that list is served by createAgentRouter (it must never fall through to
// the 501 `agent_mode` catch-all, which is what a team-workspace desktop would
// see as "feature missing"), and the router serves no route the list does
// not know about (a handler the desktop never routes to is dead code in
// team workspace, the shape of #264).
//
// The fake central refuses every call, so a handler that reaches central
// answers 4xx/5xx here; the assertion is only "handled by the agent router",
// never "succeeds". Behaviour of each route is covered by
// test/agent-router.test.ts and test/agent-router-sessions.test.ts.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { startHttpServer, type HttpServerHandle } from "../apps/server/http/server.js";
import { createAgentRouter } from "../apps/server/api/agent-router.js";
import { CentralHttpError, type CentralClient } from "../apps/server/domain/sync/central/client.js";
import { resetGateCachesForTesting } from "../apps/server/http/middleware.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { clearRegistryForTests } from "../apps/server/domain/runner/registry.js";

interface RouteEntry {
  method: string;
  pattern: string;
  example: string;
}
interface RouteContract {
  device_local: RouteEntry[];
  central: RouteEntry[];
  sidecar_direct: { patterns: string[] };
}

const CONTRACT_PATH = new URL("../apps/server/shared/device-local-routes.json", import.meta.url);
const ROUTER_PATH = new URL("../apps/server/api/agent-router.ts", import.meta.url);

// A central that knows nothing: every method rejects with a 404-shaped
// CentralHttpError, so any handler that consults central fails fast and
// visibly instead of hanging or succeeding by accident.
function refusingCentral(): CentralClient {
  return new Proxy({} as CentralClient, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return () => {
        throw new CentralHttpError(`fake central refuses ${String(prop)}`, 404, "NOT_FOUND");
      };
    },
  });
}

// `{id}`-style placeholders and the router's `([^/]+)` capture groups both
// normalize to `{x}` so the two sides compare as plain strings.
function normalizePattern(p: string): string {
  return p.replace(/\{[^}]+\}/g, "{x}");
}

function routerPatterns(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/pathname === "([^"]+)"/g)) out.add(normalizePattern(m[1]));
  for (const m of source.matchAll(/pathname\.match\(\/\^(.+?)\$\/\)/g)) {
    const literal = m[1].replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, "{x}");
    out.add(normalizePattern(literal));
  }
  return out;
}

let handle: HttpServerHandle;
let base: string;
let workspace: string;
let contract: RouteContract;
let previousDataDir: string | undefined;

describe("agent-router: parity with the desktop's device-local route list", () => {
  before(async () => {
    delete process.env.PORTUNI_AUTH_TOKEN;
    workspace = await mkdtemp(join(tmpdir(), "portuni-route-parity-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    // The /runners routes read and create runners.json in the data dir
    // (cwd by default); keep that inside the temp workspace.
    previousDataDir = process.env.PORTUNI_DATA_DIR;
    process.env.PORTUNI_DATA_DIR = workspace;
    resetLocalDbForTests();
    clearRegistryForTests();
    contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8")) as RouteContract;

    handle = startHttpServer({
      port: 0,
      host: "127.0.0.1",
      registerSigint: false,
      router: createAgentRouter(refusingCentral()),
      mcpTransport: undefined,
      mountMcp: false,
      mountSessionsWs: false,
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
    resetLocalDbForTests();
    delete process.env.PORTUNI_WORKSPACE_ROOT;
    if (previousDataDir === undefined) delete process.env.PORTUNI_DATA_DIR;
    else process.env.PORTUNI_DATA_DIR = previousDataDir;
    await rm(workspace, { recursive: true, force: true });
  });

  it("the contract file lists every route family the desktop routes locally", () => {
    assert.ok(contract.device_local.length >= 30, "device_local looks truncated");
    const patterns = new Set(contract.device_local.map((e) => e.pattern));
    for (const must of ["/sessions", "/nodes/{id}/file", "/nodes/{id}/files/{fileId}/resolve", "/runners/{runner}/models"]) {
      assert.ok(patterns.has(must), `${must} missing from device_local`);
    }
  });

  it("every device-local route is handled by the agent router (never the 501 agent_mode catch-all)", async () => {
    const unhandled: string[] = [];
    for (const entry of contract.device_local) {
      const hasBody = entry.method === "POST" || entry.method === "PUT" || entry.method === "PATCH";
      const res = await fetch(`${base}${entry.example}`, {
        method: entry.method,
        headers: hasBody ? { "content-type": "application/json" } : undefined,
        body: hasBody ? "{}" : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let body: { error?: string } = {};
      try {
        body = JSON.parse(text) as { error?: string };
      } catch {
        /* non-JSON bodies are still "handled" */
      }
      if (res.status === 501 && body.error === "agent_mode") {
        unhandled.push(`${entry.method} ${entry.pattern}`);
      }
    }
    assert.deepEqual(
      unhandled,
      [],
      "routed to this device's sidecar by is_local_only_path but not served by agent-router.ts",
    );
  });

  it("the agent router serves no route the contract does not list", async () => {
    const source = await readFile(ROUTER_PATH, "utf8");
    const served = routerPatterns(source);
    assert.ok(served.size >= 30, "router pattern extraction looks broken");
    const known = new Set<string>([
      ...contract.device_local.map((e) => normalizePattern(e.pattern)),
      ...contract.sidecar_direct.patterns.map(normalizePattern),
    ]);
    const unlisted = [...served].filter((p) => !known.has(p)).sort();
    assert.deepEqual(
      unlisted,
      [],
      "served by agent-router.ts but absent from device-local-routes.json: the desktop never routes here in a team workspace",
    );
    const dead = [...known]
      .filter((p) => !contract.sidecar_direct.patterns.map(normalizePattern).includes(p))
      .filter((p) => !served.has(p))
      .sort();
    assert.deepEqual(dead, [], "listed as device-local but no handler pattern in agent-router.ts matches it");
  });

  it("GET /sync/health answers the device's own watcher error buffer", async () => {
    const res = await fetch(`${base}/sync/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { errors: [] });
  });

  it("GET /scope classifies a write on this device without consulting central", async () => {
    const res = await fetch(`${base}/scope?cwd=${encodeURIComponent(workspace)}&target=${encodeURIComponent(join(workspace, "a.md"))}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { decision: string };
    assert.ok(body.decision === "allow" || body.decision === "deny");
  });
});
