// Verifies materializeAllRegisteredMirrors() — what desktop.ts calls
// at sidecar boot — refreshes per-mirror harness configs and removes
// legacy project-scoped .mcp.json files written by older Portuni
// versions. Connection now lives in user-scoped configs only.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { materializeAllRegisteredMirrors } from "../src/domain/scope-materialize.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { SOLO_USER } from "../src/infra/schema.js";
import { makeSharedDb } from "./helpers/shared-db.js";

let workspace: string;
let originalRoot: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-remat-"));
  originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
});

afterEach(async () => {
  resetLocalDbForTests();
  if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
  await rm(workspace, { recursive: true, force: true });
});

describe("materializeAllRegisteredMirrors", () => {
  it("removes legacy .mcp.json files in every registered mirror", async () => {
    const { nodeId } = await makeSharedDb();
    const mirror = join(workspace, "mirror-a");
    await mkdir(mirror, { recursive: true });
    await writeFile(
      join(mirror, ".mcp.json"),
      JSON.stringify(
        {
          portuni_managed: { generated_at: "2026-04-25T00:00:00Z" },
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

    const legacy = join(mirror, ".mcp.json");
    const stillThere = await stat(legacy).then(() => true).catch(() => false);
    assert.equal(stillThere, false, "legacy .mcp.json must be removed");
    assert.ok(
      r.written.some((p) => p.startsWith("removed:") && p.endsWith(".mcp.json")),
    );
  });

  it("writes the soft hint with portuni_session_init for the mirror's node", async () => {
    const { nodeId } = await makeSharedDb();
    const mirror = join(workspace, "mirror-b");
    await mkdir(mirror, { recursive: true });
    await registerMirror(SOLO_USER, nodeId, mirror);

    await materializeAllRegisteredMirrors();

    const portuniScope = await readFile(join(mirror, "PORTUNI_SCOPE.md"), "utf8");
    assert.match(portuniScope, /portuni_session_init/);
    assert.match(portuniScope, new RegExp(`home_node_id: "${nodeId}"`));
  });

  it("returns empty result when no mirrors are registered", async () => {
    await makeSharedDb();
    const r = await materializeAllRegisteredMirrors();
    assert.deepEqual(r, { written: [], errors: [] });
  });
});
