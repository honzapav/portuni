// provisionRun (apps/server/domain/runner/provision.ts): a modest
// integration check that the pieces it wires together (mirror creation,
// orientation, MCP URL/token resolution) actually produce a usable
// RunStart-shaped result -- the session-runtime tests stub this function
// out entirely, so nothing else exercises it against real mirror creation.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { provisionRun } from "../apps/server/domain/runner/provision.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { setDbForTesting } from "../apps/server/infra/db.js";

let workspace: string;
let originalWorkspaceRoot: string | undefined;
let originalToken: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-runner-provision-"));
  originalWorkspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  originalToken = process.env.PORTUNI_MCP_TOKEN;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_MCP_TOKEN = "test-bearer-token";
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});

afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalWorkspaceRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalWorkspaceRoot;
  if (originalToken === undefined) delete process.env.PORTUNI_MCP_TOKEN;
  else process.env.PORTUNI_MCP_TOKEN = originalToken;
  await rm(workspace, { recursive: true, force: true });
});

describe("provisionRun", () => {
  it("creates the mirror, builds an orientation hint, and resolves the MCP URL/token/root", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);

    const result = await provisionRun({ userId: "U1", nodeId, sessionId: "S1", resume: null });

    assert.ok(result.cwd.startsWith(workspace), `cwd must be under the workspace root, got ${result.cwd}`);
    assert.match(result.orientation, /Stan GWS/, "orientation must mention the node by name");
    assert.equal(result.mcp.token, "test-bearer-token");
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
});
