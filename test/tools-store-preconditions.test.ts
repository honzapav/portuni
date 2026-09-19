// #409: portuni_store hung for five minutes on a connector session (no
// local sync.db) because the write-scope confirmation dialog ran BEFORE the
// precondition that could never hold. The device-local preconditions are
// checked first now, so the tool answers with the same error portuni_status
// gives -- without ever showing a dialog.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openTestDb } from "./helpers/db.js";
import type { DbClient } from "../apps/server/infra/db.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createDiskProjector } from "../apps/server/mcp/disk-projection.js";
import { registerFileTools } from "../apps/server/mcp/tools/files.js";
import type { Elicitor, ElicitOutcome } from "../apps/server/mcp/elicit.js";
import type { SessionCtx } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

const SOLO = "01SOLO0000000000000000000";
const LOCAL_DB_ERROR = "PORTUNI_WORKSPACE_ROOT must be set for local sync.db";

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function identity(): RequestIdentity {
  return {
    userId: SOLO,
    email: "solo@x.com",
    name: "Solo",
    globalScope: "admin",
    groups: [],
    groupIds: [],
    via: "oauth_grant",
  };
}

// A connector-style session: interactive_chat, so every write is outside
// the (empty) write set and reaches the dialog.
function connectorScope(): SessionScope {
  return new SessionScope("interactive_chat");
}

interface Harness {
  client: McpClient;
  dialogs: string[];
}

// `dialogOutcome: null` is the hang the issue describes: a client that
// never answers. A test asserting the tool returns anyway proves the
// dialog was never reached.
async function connect(dialogOutcome: ElicitOutcome | null): Promise<Harness> {
  const scope = connectorScope();
  const ident = identity();
  const dialogs: string[] = [];
  const elicit: Elicitor = {
    confirm: (message) => {
      dialogs.push(message);
      if (dialogOutcome === null) {
        // Never settles: the client that never answers.
        return new Promise<ElicitOutcome>(() => {
          /* intentionally never resolved */
        });
      }
      return Promise.resolve(dialogOutcome);
    },
  };
  const projector = createDiskProjector({ userId: ident.userId, scope });
  const ctx: SessionCtx = { scope, identity: ident, projector, elicit };
  const server = new McpServer({ name: "store-precondition-test", version: "0.0.1" }, {});
  registerFileTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient(
    { name: "store-precondition-test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, dialogs };
}

let db: DbClient;
let nodeId: string;
let fileId: string;
let savedRoot: string | undefined;

before(async () => {
  savedRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  resetLocalDbForTests();
  db = await openTestDb();
  await ensureSchemaOn(db);
  setDbForTesting(db);

  nodeId = ulid();
  fileId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [nodeId, "project", "Connector Target", "connector-target", SOLO],
  });
  await db.execute({
    sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, status, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [fileId, nodeId, "note.md", "drive", "acme/projects/x/wip/note.md", "wip", SOLO],
  });
});

after(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  if (savedRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = savedRoot;
});

describe("device-local preconditions run before the write-scope dialog (#409)", () => {
  it("portuni_store answers with the local sync.db error and never opens a dialog that cannot help", async () => {
    const { client, dialogs } = await connect(null);
    const r = (await client.callTool({
      name: "portuni_store",
      arguments: { node_id: nodeId, local_path: "/tmp/whatever.md" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.ok(
      r.content[0].text.includes(LOCAL_DB_ERROR),
      `expected the local sync.db error, got: ${r.content[0].text}`,
    );
    assert.deepEqual(dialogs, []);
    await client.close();
  });

  it("portuni_pull in download mode (file_id) fails the same way", async () => {
    const { client, dialogs } = await connect(null);
    const r = (await client.callTool({
      name: "portuni_pull",
      arguments: { file_id: fileId },
    })) as ToolResult;
    assert.equal(r.isError, true);
    assert.ok(
      r.content[0].text.includes(LOCAL_DB_ERROR),
      `expected the local sync.db error, got: ${r.content[0].text}`,
    );
    assert.deepEqual(dialogs, []);
    await client.close();
  });

  it("portuni_adopt_files still reaches the write guard (remote-only, unchanged)", async () => {
    const { client, dialogs } = await connect("decline");
    const r = (await client.callTool({
      name: "portuni_adopt_files",
      arguments: { node_id: nodeId, paths: ["wip/note.md"] },
    })) as ToolResult;
    assert.equal(r.isError, true);
    const payload = JSON.parse(r.content[0].text) as Record<string, unknown>;
    assert.equal(payload.error, "write_expansion_required");
    assert.equal(payload.node_id, nodeId);
    assert.equal(dialogs.length, 1);
    await client.close();
  });
});
