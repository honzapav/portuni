// Regression tests for issue #182: eight mutating MCP tools that had NO
// access check at all (not even nodeVisibleTo). Mirrors the pattern in
// test/auth-node-access-integration.test.ts -- an outsider gets the same
// "node not found" shape as a nonexistent node, a group member succeeds.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { upsertRemote, addRule } from "../apps/server/domain/sync/routing.js";
import { createMcpServer, type SessionCtx } from "../apps/server/mcp/server.js";
import { SessionScope } from "../apps/server/mcp/scope.js";
import { createDiskProjector } from "../apps/server/mcp/disk-projection.js";
import { registerFileTools } from "../apps/server/mcp/tools/files.js";
import {
  __setSnapshotExporterForTests,
  __resetSnapshotExporterForTests,
} from "../apps/server/mcp/tools/sync-snapshot.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

// portuni_delete_file requires globalScope 'admin' at the MCP tool-scope
// gate (TOOL_MIN_SCOPE), and an 'admin' identity also bypasses node-level
// ACLs entirely (canSeeNode's admin short-circuit) -- so there is no
// identity that both passes the gate and is blocked by group visibility.
// To exercise the access check this issue adds, register just the file
// tools directly (bypassing gateToolsByScope) so a non-admin identity can
// reach the handler and prove the nodeVisibleTo guard fires on its own.
async function connectRawFileTools(identity: RequestIdentity): Promise<McpClient> {
  // "env": historical unscoped behavior -- these tests deliberately bypass
  // the normal tool-scope gate to isolate the group-visibility check, and
  // "env" is also exempt from the write gate (write-gate.test.ts covers the
  // write gate itself). "strict" was a pre-#184 scope-mode literal; it is
  // not a valid SessionType and only worked here by accident (test files
  // are outside tsconfig's typecheck).
  const scope = new SessionScope("env");
  const projector = createDiskProjector({ userId: identity.userId, scope });
  const ctx: SessionCtx = { scope, identity, projector };
  const server = new McpServer({ name: "raw-files-test", version: "0.0.1" }, {});
  registerFileTools(server, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "raw-files-test-client", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const SOLO = "01SOLO0000000000000000000";
const SECRET_GROUP = "secret@x.com";
const OTHER_GROUP = "other@x.com";

function makeOutsider(): RequestIdentity {
  return {
    userId: SOLO,
    email: "outsider@x.com",
    name: "Outsider",
    globalScope: "manage",
    groups: [OTHER_GROUP],
    groupIds: [],
    via: "env",
  };
}

function makeMember(): RequestIdentity {
  return {
    userId: SOLO,
    email: "member@x.com",
    name: "Member",
    globalScope: "manage",
    groups: [SECRET_GROUP],
    groupIds: [],
    via: "env",
  };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("Access checks on the eight previously-unguarded write tools", () => {
  let db: DbClient;
  let workspace: string;
  let remoteRoot: string;
  let orgId: string;
  let restrictedOrgId: string;
  let restrictedNodeId: string;
  let visibleNodeId: string;

  let outsiderClient: McpClient;
  let memberClient: McpClient;

  let storedFileId: string;
  let storedRemotePath: string;
  let visibleFileId: string;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-write-tools-"));
    remoteRoot = await mkdtemp(join(tmpdir(), "portuni-write-tools-remote-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();
    resetAdapterCacheForTests();

    db = createDbClient({ url: ":memory:" });
    await ensureSchemaOn(db);
    setDbForTesting(db);

    orgId = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'organization', 'Acme', 'acme', ?)",
      args: [orgId, SOLO],
    });

    restrictedOrgId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, visibility, sync_key, created_by)
            VALUES (?, 'organization', 'SecretOrg', 'group', ?, ?)`,
      args: [restrictedOrgId, `org-${restrictedOrgId}`, SOLO],
    });
    await db.execute({
      sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
            VALUES (?, 'group', ?, ?, ?)`,
      args: [restrictedOrgId, SECRET_GROUP, SECRET_GROUP, SOLO],
    });

    restrictedNodeId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
            VALUES (?, 'project', 'RestrictedProject', 'active', 'group', ?, ?)`,
      args: [restrictedNodeId, `proj-${restrictedNodeId}`, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), restrictedNodeId, orgId, SOLO],
    });
    await db.execute({
      sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
            VALUES (?, 'group', ?, ?, ?)`,
      args: [restrictedNodeId, SECRET_GROUP, SECRET_GROUP, SOLO],
    });

    visibleNodeId = ulid();
    await db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, sync_key, created_by)
            VALUES (?, 'project', 'VisibleProject', 'active', ?, ?)`,
      args: [visibleNodeId, `proj-${visibleNodeId}`, SOLO],
    });
    await db.execute({
      sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', ?)",
      args: [ulid(), visibleNodeId, orgId, SOLO],
    });

    await upsertRemote(db, {
      name: "test-fs",
      type: "fs",
      config: { root: remoteRoot },
      created_by: SOLO,
    });
    await addRule(db, { priority: 10, node_type: null, org_slug: null, remote_name: "test-fs" });

    await registerMirror(SOLO, restrictedNodeId, join(workspace, "restricted-mirror"));
    await registerMirror(SOLO, visibleNodeId, join(workspace, "visible-mirror"));

    const { server: outsiderServer } = createMcpServer(makeOutsider());
    const [outsiderClientT, outsiderServerT] = InMemoryTransport.createLinkedPair();
    outsiderClient = new McpClient({ name: "outsider", version: "0.0.1" }, { capabilities: {} });
    await outsiderServer.connect(outsiderServerT);
    await outsiderClient.connect(outsiderClientT);

    const { server: memberServer } = createMcpServer(makeMember());
    const [memberClientT, memberServerT] = InMemoryTransport.createLinkedPair();
    memberClient = new McpClient({ name: "member", version: "0.0.1" }, { capabilities: {} });
    await memberServer.connect(memberServerT);
    await memberClient.connect(memberClientT);

    // Seed one real tracked file (and its remote bytes) on the restricted
    // node and one on the visible node, via the member's own portuni_store
    // call -- exercised as a regular tool call so it doubles as the "member
    // succeeds" proof for portuni_store.
    const srcFile = join(workspace, "note.md");
    await writeFile(srcFile, "hello from the test");
    const storeResult = await memberClient.callTool({
      name: "portuni_store",
      arguments: { node_id: restrictedNodeId, local_path: srcFile },
    });
    assert.notEqual(storeResult.isError, true, "member portuni_store should succeed");
    const storePayload = payloadOf(storeResult as ToolResult);
    storedFileId = storePayload.file_id as string;
    storedRemotePath = storePayload.remote_path as string;

    const visibleSrcFile = join(workspace, "visible-note.md");
    await writeFile(visibleSrcFile, "visible content");
    const visibleStoreResult = await memberClient.callTool({
      name: "portuni_store",
      arguments: { node_id: visibleNodeId, local_path: visibleSrcFile },
    });
    assert.notEqual(visibleStoreResult.isError, true, "member store on visible node should succeed");
    visibleFileId = payloadOf(visibleStoreResult as ToolResult).file_id as string;
  });

  after(async () => {
    await outsiderClient.close();
    await memberClient.close();
    setDbForTesting(null);
    resetLocalDbForTests();
    resetAdapterCacheForTests();
    __resetSnapshotExporterForTests();
    await rm(workspace, { recursive: true, force: true });
    await rm(remoteRoot, { recursive: true, force: true });
  });

  test("portuni_create_node: outsider under a restricted organization_id gets not-found, no node created", async () => {
    const result = await outsiderClient.callTool({
      name: "portuni_create_node",
      arguments: { type: "project", name: "SneakyNode", organization_id: restrictedOrgId },
    });
    assert.equal(result.isError, true);
    assert.equal((result as ToolResult).content[0].text, "Error: node not found");

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM nodes WHERE name = 'SneakyNode'",
      args: [],
    });
    assert.equal(rows.rows[0].cnt as number, 0);
  });

  test("portuni_create_node: member under the same organization_id succeeds", async () => {
    const result = await memberClient.callTool({
      name: "portuni_create_node",
      arguments: { type: "project", name: "LegitNode", organization_id: restrictedOrgId },
    });
    assert.notEqual(result.isError, true);
    const payload = payloadOf(result as ToolResult);
    assert.equal(payload.belongs_to, restrictedOrgId);

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM nodes WHERE name = 'LegitNode'",
      args: [],
    });
    assert.equal(rows.rows[0].cnt as number, 1);
  });

  test("portuni_store: outsider on the restricted node gets not-found, no file row created", async () => {
    const srcFile = join(workspace, "outsider-note.md");
    await writeFile(srcFile, "should not land");
    const result = await outsiderClient.callTool({
      name: "portuni_store",
      arguments: { node_id: restrictedNodeId, local_path: srcFile },
    });
    assert.equal(result.isError, true);
    assert.equal((result as ToolResult).content[0].text, "Error: node not found");

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM files WHERE node_id = ? AND filename = 'outsider-note.md'",
      args: [restrictedNodeId],
    });
    assert.equal(rows.rows[0].cnt as number, 0);
  });

  test("portuni_pull: outsider file_id and node_id modes on the restricted node get not-found", async () => {
    const byFile = await outsiderClient.callTool({
      name: "portuni_pull",
      arguments: { file_id: storedFileId },
    });
    assert.equal(byFile.isError, true);
    assert.equal((byFile as ToolResult).content[0].text, "Error: node not found");

    const byNode = await outsiderClient.callTool({
      name: "portuni_pull",
      arguments: { node_id: restrictedNodeId },
    });
    assert.equal(byNode.isError, true);
    assert.equal((byNode as ToolResult).content[0].text, "Error: node not found");
  });

  test("portuni_pull: member file_id and node_id modes on the restricted node succeed", async () => {
    const byNode = await memberClient.callTool({
      name: "portuni_pull",
      arguments: { node_id: restrictedNodeId },
    });
    assert.notEqual(byNode.isError, true);
    const previewPayload = payloadOf(byNode as ToolResult) as { files: unknown[] };
    assert.ok(Array.isArray(previewPayload.files));

    const byFile = await memberClient.callTool({
      name: "portuni_pull",
      arguments: { file_id: storedFileId, force: true },
    });
    assert.notEqual(byFile.isError, true);
    const pullPayload = payloadOf(byFile as ToolResult);
    assert.equal(pullPayload.file_id, storedFileId);
  });

  test("portuni_move_file: outsider blocked via the source node", async () => {
    const result = await outsiderClient.callTool({
      name: "portuni_move_file",
      arguments: { file_id: storedFileId, new_subpath: "archive" },
    });
    assert.equal(result.isError, true);
    assert.equal((result as ToolResult).content[0].text, "Error: node not found");

    const row = await db.execute({
      sql: "SELECT remote_path FROM files WHERE id = ?",
      args: [storedFileId],
    });
    assert.equal(row.rows[0].remote_path, storedRemotePath, "file must not have moved");
  });

  test("portuni_move_file: outsider blocked via the destination node (new_node_id), even though the source is visible", async () => {
    const result = await outsiderClient.callTool({
      name: "portuni_move_file",
      arguments: { file_id: visibleFileId, new_node_id: restrictedNodeId },
    });
    assert.equal(result.isError, true);
    assert.equal((result as ToolResult).content[0].text, "Error: node not found");

    const row = await db.execute({
      sql: "SELECT node_id FROM files WHERE id = ?",
      args: [visibleFileId],
    });
    assert.equal(row.rows[0].node_id, visibleNodeId, "file must not have been reparented");
  });

  test("portuni_move_file: member on the restricted node gets a preview (not blocked)", async () => {
    const result = await memberClient.callTool({
      name: "portuni_move_file",
      arguments: { file_id: storedFileId, new_subpath: "archive" },
    });
    assert.notEqual(result.isError, true);
    const payload = payloadOf(result as ToolResult);
    assert.equal(payload.requires_confirmation, true);
  });

  test("portuni_rename_folder: outsider on the restricted node gets not-found", async () => {
    const result = await outsiderClient.callTool({
      name: "portuni_rename_folder",
      arguments: { node_id: restrictedNodeId, old_prefix: "wip", new_prefix: "wip2" },
    });
    assert.equal(result.isError, true);
    assert.equal((result as ToolResult).content[0].text, "Error: node not found");
  });

  test("portuni_rename_folder: member on the restricted node gets a preview (not blocked)", async () => {
    const result = await memberClient.callTool({
      name: "portuni_rename_folder",
      arguments: { node_id: restrictedNodeId, old_prefix: "wip", new_prefix: "wip2" },
    });
    assert.notEqual(result.isError, true);
  });

  test("portuni_adopt_files: outsider on the restricted node gets not-found, no row created", async () => {
    const adoptSrc = join(workspace, "adopt-src.md");
    await writeFile(adoptSrc, "adopt me");
    const stored = await memberClient.callTool({
      name: "portuni_store",
      arguments: { node_id: restrictedNodeId, local_path: adoptSrc },
    });
    const storedPayload = payloadOf(stored as ToolResult);
    const adoptFileId = storedPayload.file_id as string;
    const adoptRemotePath = storedPayload.remote_path as string;
    // Simulate a "new_remote" file: drop the tracking row but leave the
    // remote bytes in place, exactly like a file created elsewhere.
    await db.execute({ sql: "DELETE FROM files WHERE id = ?", args: [adoptFileId] });

    const result = await outsiderClient.callTool({
      name: "portuni_adopt_files",
      arguments: { node_id: restrictedNodeId, paths: [adoptRemotePath] },
    });
    assert.equal(result.isError, true);
    assert.equal((result as ToolResult).content[0].text, "Error: node not found");

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM files WHERE node_id = ? AND remote_path = ?",
      args: [restrictedNodeId, adoptRemotePath],
    });
    assert.equal(rows.rows[0].cnt as number, 0);

    const memberResult = await memberClient.callTool({
      name: "portuni_adopt_files",
      arguments: { node_id: restrictedNodeId, paths: [adoptRemotePath] },
    });
    assert.notEqual(memberResult.isError, true);
    const adoptPayload = payloadOf(memberResult as ToolResult) as {
      adopted: Array<{ remote_path: string }>;
    };
    assert.ok(adoptPayload.adopted.some((a) => a.remote_path === adoptRemotePath));
  });

  test("portuni_delete_file: non-member gets not-found, member succeeds (raw handler, bypassing the admin-only tool gate)", async () => {
    const delSrc = join(workspace, "delete-src.md");
    await writeFile(delSrc, "delete me");
    const stored = await memberClient.callTool({
      name: "portuni_store",
      arguments: { node_id: restrictedNodeId, local_path: delSrc },
    });
    const deleteFileId = payloadOf(stored as ToolResult).file_id as string;

    const rawOutsider = await connectRawFileTools(makeOutsider());
    const rawMember = await connectRawFileTools(makeMember());

    const result = await rawOutsider.callTool({
      name: "portuni_delete_file",
      arguments: { file_id: deleteFileId },
    });
    assert.equal(result.isError, true);
    assert.equal((result as ToolResult).content[0].text, "Error: node not found");

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM files WHERE id = ?",
      args: [deleteFileId],
    });
    assert.equal(rows.rows[0].cnt as number, 1, "file must still exist");

    const memberResult = await rawMember.callTool({
      name: "portuni_delete_file",
      arguments: { file_id: deleteFileId },
    });
    assert.notEqual(memberResult.isError, true);
    const payload = payloadOf(memberResult as ToolResult);
    assert.equal(payload.requires_confirmation, true);

    await rawOutsider.close();
    await rawMember.close();
  });

  test("portuni_snapshot: outsider on the restricted node gets not-found, exporter never runs", async () => {
    let exportCalls = 0;
    __setSnapshotExporterForTests(async () => {
      exportCalls++;
      return Buffer.from("pretend-pdf");
    });

    const result = await outsiderClient.callTool({
      name: "portuni_snapshot",
      arguments: {
        node_id: restrictedNodeId,
        doc_url: "https://docs.google.com/document/d/ABC123/edit",
      },
    });
    assert.equal(result.isError, true);
    assert.equal((result as ToolResult).content[0].text, "Error: node not found");
    assert.equal(exportCalls, 0, "exporter must not run when access is denied");

    const memberResult = await memberClient.callTool({
      name: "portuni_snapshot",
      arguments: {
        node_id: restrictedNodeId,
        doc_url: "https://docs.google.com/document/d/ABC123/edit",
      },
    });
    assert.notEqual(memberResult.isError, true);
    assert.equal(exportCalls, 1);
  });
});
