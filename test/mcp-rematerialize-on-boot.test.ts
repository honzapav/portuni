// Verifies materializeAllRegisteredMirrors() refreshes per-mirror
// .mcp.json files using the current PORT + PORTUNI_AUTH_TOKEN env vars.
// This is what desktop.ts calls at sidecar boot so external configs
// pick up rotated tokens without manual intervention.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { materializeAllRegisteredMirrors } from "../src/domain/scope-materialize.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { SOLO_USER } from "../src/infra/schema.js";
import { makeSharedDb } from "./helpers/shared-db.js";

let workspace: string;
let originalRoot: string | undefined;
let originalPort: string | undefined;
let originalAuth: string | undefined;
let originalHost: string | undefined;
let originalUrl: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-remat-"));
  originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  originalPort = process.env.PORT;
  originalAuth = process.env.PORTUNI_AUTH_TOKEN;
  originalHost = process.env.HOST;
  originalUrl = process.env.PORTUNI_URL;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORT = "47011";
  process.env.HOST = "127.0.0.1";
  process.env.PORTUNI_AUTH_TOKEN = "fresh-token-123";
  delete process.env.PORTUNI_URL;
  resetLocalDbForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  for (const [k, v] of [
    ["PORTUNI_WORKSPACE_ROOT", originalRoot],
    ["PORT", originalPort],
    ["PORTUNI_AUTH_TOKEN", originalAuth],
    ["HOST", originalHost],
    ["PORTUNI_URL", originalUrl],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(workspace, { recursive: true, force: true });
});

describe("materializeAllRegisteredMirrors", () => {
  it("rewrites stale .mcp.json with the current port and token", async () => {
    const { nodeId } = await makeSharedDb();
    const mirror = join(workspace, "mirror-a");
    await mkdir(mirror, { recursive: true });
    // Pre-seed a stale .mcp.json that an older launch would have written.
    await writeFile(
      join(mirror, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            portuni: {
              type: "http",
              url: "http://127.0.0.1:9999/mcp",
              headers: { Authorization: "Bearer stale" },
            },
          },
        },
        null,
        2,
      ),
    );
    await registerMirror(SOLO_USER, nodeId, mirror);

    const r = await materializeAllRegisteredMirrors();
    assert.ok(
      r.written.some((p) => p.endsWith("/.mcp.json")),
      `expected .mcp.json in written list, got: ${r.written.join(", ")}`,
    );

    const refreshed = JSON.parse(
      await readFile(join(mirror, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: { portuni: { url: string; headers?: { Authorization: string } } };
    };
    assert.match(refreshed.mcpServers.portuni.url, /:47011\/mcp/);
    assert.equal(
      refreshed.mcpServers.portuni.headers?.Authorization,
      "Bearer fresh-token-123",
    );
  });

  it("returns empty result when no mirrors are registered", async () => {
    await makeSharedDb();
    const r = await materializeAllRegisteredMirrors();
    assert.deepEqual(r, { written: [], errors: [] });
  });
});
