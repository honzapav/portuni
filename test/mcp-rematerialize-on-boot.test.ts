// Verifies materializeAllRegisteredMirrors() — what desktop.ts calls
// at sidecar boot — refreshes per-mirror harness configs, including the
// project-scoped .mcp.json that carries ?home_node_id=... so the MCP
// session auto-seeds its read scope on connect. The bearer token is
// referenced via ${PORTUNI_MCP_TOKEN:-} env expansion, never embedded.

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
let originalUrl: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-remat-"));
  originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  originalUrl = process.env.PORTUNI_URL;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_URL = "http://127.0.0.1:47011";
  resetLocalDbForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
  if (originalUrl === undefined) delete process.env.PORTUNI_URL;
  else process.env.PORTUNI_URL = originalUrl;
  await rm(workspace, { recursive: true, force: true });
});

describe("materializeAllRegisteredMirrors", () => {
  it("writes .mcp.json with home_node_id and env-expanded token for each mirror", async () => {
    const { nodeId } = await makeSharedDb();
    const mirror = join(workspace, "mirror-a");
    await mkdir(mirror, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, mirror);

    const r = await materializeAllRegisteredMirrors();

    const raw = await readFile(join(mirror, ".mcp.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      portuni_managed?: unknown;
      mcpServers: { portuni: { type: string; url: string; headers: Record<string, string> } };
    };
    assert.ok(parsed.portuni_managed, "must carry the portuni_managed marker");
    assert.equal(parsed.mcpServers.portuni.type, "http");
    assert.equal(
      parsed.mcpServers.portuni.url,
      `http://127.0.0.1:47011/mcp?home_node_id=${nodeId}`,
    );
    assert.equal(
      parsed.mcpServers.portuni.headers.Authorization,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder expanded by Claude Code, not JS
      "Bearer ${PORTUNI_MCP_TOKEN:-}",
    );
    assert.ok(r.written.includes(join(mirror, ".mcp.json")));
  });

  it("replaces a stale portuni-managed .mcp.json with the current URL", async () => {
    const { nodeId } = await makeSharedDb();
    const mirror = join(workspace, "mirror-stale");
    await mkdir(mirror, { recursive: true });
    await writeFile(
      join(mirror, ".mcp.json"),
      JSON.stringify({
        portuni_managed: { generated_at: "2026-04-25T00:00:00Z" },
        mcpServers: {
          portuni: {
            type: "http",
            url: "http://127.0.0.1:9999/mcp",
            headers: { Authorization: "Bearer stale-literal-token" },
          },
        },
      }),
    );
    await registerMirror(SOLO_USER, nodeId, mirror);

    await materializeAllRegisteredMirrors();

    const raw = await readFile(join(mirror, ".mcp.json"), "utf8");
    assert.ok(!raw.includes("9999"), "stale port must be replaced");
    assert.ok(!raw.includes("stale-literal-token"), "literal token must be gone");
    assert.ok(raw.includes(`home_node_id=${nodeId}`));
  });

  it("leaves a user-owned .mcp.json (no portuni marker) untouched", async () => {
    const { nodeId } = await makeSharedDb();
    const mirror = join(workspace, "mirror-user");
    await mkdir(mirror, { recursive: true });
    const userContent = JSON.stringify({
      mcpServers: { other: { type: "stdio", command: "x" } },
    });
    await writeFile(join(mirror, ".mcp.json"), userContent);
    await registerMirror(SOLO_USER, nodeId, mirror);

    const r = await materializeAllRegisteredMirrors();

    const raw = await readFile(join(mirror, ".mcp.json"), "utf8");
    assert.equal(raw, userContent, "user-owned file must not be clobbered");
    assert.ok(
      r.errors.some((e) => e.path.endsWith(".mcp.json")),
      "skip must be surfaced as a non-fatal error note",
    );
  });

  it("writes the soft hint with the write-scope guidance for each mirror", async () => {
    const { nodeId } = await makeSharedDb();
    const mirror = join(workspace, "mirror-b");
    await mkdir(mirror, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, mirror);

    await materializeAllRegisteredMirrors();

    const portuniScope = await readFile(join(mirror, "PORTUNI_SCOPE.md"), "utf8");
    assert.match(portuniScope, /Portuni write scope/);
    assert.match(portuniScope, new RegExp(mirror.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("returns empty result when no mirrors are registered", async () => {
    await makeSharedDb();
    const r = await materializeAllRegisteredMirrors();
    assert.deepEqual(r, { written: [], errors: [] });
  });
});
