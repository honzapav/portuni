import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  effectiveAccessEntries,
  resolveAccessChain,
  canSeeNode,
  nodeVisibleTo,
  filterVisibleNodeIds,
  classifyNodeVisibility,
  type GroupIdentityView,
  type AccessMode,
} from "../apps/server/auth/node-access.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClient as createDbClient } from "@libsql/client";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { createMcpServer } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

const SOLO = "01SOLO0000000000000000000";

async function addNode(
  db: ReturnType<typeof createDbClient>,
  parentId: string,
  visibility: string,
  accessMode?: AccessMode,
) {
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, access_mode, sync_key, created_by)
          VALUES (?, 'project', 'n', 'active', ?, ?, ?, ?)`,
    args: [id, visibility, accessMode ?? "private", `project:n-${id}`, SOLO],
  });
  await db.execute({
    sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by)
          VALUES (?, ?, ?, 'belongs_to', ?)`,
    args: [ulid(), id, parentId, SOLO],
  });
  return id;
}

async function addAccessRow(
  db: ReturnType<typeof createDbClient>,
  nodeId: string,
  kind: "group" | "user",
  principal: string,
) {
  await db.execute({
    sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
          VALUES (?, ?, ?, ?, ?)`,
    args: [nodeId, kind, principal, kind === "group" ? principal : null, SOLO],
  });
}

function identity(opts: Partial<GroupIdentityView>): GroupIdentityView {
  return {
    userId: opts.userId ?? "01USER0000000000000000001",
    globalScope: opts.globalScope ?? "write",
    groups: opts.groups ?? [],
    groupIds: opts.groupIds ?? [],
  };
}

// --- Scenario 1: node without ACL anywhere in the chain -> everyone sees it ---

test("1. no ACL anywhere in the chain: non-admin identity sees the node", async () => {
  const { db, orgId } = await makeSharedDb();
  const child = await addNode(db, orgId, "team");

  const entries = await effectiveAccessEntries(db, child);
  assert.equal(entries, null, "unrestricted chain resolves to null");

  const outsider = identity({ globalScope: "manage" });
  assert.equal(canSeeNode(outsider, entries), true);
  assert.equal(await nodeVisibleTo(db, outsider, child), true);
});

// --- Scenario 2: group row by ID ---

test("2. group row (principal = group ID): member by groupIds sees, non-member does not, admin sees", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group");
  await addAccessRow(db, restricted, "group", "GROUP_ID_APOLLO");

  const entries = await effectiveAccessEntries(db, restricted);
  assert.deepEqual(entries, [{ kind: "group", principal: "GROUP_ID_APOLLO" }]);

  const member = identity({ globalScope: "write", groupIds: ["GROUP_ID_APOLLO"] });
  const outsider = identity({ globalScope: "manage", groupIds: ["GROUP_ID_OTHER"] });
  const admin = identity({ globalScope: "admin" });

  assert.equal(canSeeNode(member, entries), true);
  assert.equal(canSeeNode(outsider, entries), false);
  assert.equal(canSeeNode(admin, entries), true);
});

// --- Scenario 3: email principal (migration leftover) matches identity.groups ---

test("3. email principal (migration leftover): matched via identity.groups, not groupIds", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group");
  await addAccessRow(db, restricted, "group", "apollo@x.com");

  const entries = await effectiveAccessEntries(db, restricted);
  assert.deepEqual(entries, [{ kind: "group", principal: "apollo@x.com" }]);

  const member = identity({ globalScope: "write", groups: ["apollo@x.com"] });
  const memberDifferentCase = identity({ globalScope: "write", groups: ["Apollo@X.com"] });
  const outsider = identity({ globalScope: "manage", groups: ["other@x.com"] });

  assert.equal(canSeeNode(member, entries), true);
  assert.equal(canSeeNode(memberDifferentCase, entries), true, "case-insensitive email match");
  assert.equal(canSeeNode(outsider, entries), false);
});

// --- Scenario 4: user row (principal = users.id) ---

test("4. user row (principal = users.id): that user sees, another user does not", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group");
  await addAccessRow(db, restricted, "user", "U1");

  const entries = await effectiveAccessEntries(db, restricted);
  assert.deepEqual(entries, [{ kind: "user", principal: "U1" }]);

  const grantedUser = identity({ globalScope: "write", userId: "U1" });
  const otherUser = identity({ globalScope: "manage", userId: "U2" });

  assert.equal(canSeeNode(grantedUser, entries), true);
  assert.equal(canSeeNode(otherUser, entries), false);
});

// --- Scenario 5: override, not merge ---

test("5. override: child's own ACL replaces the parent's, it does not merge", async () => {
  const { db, orgId } = await makeSharedDb();
  const parentRestricted = await addNode(db, orgId, "group");
  await addAccessRow(db, parentRestricted, "group", "GROUP_A");
  const child = await addNode(db, parentRestricted, "group");
  await addAccessRow(db, child, "group", "GROUP_B");

  const childEntries = await effectiveAccessEntries(db, child);
  assert.deepEqual(childEntries, [{ kind: "group", principal: "GROUP_B" }]);

  const memberOfA = identity({ globalScope: "write", groupIds: ["GROUP_A"] });
  const memberOfB = identity({ globalScope: "write", groupIds: ["GROUP_B"] });

  assert.equal(
    canSeeNode(memberOfA, childEntries),
    false,
    "member of the parent's group A must NOT see the child (child overrides, does not inherit A)",
  );
  assert.equal(
    canSeeNode(memberOfB, childEntries),
    true,
    "member of the child's own group B sees the child",
  );
});

// --- Scenario 6: visibility='group' with no rows -> fail-closed [] ---

test("6. visibility='group' with no node_access rows: entries [], only admin sees", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group");
  // No node_access rows inserted -- fail-closed.

  const entries = await effectiveAccessEntries(db, restricted);
  assert.deepEqual(entries, []);

  const anyIdentity = identity({ globalScope: "manage", groups: ["whatever@x.com"] });
  const admin = identity({ globalScope: "admin" });

  assert.equal(canSeeNode(anyIdentity, entries), false);
  assert.equal(canSeeNode(admin, entries), true);
});

// --- Scenario 7: nonexistent node ---

test("7. nonexistent node: effectiveAccessEntries returns null, nodeVisibleTo is true (old contract)", async () => {
  const { db } = await makeSharedDb();
  const missing = ulid();

  assert.equal(await effectiveAccessEntries(db, missing), null);
  const outsider = identity({ globalScope: "manage" });
  assert.equal(await nodeVisibleTo(db, outsider, missing), true);
});

// --- Scenario 8: cycle guard ---

test("8. cycle guard: A belongs_to B belongs_to A terminates instead of looping forever", async () => {
  const { db } = await makeSharedDb();
  const a = ulid();
  const b = ulid();
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
          VALUES (?, 'project', 'A', 'active', 'team', ?, ?)`,
    args: [a, `project:a-${a}`, SOLO],
  });
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
          VALUES (?, 'project', 'B', 'active', 'team', ?, ?)`,
    args: [b, `project:b-${b}`, SOLO],
  });
  await db.execute({
    sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)`,
    args: [ulid(), a, b, SOLO],
  });
  await db.execute({
    sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)`,
    args: [ulid(), b, a, SOLO],
  });

  const entries = await effectiveAccessEntries(db, a);
  assert.equal(entries, null, "cycle with no ACL resolves to unrestricted, not a hang");
});

// --- canSeeNode: direct unit coverage ---

test("canSeeNode: null entries always visible, admin bypasses restricted entries", () => {
  const outsider = identity({ globalScope: "manage" });
  const admin = identity({ globalScope: "admin" });
  assert.equal(canSeeNode(outsider, null), true);
  assert.equal(canSeeNode(admin, [{ kind: "group", principal: "GROUP_X" }]), true);
  assert.equal(canSeeNode(outsider, [{ kind: "group", principal: "GROUP_X" }]), false);
});

// --- resolveAccessChain: source node id for inheritance display ---

test("resolveAccessChain: reports the ancestor node that owns the effective ACL", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group");
  await addAccessRow(db, restricted, "group", "GROUP_A");
  const child = await addNode(db, restricted, "team");

  const childChain = await resolveAccessChain(db, child);
  assert.equal(childChain.sourceNodeId, restricted);
  assert.deepEqual(childChain.entries, [{ kind: "group", principal: "GROUP_A" }]);

  const rootChain = await resolveAccessChain(db, orgId);
  assert.equal(rootChain.sourceNodeId, null);
  assert.equal(rootChain.entries, null);
});

// --- resolveAccessChain: access_mode semantics ---

test("resolveAccessChain: mode defaults to 'private' on a restricted node", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group");
  await addAccessRow(db, restricted, "group", "GROUP_A");

  const chain = await resolveAccessChain(db, restricted);
  assert.equal(chain.mode, "private");
});

test("resolveAccessChain: 'request' mode inherits to a child without its own ACL", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "request");
  await addAccessRow(db, restricted, "group", "GROUP_A");
  const child = await addNode(db, restricted, "team");

  const childChain = await resolveAccessChain(db, child);
  assert.equal(childChain.sourceNodeId, restricted, "child inherits the ancestor's chain");
  assert.equal(childChain.mode, "request", "child inherits the ancestor's mode along with entries");
});

test("resolveAccessChain: a child with its own ACL uses its own mode, not the ancestor's", async () => {
  const { db, orgId } = await makeSharedDb();
  const parentRestricted = await addNode(db, orgId, "group", "request");
  await addAccessRow(db, parentRestricted, "group", "GROUP_A");
  const child = await addNode(db, parentRestricted, "group", "private");
  await addAccessRow(db, child, "group", "GROUP_B");

  const childChain = await resolveAccessChain(db, child);
  assert.equal(childChain.sourceNodeId, child, "child is authoritative for itself");
  assert.equal(childChain.mode, "private", "child's own mode overrides, does not inherit 'request'");
});

test("resolveAccessChain: mode is null when the chain is unrestricted", async () => {
  const { db, orgId } = await makeSharedDb();
  const child = await addNode(db, orgId, "team", "request");

  const chain = await resolveAccessChain(db, child);
  assert.equal(chain.entries, null, "unrestricted -- access_mode column value is irrelevant");
  assert.equal(chain.mode, null, "mode must be null, not the raw column value, when unrestricted");
});

test("resolveAccessChain: fail-closed node (visibility='group', no rows) still reports its own mode", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "request");
  // No node_access rows -- fail-closed entries [].

  const chain = await resolveAccessChain(db, restricted);
  assert.deepEqual(chain.entries, []);
  assert.equal(chain.mode, "request", "mode is read from the same fail-closed node");
});

// --- classifyNodeVisibility: three-way classification for edge/related filters ---

test("classifyNodeVisibility: admin sees everything as visible without resolving chains", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "request");
  await addAccessRow(db, restricted, "group", "GROUP_A");

  const admin = identity({ globalScope: "admin" });
  const result = await classifyNodeVisibility(db, admin, [restricted, orgId]);
  assert.equal(result.get(restricted), "visible");
  assert.equal(result.get(orgId), "visible");
});

test("classifyNodeVisibility: member of the ACL sees 'visible', unrestricted sibling is 'visible' too", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "request");
  await addAccessRow(db, restricted, "group", "GROUP_A");
  const sibling = await addNode(db, orgId, "team");

  const member = identity({ globalScope: "write", groupIds: ["GROUP_A"] });
  const result = await classifyNodeVisibility(db, member, [restricted, sibling]);
  assert.equal(result.get(restricted), "visible");
  assert.equal(result.get(sibling), "visible");
});

test("classifyNodeVisibility: non-member of a 'request' node gets 'request', not 'hidden'", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "request");
  await addAccessRow(db, restricted, "group", "GROUP_A");

  const outsider = identity({ globalScope: "write", groupIds: ["GROUP_OTHER"] });
  const result = await classifyNodeVisibility(db, outsider, [restricted]);
  assert.equal(result.get(restricted), "request");
});

test("classifyNodeVisibility: non-member of a 'private' node gets 'hidden'", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "private");
  await addAccessRow(db, restricted, "group", "GROUP_A");

  const outsider = identity({ globalScope: "write", groupIds: ["GROUP_OTHER"] });
  const result = await classifyNodeVisibility(db, outsider, [restricted]);
  assert.equal(result.get(restricted), "hidden");
});

test("classifyNodeVisibility: fail-closed 'request' node classifies as 'request' for a non-admin", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "request");
  // No node_access rows -- fail-closed entries [].

  const outsider = identity({ globalScope: "write", groupIds: ["ANY_GROUP"] });
  const result = await classifyNodeVisibility(db, outsider, [restricted]);
  assert.equal(result.get(restricted), "request");
});

test("classifyNodeVisibility: dedupes repeated ids in the input, one entry per id in the result", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "request");
  await addAccessRow(db, restricted, "group", "GROUP_A");
  const sibling = await addNode(db, orgId, "team");

  const outsider = identity({ globalScope: "write", groupIds: ["GROUP_OTHER"] });
  const result = await classifyNodeVisibility(db, outsider, [restricted, restricted, sibling, sibling, restricted]);
  assert.equal(result.size, 2, "duplicate ids collapse to one map entry each");
  assert.equal(result.get(restricted), "request");
  assert.equal(result.get(sibling), "visible");
});

// --- filterVisibleNodeIds: batch memoized filter ---

test("filterVisibleNodeIds: member sees restricted + its child, outsider only sees the unrestricted sibling", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group");
  await addAccessRow(db, restricted, "group", "GROUP_A");
  const child = await addNode(db, restricted, "team");
  const sibling = await addNode(db, orgId, "team");

  const member = identity({ globalScope: "write", groupIds: ["GROUP_A"] });
  const outsider = identity({ globalScope: "manage", groupIds: ["GROUP_OTHER"] });

  const memberVisible = await filterVisibleNodeIds(db, member, [restricted, child, sibling]);
  assert.ok(memberVisible.has(restricted));
  assert.ok(memberVisible.has(child));
  assert.ok(memberVisible.has(sibling));

  const outsiderVisible = await filterVisibleNodeIds(db, outsider, [restricted, child, sibling]);
  assert.ok(!outsiderVisible.has(restricted));
  assert.ok(!outsiderVisible.has(child));
  assert.ok(outsiderVisible.has(sibling));
});

test("filterVisibleNodeIds: admin sees everything without resolving chains", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group");
  await addAccessRow(db, restricted, "group", "GROUP_A");

  const admin = identity({ globalScope: "admin" });
  const visible = await filterVisibleNodeIds(db, admin, [restricted, orgId]);
  assert.ok(visible.has(restricted));
  assert.ok(visible.has(orgId));
});

// --- MCP end-to-end: portuni_get_node on restricted node from outsider returns not-found, not elicit ---

test("portuni_get_node: outsider gets not-found for a node_access-restricted node", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "portuni-node-access-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();

  const db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  setDbForTesting(db);

  const orgId = ulid();
  await db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, ?, ?, ?, ?)",
    args: [orgId, "organization", "TestOrg", "testorg", SOLO],
  });

  const restrictedId = await addNode(db, orgId, "group");
  await addAccessRow(db, restrictedId, "group", "GROUP_APOLLO");

  const outsiderIdentity: RequestIdentity = {
    userId: SOLO,
    email: "outsider@x.com",
    name: "Outsider",
    globalScope: "manage",
    groups: [],
    groupIds: ["GROUP_OTHER"],
    via: "env",
  };

  const { server, scope } = createMcpServer(outsiderIdentity);

  // Seed the restricted node into scope so the scope gate allows the read
  // (we want to test the group-visibility gate, not the scope gate)
  scope.add(orgId);
  scope.add(restrictedId);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new McpClient(
    { name: "test-node-access-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);

  const result = await mcpClient.callTool({
    name: "portuni_get_node",
    arguments: { node_id: restrictedId },
  });

  await mcpClient.close();
  setDbForTesting(null);
  resetLocalDbForTests();
  await rm(workspace, { recursive: true, force: true });

  // Must be an error (not-found equivalent), NOT a scope_expansion_required elicit
  assert.equal(result.isError, true, "should be an error");
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assert.ok(!text.includes("scope_expansion_required"), "must not elicit — that would leak existence");
  assert.ok(
    text.includes("not found") || text.includes("not_found"),
    `expected not-found, got: ${text}`,
  );
});
