// provisionRun (apps/server/domain/runner/provision.ts): a modest
// integration check that the pieces it wires together (mirror creation,
// orientation, MCP URL/token resolution) actually produce a usable
// RunStart-shaped result -- the session-runtime tests stub this function
// out entirely, so nothing else exercises it against real mirror creation.
//
// #507: the env is the one apps/desktop/src/lib.rs gives a sidecar --
// PORTUNI_WORKSPACE_ID + PORTUNI_AUTH_TOKEN and no PORTUNI_MCP_TOKEN* at
// all -- so a provision that reads the per-mirror shell variable instead of
// the front door's own token shows up here as an empty bearer.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { provisionRun } from "../apps/server/domain/runner/provision.js";
import { createProvisionRunCentral } from "../apps/server/domain/runner/provision-central.js";
import type { CentralClient } from "../apps/server/domain/sync/central/client.js";
import type { NodeSyncInfo } from "../apps/server/domain/sync/sync-remote-api.js";
import { listUserMirrors } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { setDbForTesting } from "../apps/server/infra/db.js";

let workspace: string;
let originalWorkspaceRoot: string | undefined;
const DESKTOP_ENV = ["PORTUNI_WORKSPACE_ID", "PORTUNI_AUTH_TOKEN", "PORTUNI_MCP_TOKEN", "PORTUNI_MCP_TOKEN_WS_TEST"];
let originalEnv: Record<string, string | undefined>;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-runner-provision-"));
  originalWorkspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  originalEnv = Object.fromEntries(DESKTOP_ENV.map((k) => [k, process.env[k]]));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  // Exactly what the desktop hands a sidecar (apps/desktop/src/lib.rs).
  process.env.PORTUNI_WORKSPACE_ID = "ws-test";
  process.env.PORTUNI_AUTH_TOKEN = "front-door-token";
  delete process.env.PORTUNI_MCP_TOKEN;
  delete process.env.PORTUNI_MCP_TOKEN_WS_TEST;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});

afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalWorkspaceRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalWorkspaceRoot;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(workspace, { recursive: true, force: true });
});

describe("provisionRun", () => {
  it("creates the mirror, builds an orientation hint, and resolves the MCP URL/token/root", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);

    const result = await provisionRun({ userId: "U1", nodeId, sessionId: "S1", resume: null });

    assert.ok(result.cwd.startsWith(workspace), `cwd must be under the workspace root, got ${result.cwd}`);
    assert.match(result.orientation, /Stan GWS/, "orientation must mention the node by name");
    assert.equal(result.mcp.token, "front-door-token", "the bearer is the PORTUNI_AUTH_TOKEN the front door verifies");
    assert.equal(result.mcp.homeNodeId, nodeId);
    assert.match(result.mcp.url, new RegExp(`home_node_id=${nodeId}`));
    assert.ok(result.mirrors.includes(result.cwd));
    // resolvePortuniRoot's single-mirror default is the mirror's own
    // parent directory, not the configured workspace root itself.
    assert.ok(result.cwd.startsWith(`${result.portuniRoot}/`));
  });

  it("is idempotent: a second call for the same node reuses the existing mirror", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);

    const first = await provisionRun({ userId: "U1", nodeId, sessionId: "S1", resume: null });
    const second = await provisionRun({ userId: "U1", nodeId, sessionId: "S2", resume: null });
    assert.equal(first.cwd, second.cwd);
  });

  it("a handoff resume appends the pointer text to the orientation", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);

    const result = await provisionRun({
      userId: "U1",
      nodeId,
      sessionId: "S1",
      resume: { mode: "handoff", handoffPath: "wip/sessions/S0-handoff.md" },
    });
    assert.match(result.orientation, /wip\/sessions\/S0-handoff\.md/);
  });

  it("a conversation resume does not add a handoff pointer", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);

    const result = await provisionRun({
      userId: "U1",
      nodeId,
      sessionId: "S1",
      resume: { mode: "conversation" },
    });
    assert.doesNotMatch(result.orientation, /Předání/);
  });

  it("#507: no PORTUNI_AUTH_TOKEN fails before any mirror work, never an empty bearer", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);
    delete process.env.PORTUNI_AUTH_TOKEN;
    // The per-mirror shell variable is not the front door's credential.
    process.env.PORTUNI_MCP_TOKEN_WS_TEST = "shell-token";

    await assert.rejects(
      provisionRun({ userId: "U1", nodeId, sessionId: "S1", resume: null }),
      /PORTUNI_AUTH_TOKEN/,
    );
    assert.deepEqual(await listUserMirrors("U1"), [], "no mirror is created for a run that cannot start");
  });
});

// The team-workspace half: the sync agent's provision (#507). Only the
// CentralClient methods provisioning reaches are real; the rest throw.
function provisionCentralFake(nodeId: string): { client: CentralClient; syncInfoCalls: string[] } {
  const syncInfoCalls: string[] = [];
  const info: NodeSyncInfo = {
    node: { id: nodeId, name: "Proj", type: "project", sync_key: "proj", org_sync_key: "workflow" },
    remote_name: null,
    files: [],
    deleted: [],
  };
  const client = new Proxy(
    {
      async syncInfo(id: string) {
        syncInfoCalls.push(id);
        return info;
      },
      async dataSources() {
        return [];
      },
      async orientation() {
        return null;
      },
      invalidateSyncInfo() {
      // No cache in this fake.
    },
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        if (prop === "then") return undefined;
        return () => {
          throw new Error(`CentralClient.${String(prop)} not used in this test`);
        };
      },
    },
  ) as unknown as CentralClient;
  return { client, syncInfoCalls };
}

describe("createProvisionRunCentral (sync agent)", () => {
  const NODE = "N0000000000000000000PROJ1";
  let originalAgentMode: string | undefined;
  beforeEach(() => {
    originalAgentMode = process.env.PORTUNI_AGENT_MODE;
    process.env.PORTUNI_AGENT_MODE = "1";
  });
  afterEach(() => {
    if (originalAgentMode === undefined) delete process.env.PORTUNI_AGENT_MODE;
    else process.env.PORTUNI_AGENT_MODE = originalAgentMode;
  });

  it("#507: the run's bearer is PORTUNI_AUTH_TOKEN, the URL the local front door", async () => {
    const { client } = provisionCentralFake(NODE);
    const result = await createProvisionRunCentral(client)({ userId: "U1", nodeId: NODE, sessionId: "S1", resume: null });
    assert.equal(result.mcp.token, "front-door-token");
    assert.match(result.mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\?home_node_id=/);
    assert.ok(result.cwd.startsWith(workspace));
  });

  it("#507: no PORTUNI_AUTH_TOKEN fails before central is asked for anything", async () => {
    delete process.env.PORTUNI_AUTH_TOKEN;
    process.env.PORTUNI_MCP_TOKEN_WS_TEST = "shell-token";
    const { client, syncInfoCalls } = provisionCentralFake(NODE);
    await assert.rejects(
      createProvisionRunCentral(client)({ userId: "U1", nodeId: NODE, sessionId: "S1", resume: null }),
      /PORTUNI_AUTH_TOKEN/,
    );
    assert.deepEqual(syncInfoCalls, [], "no mirror work for a run that cannot start");
  });
});
