// portuni_search_files: content search over the remotes' own search
// (Drive fullText / fs grep), joined onto `files` so only tracked files
// surface, then filtered by session scope and group visibility. Domain
// tests run against the shared-db fs remote (no mirror anywhere -- the
// remote-client case); the MCP test proves a hit on a node the caller
// cannot see is never returned.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { getAdapter, resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { buildRemotePath } from "../apps/server/domain/sync/remote-path.js";
import { resolveNodeInfo } from "../apps/server/domain/sync/node-info.js";
import { searchFiles } from "../apps/server/domain/search-files.js";
import { createMcpServer } from "../apps/server/mcp/server.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";

let shared: SharedDb;
let workspace: string;
let originalRoot: string | undefined;
let originalMode: string | undefined;

async function remotePathFor(nodeId: string, relPath: string): Promise<string> {
  const info = await resolveNodeInfo(shared.db, nodeId);
  const segs = relPath.split("/");
  return buildRemotePath({
    ...info,
    section: segs[0] as "wip" | "outputs" | "resources",
    subpath: segs.length > 2 ? segs.slice(1, -1).join("/") : null,
    filename: segs[segs.length - 1],
  });
}

// Bytes on the remote + a files row: what a tracked file looks like to a
// server with no mirror.
async function seedTracked(nodeId: string, relPath: string, content: string): Promise<string> {
  const remotePath = await remotePathFor(nodeId, relPath);
  const adapter = await getAdapter(shared.db, "test-fs");
  await adapter.put(remotePath, Buffer.from(content, "utf8"));
  const id = ulid();
  await shared.db.execute({
    sql: `INSERT INTO files (id, node_id, filename, remote_name, remote_path, status, created_by)
          VALUES (?, ?, ?, ?, ?, 'wip', 'U1')`,
    args: [id, nodeId, relPath.split("/").pop()!, "test-fs", remotePath],
  });
  return id;
}

async function insertProject(name: string, opts: { accessGroup?: string } = {}): Promise<string> {
  const id = ulid();
  await shared.db.execute({
    sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', ?, ?, 'U1')",
    args: [id, name, `p-${id.toLowerCase()}`],
  });
  await shared.db.execute({
    sql: "INSERT INTO edges (id, source_id, target_id, relation, created_by) VALUES (?, ?, ?, 'belongs_to', 'U1')",
    args: [ulid(), id, shared.orgId],
  });
  if (opts.accessGroup) {
    await shared.db.execute({
      sql: `INSERT INTO node_access (node_id, kind, principal, display_email, added_by)
            VALUES (?, 'group', ?, ?, 'U1')`,
      args: [id, opts.accessGroup, opts.accessGroup],
    });
  }
  return id;
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-search-files-"));
  originalRoot = process.env.PORTUNI_WORKSPACE_ROOT;
  originalMode = process.env.PORTUNI_SCOPE_MODE;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  shared = await makeSharedDb();
  setDbForTesting(shared.db);
});

afterEach(async () => {
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalRoot === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalRoot;
  if (originalMode === undefined) delete process.env.PORTUNI_SCOPE_MODE;
  else process.env.PORTUNI_SCOPE_MODE = originalMode;
  await rm(workspace, { recursive: true, force: true });
  await rm(shared.remoteRoot, { recursive: true, force: true });
});

describe("searchFiles (domain)", () => {
  it("returns tracked files whose content matches, with the node-relative path", async () => {
    const fileId = await seedTracked(shared.nodeId, "wip/notes.md", "# Plan\nquarterly budget review\n");
    await seedTracked(shared.nodeId, "wip/sub/other.md", "unrelated text\n");
    const hits = await searchFiles(shared.db, { query: "Quarterly Budget", limit: 20 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file_id, fileId);
    assert.equal(hits[0].node_id, shared.nodeId);
    assert.equal(hits[0].node_name, "Stan GWS");
    assert.equal(hits[0].node_type, "project");
    assert.equal(hits[0].filename, "notes.md");
    assert.equal(hits[0].path, "wip/notes.md");
    assert.equal(hits[0].mime_type, "text/markdown");
    assert.equal(hits[0].snippet, "quarterly budget review");
  });

  it("drops remote objects that have no files record", async () => {
    const adapter = await getAdapter(shared.db, "test-fs");
    await adapter.put("workflow/projects/stan-gws/wip/loose.md", Buffer.from("secret needle"));
    const hits = await searchFiles(shared.db, { query: "needle", limit: 20 });
    assert.deepEqual(hits, []);
  });

  it("nodeId restricts hits to that node; nodeIds restricts to the set", async () => {
    const other = await insertProject("Other");
    await seedTracked(shared.nodeId, "wip/a.md", "needle in A\n");
    await seedTracked(other, "wip/b.md", "needle in B\n");
    const byNode = await searchFiles(shared.db, { query: "needle", limit: 20, nodeId: other });
    assert.deepEqual(byNode.map((h) => h.node_id), [other]);
    const bySet = await searchFiles(shared.db, { query: "needle", limit: 20, nodeIds: [shared.nodeId] });
    assert.deepEqual(bySet.map((h) => h.node_id), [shared.nodeId]);
    const none = await searchFiles(shared.db, { query: "needle", limit: 20, nodeIds: [] });
    assert.deepEqual(none, []);
    const all = await searchFiles(shared.db, { query: "needle", limit: 20 });
    assert.equal(all.length, 2);
  });

  it("caps at limit", async () => {
    for (let i = 0; i < 4; i++) await seedTracked(shared.nodeId, `wip/f${i}.md`, "needle\n");
    const hits = await searchFiles(shared.db, { query: "needle", limit: 2 });
    assert.equal(hits.length, 2);
  });
});

async function connectTool(identity: RequestIdentity, scopeNodeIds: string[]) {
  const { server, scope } = createMcpServer(identity);
  for (const id of scopeNodeIds) scope.add(id);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "search-files-test", version: "0.0.1" }, { capabilities: {} });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, scope };
}

describe("portuni_search_files (MCP)", () => {
  it("never returns a hit from a node the caller cannot see", async () => {
    process.env.PORTUNI_SCOPE_MODE = "permissive";
    const restricted = await insertProject("Restricted", { accessGroup: "secret@x.com" });
    await seedTracked(shared.nodeId, "wip/open.md", "needle open\n");
    await seedTracked(restricted, "wip/hidden.md", "needle hidden\n");
    const outsider: RequestIdentity = {
      userId: "U1",
      email: "outsider@x.com",
      name: "Outsider",
      globalScope: "manage",
      groups: ["other@x.com"],
      groupIds: [],
      via: "env",
    };
    const { client } = await connectTool(outsider, []);
    try {
      const r = (await client.callTool({
        name: "portuni_search_files",
        arguments: { query: "needle" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.notEqual(r.isError, true, r.content[0]?.text);
      const hits = JSON.parse(r.content[0].text) as Array<{ node_id: string; filename: string; path: string }>;
      assert.deepEqual(hits.map((h) => h.node_id), [shared.nodeId]);
      assert.equal(hits[0].path, "wip/open.md");
      assert.ok(!r.content[0].text.includes("hidden"), "restricted content leaked");
    } finally {
      await client.close();
    }
  });

  it("strict mode without node_id is gated as a global query; with node_id it reads the node", async () => {
    process.env.PORTUNI_SCOPE_MODE = "strict";
    await seedTracked(shared.nodeId, "wip/open.md", "needle open\n");
    const admin: RequestIdentity = {
      userId: "U1",
      email: "a@b",
      name: "A",
      globalScope: "admin",
      groups: [],
      groupIds: [],
      via: "env",
    };
    const { client } = await connectTool(admin, [shared.nodeId]);
    try {
      const gated = (await client.callTool({
        name: "portuni_search_files",
        arguments: { query: "needle" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.equal(gated.isError, true);
      assert.match(gated.content[0].text, /scope_expansion_required/);

      const scoped = (await client.callTool({
        name: "portuni_search_files",
        arguments: { query: "needle", node_id: shared.nodeId },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.notEqual(scoped.isError, true, scoped.content[0]?.text);
      const hits = JSON.parse(scoped.content[0].text) as Array<{ path: string }>;
      assert.deepEqual(hits.map((h) => h.path), ["wip/open.md"]);
    } finally {
      await client.close();
    }
  });

  it("portuni_read_file serves a hit Drive-direct when the node has no mirror here", async () => {
    process.env.PORTUNI_SCOPE_MODE = "permissive";
    await seedTracked(shared.nodeId, "wip/open.md", "needle open\n");
    const admin: RequestIdentity = {
      userId: "U1",
      email: "a@b",
      name: "A",
      globalScope: "admin",
      groups: [],
      groupIds: [],
      via: "env",
    };
    const { client } = await connectTool(admin, [shared.nodeId]);
    try {
      const r = (await client.callTool({
        name: "portuni_read_file",
        arguments: { node_id: shared.nodeId, path: "wip/open.md" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.notEqual(r.isError, true, r.content[0]?.text);
      assert.equal(r.content[0].text, "needle open\n");
    } finally {
      await client.close();
    }
  });
});
