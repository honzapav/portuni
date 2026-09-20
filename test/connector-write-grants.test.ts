// Durable write grants for nodes created from a connector session
// (interactive_chat) -- Asana 1218386301330150. A connector client (claude.ai
// web / mobile) reopens its MCP session all the time, so the in-memory
// "created by this session" write grant used to be gone by the time the user
// asked to attach a file to the node they had just created; and the only
// expansion path, portuni_expand_scope(writable: true), is refused on a
// client without the elicitation capability. Covers:
//   - the domain query (listConnectorCreatedWritableNodes) and what it
//     deliberately excludes;
//   - the MCP round trip: create in session A, rehydrate into a fresh
//     session B, mutate from B without any dialog, and the grant being
//     re-persisted under B so the chain survives the next reconnect;
//   - the honest write_expansion_required hint on a client without the
//     elicitation capability (no more "call expand_scope" dead end).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTestDb } from "./helpers/db.js";
import { insertIgnore } from "../apps/server/infra/sql.js";
import type { DbClient } from "../apps/server/infra/db.js";
import { ulid } from "ulid";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import {
  createSession,
  getSessionScope,
  listConnectorCreatedWritableNodes,
  setSessionScopeWritable,
  upsertSessionScopeRead,
} from "../apps/server/domain/sessions.js";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createElicitor } from "../apps/server/mcp/elicit.js";
import {
  bindSessionPersistence,
  rehydrateConnectorWriteGrants,
} from "../apps/server/mcp/session-persistence.js";
import { registerNodeTools } from "../apps/server/mcp/tools/nodes.js";
import { registerScopeTools } from "../apps/server/mcp/tools/scope.js";
import type { SessionCtx } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

const USER = "01USER000000000000000CHAT";
const OTHER_USER = "01USER00000000000000OTHER";

function connectorIdentity(userId: string = USER): RequestIdentity {
  return {
    userId,
    email: `${userId}@x.com`,
    name: userId,
    globalScope: "manage",
    groups: [],
    groupIds: [],
    via: "oauth_grant",
  };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
}

// A connector-shaped MCP client: no elicitation capability declared, exactly
// like claude.ai web / mobile today.
async function connectWithoutElicitation(scope: SessionScope, ident: RequestIdentity): Promise<McpClient> {
  const server = new McpServer({ name: "connector-grants-test", version: "0.0.1" }, {});
  const ctx: SessionCtx = { scope, identity: ident, elicit: createElicitor(server), spillSessionId: "test-spill" };
  registerNodeTools(server, ctx);
  registerScopeTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "connector-grants-test-client", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

let workspace: string;
let db: DbClient;
let orgId: string;
let existingId: string;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-connector-grants-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  db = await openTestDb();
  await ensureSchemaOn(db);
  setDbForTesting(db);

  for (const u of [USER, OTHER_USER]) {
    await db.execute({
      sql: insertIgnore(db.dialect, "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)"),
      args: [u, `${u}@x.com`, u],
    });
  }
  orgId = ulid();
  existingId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "Workflow", "workflow", USER],
  });
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [existingId, "project", "Existing", "existing", USER],
  });
});

after(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });
});

async function insertNode(name: string): Promise<string> {
  const id = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [id, "project", name, name.toLowerCase(), USER],
  });
  return id;
}

async function persistedSession(
  userId: string,
  sessionType: "interactive_chat" | "interactive_task",
  nodeId: string,
  addedVia: "created" | "elicited",
  writable: boolean,
): Promise<void> {
  const row = await createSession(db, userId, {
    node_id: sessionType === "interactive_task" ? nodeId : null,
    session_type: sessionType,
  });
  await upsertSessionScopeRead(db, row.id, nodeId, addedVia, "test fixture");
  if (writable) await setSessionScopeWritable(db, row.id, nodeId);
}

describe("listConnectorCreatedWritableNodes (domain)", () => {
  it("returns only nodes this user's connector sessions persisted as created + writable", async () => {
    const chatCreated = await insertNode("Chat Created");
    const chatElicited = await insertNode("Chat Elicited");
    const chatReadOnly = await insertNode("Chat Read Only");
    const taskCreated = await insertNode("Task Created");
    const otherUsersChat = await insertNode("Other Users Chat");
    const deleted = await insertNode("Deleted Since");

    await persistedSession(USER, "interactive_chat", chatCreated, "created", true);
    // Elicited grants are session-local by design (the user confirmed ONE
    // session's write); only creation carries over.
    await persistedSession(USER, "interactive_chat", chatElicited, "elicited", true);
    // created but never writable (cannot happen in practice -- defensive).
    await persistedSession(USER, "interactive_chat", chatReadOnly, "created", false);
    // A task session's created node is covered by its own anchor/resume
    // path; connector rehydration stays "what this user's chats created".
    await persistedSession(USER, "interactive_task", taskCreated, "created", true);
    await persistedSession(OTHER_USER, "interactive_chat", otherUsersChat, "created", true);
    await persistedSession(USER, "interactive_chat", deleted, "created", true);
    await db.execute({ sql: "DELETE FROM nodes WHERE id = ?", args: [deleted] });

    const ids = await listConnectorCreatedWritableNodes(db, USER);
    assert.ok(ids.includes(chatCreated), "connector-created + writable node is returned");
    assert.ok(!ids.includes(chatElicited), "elicited grant is not carried over");
    assert.ok(!ids.includes(chatReadOnly), "non-writable row is not returned");
    assert.ok(!ids.includes(taskCreated), "task-session creation is not a connector grant");
    assert.ok(!ids.includes(otherUsersChat), "another user's chats never leak in");
    assert.ok(!ids.includes(deleted), "a node deleted since drops out");
  });

  it("is a no-op for any session type other than interactive_chat", async () => {
    const scope = new SessionScope("interactive_task");
    const granted = await rehydrateConnectorWriteGrants(db, scope, connectorIdentity());
    assert.deepEqual(granted, []);
    assert.deepEqual(scope.writableNodes(), []);
  });
});

describe("connector session: a node created in one MCP session stays writable in the next", () => {
  it("create in session A -> reconnect as session B -> mutate without a dialog; grant re-persisted under B", async () => {
    // Session A: the chat where the node was created.
    const identity = connectorIdentity();
    const scopeA = new SessionScope("interactive_chat");
    bindSessionPersistence(db, scopeA, identity, null, null);
    const clientA = await connectWithoutElicitation(scopeA, identity);
    const created = (await clientA.callTool({
      name: "portuni_create_node",
      arguments: { type: "project", name: "Asana × AI webinář", organization_id: orgId },
    })) as ToolResult;
    assert.equal(created.isError, undefined);
    const nodeId = payloadOf(created).id as string;
    assert.equal(scopeA.canWrite(nodeId), true, "same session: writable immediately (pre-existing behavior)");

    await waitUntil(() => scopeA.sessionId !== null);
    const sessionA = scopeA.sessionId!;
    await waitUntil(async () => {
      const row = (await getSessionScope(db, sessionA)).find((r) => r.node_id === nodeId);
      return row?.writable === 1 && row.added_via === "created";
    });

    // Session B: the same user reconnects (idle GC, deploy, client
    // re-init) -- a brand new SessionScope, exactly what transport.ts
    // builds, with nothing in it.
    const scopeB = new SessionScope("interactive_chat");
    assert.equal(scopeB.canWrite(nodeId), false, "a fresh scope starts empty -- this was the bug");
    const granted = await rehydrateConnectorWriteGrants(db, scopeB, identity);
    assert.ok(granted.includes(nodeId));
    assert.equal(scopeB.canWrite(nodeId), true);
    assert.equal(scopeB.canWrite(existingId), false, "nothing but chat-created nodes is rehydrated");
    const rehydration = scopeB.expansions().find((e) => e.node_ids.includes(nodeId));
    assert.equal(rehydration?.addedVia, "created");
    assert.equal(rehydration?.triggered_by, "init");

    // The mutation the user actually wanted, from the reconnected session,
    // on a client that cannot show a dialog: succeeds with no prompt.
    bindSessionPersistence(db, scopeB, identity, null, null);
    const clientB = await connectWithoutElicitation(scopeB, identity);
    const updated = (await clientB.callTool({
      name: "portuni_update_node",
      arguments: { node_id: nodeId, description: "shrnutí přiloženo" },
    })) as ToolResult;
    assert.equal(updated.isError, undefined, updated.content[0]?.text);

    // Chain: B persisted the grant as 'created' + writable again, so a
    // session C after B would find it just the same.
    await waitUntil(() => scopeB.sessionId !== null);
    const sessionB = scopeB.sessionId!;
    await waitUntil(async () => {
      const row = (await getSessionScope(db, sessionB)).find((r) => r.node_id === nodeId);
      return row?.writable === 1 && row.added_via === "created";
    });
    const scopeC = new SessionScope("interactive_chat");
    await rehydrateConnectorWriteGrants(db, scopeC, identity);
    assert.equal(scopeC.canWrite(nodeId), true);
  });

  it("another user's connector session does not inherit the grant", async () => {
    const scope = new SessionScope("interactive_chat");
    const granted = await rehydrateConnectorWriteGrants(db, scope, connectorIdentity(OTHER_USER));
    // OTHER_USER's own fixture node from the domain test above is fine;
    // nothing USER created must appear.
    const usersNodes = await listConnectorCreatedWritableNodes(db, USER);
    for (const id of usersNodes) assert.ok(!granted.includes(id));
  });
});

describe("write gate on a client without the elicitation capability", () => {
  it("does not send the agent to portuni_expand_scope; says the grant is impossible from this client", async () => {
    const identity = connectorIdentity();
    const scope = new SessionScope("interactive_chat");
    const client = await connectWithoutElicitation(scope, identity);
    const r = (await client.callTool({
      name: "portuni_update_node",
      arguments: { node_id: existingId, description: "should be refused" },
    })) as ToolResult;
    assert.equal(r.isError, true);
    const payload = payloadOf(r);
    assert.equal(payload.error, "write_expansion_required");
    assert.equal(payload.node_id, existingId);
    assert.equal(payload.elicitation_supported, false);
    const hint = String(payload.hint);
    assert.match(hint, /does not support MCP elicitation dialogs/);
    assert.match(hint, /do NOT call portuni_expand_scope/);
    assert.doesNotMatch(hint, /then call portuni_expand_scope/);

    // And the call the old hint used to recommend is indeed refused.
    const expand = (await client.callTool({
      name: "portuni_expand_scope",
      arguments: { node_ids: [existingId], reason: "user-confirmed-in-chat", writable: true },
    })) as ToolResult;
    const expandPayload = payloadOf(expand) as { writable: string[]; refused_write: Array<{ node_id: string }> };
    assert.deepEqual(expandPayload.writable, []);
    assert.equal(expandPayload.refused_write[0]?.node_id, existingId);
    assert.equal(scope.canWrite(existingId), false);
  });
});
