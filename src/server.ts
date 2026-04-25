import "varlock/auto-load";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ensureSchema } from "./schema.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerGetNodeTool } from "./tools/get-node.js";
import { registerEdgeTools } from "./tools/edges.js";
import { registerContextTools } from "./tools/context.js";
import { registerMirrorTools } from "./tools/mirrors.js";
import { registerFileTools } from "./tools/files.js";
import { registerSyncStatusTools } from "./tools/sync-status.js";
import { registerSyncRemoteTools } from "./tools/sync-remotes.js";
import { registerSyncSnapshotTools } from "./tools/sync-snapshot.js";
import { registerEventTools } from "./tools/events.js";
import { registerActorTools, createActor, updateActor, archiveActor } from "./tools/actors.js";
import {
  registerResponsibilityTools,
  createResponsibility,
  updateResponsibility,
  deleteResponsibility,
  listResponsibilities,
  assignResponsibility,
  unassignResponsibility,
} from "./tools/responsibilities.js";
import {
  registerEntityAttributeTools,
  addDataSource,
  updateDataSource,
  removeDataSource,
  listDataSources,
  addTool,
  updateTool,
  removeTool,
  listTools,
} from "./tools/entity-attributes.js";
import { updateNodeInternal } from "./tools/nodes.js";
import { generateSyncKey } from "./sync/sync-key.js";
import { listUserMirrors, unregisterMirror } from "./sync/mirror-registry.js";
import { getLocalMirror } from "./sync/local-db.js";
import { deriveLocalPath, buildNodeRoot } from "./sync/remote-path.js";
import { statusScan, storeFile, pullFile } from "./sync/engine.js";

import { getDb } from "./db.js";
import { SOLO_USER, NODE_TYPES, NODE_VISIBILITIES, EDGE_RELATIONS, EVENT_TYPES } from "./schema.js";
import { NodeRow, NodeSummaryRow } from "./types.js";
import type {
  GraphPayload,
  NodeDetail,
  SyncStatusResponse,
  SyncRunResponse,
} from "./api-types.js";
import { ulid } from "ulid";
import { logAudit } from "./audit.js";

const PORT = Number(process.env.PORT ?? 4011);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = Number(process.env.PORTUNI_MAX_BODY_BYTES ?? 5 * 1024 * 1024);
const MAX_SESSIONS = Number(process.env.PORTUNI_MAX_SESSIONS ?? 100);
const SESSION_TTL_MS = Number(process.env.PORTUNI_SESSION_TTL_MS ?? 30 * 60 * 1000);
const SESSION_GC_INTERVAL_MS = Number(process.env.PORTUNI_SESSION_GC_INTERVAL_MS ?? 60 * 1000);

const DEFAULT_ALLOWED_ORIGINS = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  "http://localhost:4010",
  "http://127.0.0.1:4010",
  "http://portuni.test",
];
const ALLOWED_ORIGINS = new Set(
  (process.env.PORTUNI_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const ALLOWED_HOSTS = new Set(
  [
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    `[::1]:${PORT}`,
    "api.portuni.test",
    ...(process.env.PORTUNI_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ].map((h) => h.toLowerCase()),
);

async function loadGraph(): Promise<GraphPayload> {
  const db = getDb();

  // Return all nodes regardless of status. The frontend filters by
  // completed/archived on the client so toggles are instantaneous and
  // completed work stays visible by default.
  const nodesRes = await db.execute({
    sql: `SELECT id, type, name, description, status, lifecycle_state, pos_x, pos_y
          FROM nodes
          ORDER BY type, name`,
  });

  const edgesRes = await db.execute({
    sql: `SELECT id, source_id, target_id, relation
          FROM edges`,
  });

  return {
    nodes: nodesRes.rows.map((row) => ({
      id: row.id as string,
      type: row.type as string,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      status: row.status as string,
      lifecycle_state: (row.lifecycle_state as string | null) ?? null,
      pos_x: row.pos_x as number | null,
      pos_y: row.pos_y as number | null,
    })),
    edges: edgesRes.rows.map((row) => ({
      id: row.id as string,
      source_id: row.source_id as string,
      target_id: row.target_id as string,
      relation: row.relation as string,
    })),
  };
}

async function loadNodeDetail(nodeId: string): Promise<NodeDetail | null> {
  const db = getDb();

  const nodeRes = await db.execute({
    sql: "SELECT * FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  if (nodeRes.rows.length === 0) return null;
  const row = NodeRow.parse(nodeRes.rows[0]);

  const edgeRes = await db.execute({
    sql: `SELECT e.id, e.source_id, e.target_id, e.relation,
                 ns.name as source_name, ns.type as source_type,
                 nt.name as target_name, nt.type as target_type
          FROM edges e
          JOIN nodes ns ON ns.id = e.source_id
          JOIN nodes nt ON nt.id = e.target_id
          WHERE e.source_id = ? OR e.target_id = ?`,
    args: [row.id, row.id],
  });

  const edges = edgeRes.rows.map((edge) => {
    const sourceId = edge.source_id as string;
    const targetId = edge.target_id as string;
    const isOutgoing = sourceId === row.id;
    return {
      id: edge.id as string,
      relation: edge.relation as string,
      direction: (isOutgoing ? "outgoing" : "incoming") as
        | "outgoing"
        | "incoming",
      peer_id: isOutgoing ? targetId : sourceId,
      peer_name: isOutgoing ? (edge.target_name as string) : (edge.source_name as string),
      peer_type: isOutgoing ? (edge.target_type as string) : (edge.source_type as string),
    };
  });

  const mirror = await getLocalMirror(SOLO_USER, row.id);
  const mirrorPath = mirror?.local_path ?? null;
  const local_mirror = mirror
    ? { local_path: mirror.local_path, registered_at: mirror.registered_at }
    : null;

  // Resolve the org_sync_key once for this node so per-file derivation can
  // reuse it. Organizations themselves have no parent org -- buildNodeRoot
  // falls back to the node's own sync_key in that case.
  let orgSyncKey: string | null = null;
  if (row.type !== "organization") {
    const orgRes = await db.execute({
      sql: `SELECT org.sync_key FROM edges e
              JOIN nodes org ON org.id = e.target_id
             WHERE e.source_id = ? AND e.relation = 'belongs_to' AND org.type = 'organization'
             LIMIT 1`,
      args: [row.id],
    });
    orgSyncKey = orgRes.rows.length > 0 ? (orgRes.rows[0].sync_key as string | null) ?? null : null;
  } else {
    orgSyncKey = row.sync_key;
  }

  const fileRes = await db.execute({
    sql: `SELECT id, filename, status, description, remote_path, mime_type
          FROM files WHERE node_id = ? ORDER BY created_at DESC`,
    args: [row.id],
  });
  const files = fileRes.rows.map((f) => {
    const remotePath = (f.remote_path as string | null) ?? null;
    let derivedLocal: string | null = null;
    if (mirrorPath && remotePath) {
      const nodeRoot = buildNodeRoot({
        orgSyncKey,
        nodeType: row.type,
        nodeSyncKey: row.sync_key,
      });
      try {
        derivedLocal = deriveLocalPath({ mirrorRoot: mirrorPath, nodeRoot, remotePath });
      } catch {
        derivedLocal = null;
      }
    }
    // Strip the mirror root to get the in-mirror path (section + subpath
    // + filename). Falls back to null when the node has no mirror or
    // remote_path was unresolvable above.
    const relative_path =
      mirrorPath && derivedLocal && derivedLocal.startsWith(mirrorPath + "/")
        ? derivedLocal.slice(mirrorPath.length + 1)
        : null;
    return {
      id: f.id as string,
      filename: f.filename as string,
      status: f.status as string,
      description: (f.description as string | null) ?? null,
      local_path: derivedLocal,
      relative_path,
      mime_type: (f.mime_type as string | null) ?? null,
    };
  });

  const eventRes = await db.execute({
    sql: `SELECT id, type, content, meta, status, refs, task_ref, created_at
          FROM events WHERE node_id = ? AND status = 'active'
          ORDER BY created_at DESC LIMIT 20`,
    args: [row.id],
  });
  const events = eventRes.rows.map((e) => ({
    id: e.id as string,
    type: e.type as string,
    content: e.content as string,
    meta: e.meta ? JSON.parse(e.meta as string) : null,
    status: e.status as string,
    refs: e.refs ? JSON.parse(e.refs as string) : null,
    task_ref: (e.task_ref as string | null) ?? null,
    created_at: e.created_at as string,
  }));

  // Owner
  const ownerRow = row.owner_id
    ? (await db.execute({ sql: "SELECT id, name FROM actors WHERE id = ?", args: [row.owner_id] })).rows[0]
    : null;
  const owner = ownerRow ? { id: ownerRow.id as string, name: ownerRow.name as string } : null;

  // Responsibilities with assignees: fetch in two queries (one for the
  // responsibilities, one JOIN that returns every assignee for those
  // responsibilities) and bucket assignees by responsibility id in JS.
  // The previous implementation issued N+1 queries (one per responsibility),
  // which made detail loads scale linearly with assignment fan-out and was
  // noticeable on Turso/cloud DBs.
  const respRes = await db.execute({
    sql: "SELECT id, title, description, sort_order FROM responsibilities WHERE node_id = ? ORDER BY sort_order, title",
    args: [row.id],
  });
  type AssigneeBucket = Array<{ id: string; name: string; type: string }>;
  const assigneesByResp = new Map<string, AssigneeBucket>();
  if (respRes.rows.length > 0) {
    const ids = respRes.rows.map((r) => r.id as string);
    const placeholders = ids.map(() => "?").join(",");
    const assigneeRes = await db.execute({
      sql: `SELECT ra.responsibility_id AS rid, a.id, a.name, a.type
            FROM actors a
            JOIN responsibility_assignments ra ON ra.actor_id = a.id
            WHERE ra.responsibility_id IN (${placeholders})
            ORDER BY a.name`,
      args: ids,
    });
    for (const x of assigneeRes.rows) {
      const rid = x.rid as string;
      let bucket = assigneesByResp.get(rid);
      if (!bucket) {
        bucket = [];
        assigneesByResp.set(rid, bucket);
      }
      bucket.push({
        id: x.id as string,
        name: x.name as string,
        type: x.type as string,
      });
    }
  }
  const responsibilities = respRes.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    sort_order: (r.sort_order as number) ?? 0,
    assignees: assigneesByResp.get(r.id as string) ?? [],
  }));

  // Data sources
  const dsRes = await db.execute({
    sql: "SELECT id, name, description, external_link FROM data_sources WHERE node_id = ? ORDER BY name",
    args: [row.id],
  });
  const data_sources = dsRes.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    external_link: (r.external_link as string | null) ?? null,
  }));

  // Tools
  const toolsRes = await db.execute({
    sql: "SELECT id, name, description, external_link FROM tools WHERE node_id = ? ORDER BY name",
    args: [row.id],
  });
  const tools = toolsRes.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    external_link: (r.external_link as string | null) ?? null,
  }));

  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    meta: row.meta ? JSON.parse(row.meta) : null,
    status: row.status,
    visibility: row.visibility,
    created_at: row.created_at,
    updated_at: row.updated_at,
    edges,
    files,
    events,
    local_mirror,
    owner,
    responsibilities,
    data_sources,
    tools,
    goal: row.goal ?? null,
    lifecycle_state: row.lifecycle_state ?? null,
  };
}

async function resolveContext(path: string): Promise<unknown> {
  const db = getDb();

  // Find node whose local_path matches or is a parent of the given path.
  // Read mirrors from per-device sync.db; tolerate stale rows (mirror exists
  // for a node that was purged from the shared DB) by skipping them and
  // firing a fire-and-forget cleanup.
  const rawMirrors = await listUserMirrors(SOLO_USER);
  const mirrors: Array<{ node_id: string; local_path: string }> = [];
  for (const m of rawMirrors) {
    const e = await db.execute({
      sql: "SELECT 1 FROM nodes WHERE id = ? LIMIT 1",
      args: [m.node_id],
    });
    if (e.rows.length > 0) {
      mirrors.push({ node_id: m.node_id, local_path: m.local_path });
    } else {
      void unregisterMirror(SOLO_USER, m.node_id).catch(() => undefined);
    }
  }
  // Longest-prefix match: order by path length desc (matches old ORDER BY).
  mirrors.sort((a, b) => b.local_path.length - a.local_path.length);

  let nodeId: string | null = null;
  let mirrorPath: string | null = null;
  for (const row of mirrors) {
    const lp = row.local_path;
    if (path === lp || path.startsWith(lp + "/")) {
      nodeId = row.node_id;
      mirrorPath = lp;
      break;
    }
  }

  if (!nodeId) {
    return { match: false, path };
  }

  // Get node
  const nodeRes = await db.execute({
    sql: "SELECT id, type, name, description, status FROM nodes WHERE id = ?",
    args: [nodeId],
  });
  const node = NodeSummaryRow.parse(nodeRes.rows[0]);

  // Get edges (depth 1) with resolved names
  const edges = await db.execute({
    sql: `SELECT e.relation,
            CASE WHEN e.source_id = ? THEN 'outgoing' ELSE 'incoming' END as direction,
            CASE WHEN e.source_id = ? THEN t.id ELSE s.id END as related_id,
            CASE WHEN e.source_id = ? THEN t.name ELSE s.name END as related_name,
            CASE WHEN e.source_id = ? THEN t.type ELSE s.type END as related_type
          FROM edges e
          JOIN nodes s ON e.source_id = s.id
          JOIN nodes t ON e.target_id = t.id
          WHERE e.source_id = ? OR e.target_id = ?`,
    args: [nodeId, nodeId, nodeId, nodeId, nodeId, nodeId],
  });

  // Get recent events for this node (last 5 active)
  const eventRes = await db.execute({
    sql: `SELECT id, type, content, created_at
          FROM events WHERE node_id = ? AND status = 'active'
          ORDER BY created_at DESC LIMIT 5`,
    args: [nodeId],
  });

  const events = eventRes.rows.map((e) => ({
    type: e.type as string,
    content: e.content as string,
    created_at: e.created_at as string,
  }));

  // Get local mirrors for related nodes (per-device sync.db, with stale
  // tolerance like the parent scan above).
  const relatedIds = edges.rows.map((r) => r.related_id as string);
  let relatedMirrors: Record<string, string> = {};
  if (relatedIds.length > 0) {
    const allMirrors = await listUserMirrors(SOLO_USER);
    for (const m of allMirrors) {
      if (!relatedIds.includes(m.node_id)) continue;
      const e = await db.execute({
        sql: "SELECT 1 FROM nodes WHERE id = ? LIMIT 1",
        args: [m.node_id],
      });
      if (e.rows.length > 0) {
        relatedMirrors[m.node_id] = m.local_path;
      } else {
        void unregisterMirror(SOLO_USER, m.node_id).catch(() => undefined);
      }
    }
  }

  return {
    match: true,
    node: {
      id: node.id,
      type: node.type,
      name: node.name,
      description: node.description,
      status: node.status,
      local_path: mirrorPath,
    },
    edges: edges.rows.map((e) => ({
      relation: e.relation,
      direction: e.direction,
      related: {
        id: e.related_id,
        type: e.related_type,
        name: e.related_name,
        local_path: relatedMirrors[e.related_id as string] || null,
      },
    })),
    events,
  };
}

const INSTRUCTIONS = `Portuni is the organizational knowledge graph. It holds the POPP structure (Projects, Organizations, Processes, Principles, Areas) and connects them via edges.

WHEN TO USE: Always check Portuni when working on a task related to an organization, project, process, or area. Before starting work, call portuni_get_context to find relevant nodes and their connections. Use portuni_get_node to get details, files, and local mirror paths for a specific node.

TOOLS:
- portuni_list_nodes: Browse all nodes, filter by type
- portuni_get_node: Get node details with edges, files, and local mirror path
- portuni_get_context: Find related nodes by traversing the graph (use this first)
- portuni_create_node: Create a new node (organization, project, process, area, principle)
- portuni_delete_node: Delete a node (archive=soft delete, purge=hard delete with cascade). Organizations with children cannot be purged.
- portuni_connect / portuni_disconnect: Manage edges between nodes
- portuni_mirror: Create a local folder for a node
- portuni_store: Publish a file to a node (like git commit)
- portuni_pull: Pull files from a node (like git pull)
- portuni_list_files: List files attached to a node
- portuni_log: Log a decision, discovery, blocker, or other knowledge event on a node
- portuni_resolve: Mark an event as resolved
- portuni_supersede: Replace an event with an updated version
- portuni_list_events: Query events with filters (node_id, type, status, since)

NODE TYPES (strictly enforced, five POPP entities): organization, project, process, area, principle. No other types exist. Do not invent new types.

EDGE TYPES (strictly enforced, four flat relations): related_to (near-default, lateral semantic connection), belongs_to (scope -- see organization invariant below), applies (concrete work uses a pattern, e.g. project applies process), informed_by (knowledge transfer). No edge type is privileged. The graph is rhizomatic: any node can connect to any other node. When unsure which relation fits, default to related_to.

ORGANIZATION INVARIANT: Every non-organization node MUST have exactly one belongs_to edge pointing to an organization. No orphans, no multi-parent. When creating a node, portuni_create_node requires the organization_id parameter for every non-organization type -- the tool atomically creates the node and its belongs_to edge. When moving a node to a different organization, do NOT disconnect first: use a single agent turn that disconnects and immediately reconnects to the new organization. Attempting to create a second belongs_to to an organization, or to remove the only one, is rejected both at the tool layer and by a database trigger.

PRINCIPLES AS CULTURE: Principles are not linked to their subjects via an explicit edge. They function as cultural defaults applied to everything in scope. When unsure how to act, look at the principles in the relevant organization. Principles do still belong to an organization via belongs_to (the invariant applies to principles too) -- they are cultural defaults for that organization.

LOCAL MIRRORS: Each node can have a local folder. Use portuni_get_node to find the local_path. The workspace root is configured via PORTUNI_WORKSPACE_ROOT env var. Each mirror has subdirectories: outputs/ (final files), wip/ (work in progress), resources/. Organization workspace folders additionally contain projects/, processes/, areas/, principles/ for organizing child nodes.

FILE SYNC TOOLS (portuni_store / portuni_pull / portuni_status / portuni_list_files / portuni_list_remotes / portuni_setup_remote / portuni_set_routing_policy):
- portuni_store copies a file into the node's mirror and uploads it via the configured remote. Call with node_id + local_path; optional status (wip | output) and subpath.
- portuni_pull with file_id downloads the remote version into the mirror. portuni_pull with node_id returns a preview of each file's status (unchanged/updated/conflict/orphan/native) without modifying anything.
- portuni_status scans tracked files and optionally discovers new local / new remote files. Call at session end when files were touched, before major migrations, or whenever the user asks about sync state.
- Node paths are built from immutable sync_key identifiers, so renaming a node does NOT break remote folder structure.
- Each device has its own mirror registry in .portuni/sync.db. Stale rows (node deleted on another device) are skipped and cleaned up lazily.

Destructive sync operations (confirm-first):
- portuni_delete_file and portuni_move_file return a preview when called without
  confirmed: true. Present the preview to the user, get explicit confirmation,
  then call again with confirmed: true. Do not skip.
- portuni_rename_folder defaults to dry_run: true. Show the affected file list;
  call again with dry_run: false to apply.
- portuni_adopt_files is not destructive. Safe to run after portuni_status
  surfaces new_remote entries.

Operation semantics:
- Operations are best-effort ordered (remote, then local, then DB). On partial
  failure the service returns a structured status "repair_needed" with a
  repair_hint describing the next step. The operator (you, agent) surfaces it
  to the user and follows the hint.

Session discipline:
- Call portuni_status before ending a session if files were touched. It
  classifies tracked files and surfaces untracked local / remote files.
  Move detection flags files where a deleted_local + new_local pair share
  the same last-synced hash.

Data-safety defaults:
- Portuni never auto-deletes and never auto-merges conflicts.
- Hash (not timestamp) is file identity.
- Drive delete is soft (trash, 30-day recovery). Drive versioning is not
  disabled by Portuni.
- Node display names can be renamed freely; sync paths use an immutable
  sync_key, so remote folders stay stable.

EVENT TYPES (strictly enforced): decision, discovery, blocker, reference, milestone, note, change. No other event types are accepted by portuni_log.

NODE STATUSES: active (default), completed, archived. Strictly enforced.

EVENT STATUSES: active (default), resolved, superseded, archived. Use portuni_resolve to mark resolved, portuni_supersede to replace with updated version.

FILE STATUSES: wip (work in progress, default), output (final deliverable). Strictly enforced by portuni_store.

NODE VISIBILITY: team (default), private. "group" is planned but not yet implemented.

EVENTS: Time-ordered knowledge attached to nodes. Log decisions, discoveries, blockers, references, milestones, notes, changes. Use portuni_log to record, portuni_list_events to query. Events appear in portuni_get_node and portuni_get_context responses.`;

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "portuni",
    version: "0.1.0",
  }, {
    instructions: INSTRUCTIONS,
  });
  registerNodeTools(server);
  registerGetNodeTool(server);
  registerEdgeTools(server);
  registerContextTools(server);
  registerMirrorTools(server);
  registerFileTools(server);
  registerSyncStatusTools(server);
  registerSyncRemoteTools(server);
  registerSyncSnapshotTools(server);
  registerEventTools(server);
  registerActorTools(server);
  registerResponsibilityTools(server);
  registerEntityAttributeTools(server);
  return server;
}

class RequestBodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

// Centralised error responder. Logs the full error server-side with a short
// request id; sends a generic message + that id to the client. ZodError
// messages are surfaced as 400 because they describe input shape, not
// internals. Anything else becomes a 500 with a generic body so we don't
// leak DB errors, file paths, or stack traces to the network.
function respondError(
  res: import("node:http").ServerResponse,
  ctx: string,
  err: unknown,
): void {
  const id = randomUUID().slice(0, 8);
  const detail =
    err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  console.error(`[req:${id}] ${ctx} -> ${detail}`);
  if (res.headersSent) return;
  if (err instanceof Error && err.name === "ZodError") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message, request_id: id }));
    return;
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Internal server error", request_id: id }));
}

function parseBody(
  req: import("node:http").IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new RequestBodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const data = Buffer.concat(chunks).toString("utf8");
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function main() {
  await ensureSchema();

  interface SessionEntry {
    transport: StreamableHTTPServerTransport;
    lastUsedAt: number;
  }
  const sessions = new Map<string, SessionEntry>();

  const sessionGc = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) {
        sessions.delete(id);
        entry.transport.close().catch(() => {});
      }
    }
  }, SESSION_GC_INTERVAL_MS);
  sessionGc.unref?.();

  const httpServer = createServer(async (req, res) => {
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const url = new URL(req.url ?? "/", `http://${hostHeader || "localhost"}`);
    const origin = (req.headers.origin as string | undefined) ?? null;

    // DNS-rebinding defense: reject requests whose Host header is not in the
    // configured allowlist (loopback names + explicit dev hosts).
    if (!ALLOWED_HOSTS.has(hostHeader)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Host header not allowed" }));
      return;
    }

    // Cross-origin defense: if a browser sets Origin, it must be allowlisted.
    // Native MCP clients (Node fetch, curl) send no Origin and pass through.
    if (origin !== null && !ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Origin not allowed" }));
      return;
    }

    if (origin !== null) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      let body: unknown;
      try {
        body = await parseBody(req);
      } catch (err) {
        if (err instanceof RequestBodyTooLargeError) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      try {
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (existing) {
          existing.lastUsedAt = Date.now();
          await existing.transport.handleRequest(req, res, body);
          return;
        }

        if (sessionId && !existing) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }

        if (sessions.size >= MAX_SESSIONS) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session capacity reached" }));
          return;
        }

        // New session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, lastUsedAt: Date.now() });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        console.error("MCP error:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    if (url.pathname === "/context" && req.method === "GET") {
      const path = url.searchParams.get("path");
      if (!path) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "path parameter required" }));
        return;
      }
      try {
        const context = await resolveContext(path);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(context));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname === "/graph" && req.method === "GET") {
      try {
        const graph = await loadGraph();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(graph));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // List registered users, used by the Actors page to pick a user_id
    // when creating or editing a real (non-placeholder) person.
    if (url.pathname === "/users" && req.method === "GET") {
      try {
        const db = getDb();
        const rows = await db.execute(
          "SELECT id, email, name FROM users ORDER BY name",
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows.rows));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // List actors from the global (cross-organizational) registry,
    // filterable by type or placeholder status. Used by the Actors page
    // and by the OwnerPicker / AssigneePicker inside the node detail pane.
    if (url.pathname === "/actors" && req.method === "GET") {
      try {
        const db = getDb();
        const clauses: string[] = [];
        const values: (string | number)[] = [];
        const type = url.searchParams.get("type");
        if (type === "person" || type === "automation") {
          clauses.push("type = ?"); values.push(type);
        }
        const placeholder = url.searchParams.get("is_placeholder");
        if (placeholder === "1" || placeholder === "true") {
          clauses.push("is_placeholder = 1");
        } else if (placeholder === "0" || placeholder === "false") {
          clauses.push("is_placeholder = 0");
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = await db.execute({
          sql: `SELECT id, type, name, is_placeholder, user_id, notes, external_id
                FROM actors ${where} ORDER BY type, name`,
          args: values,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows.rows));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // --- Actors: POST / PATCH / DELETE ---
    // GET /actors is handled above. These mutations route through the
    // actors.ts pure functions, which handle Zod validation + audit logging.

    if (url.pathname === "/actors" && req.method === "POST") {
      try {
        const body = (await parseBody(req)) as Record<string, unknown> | undefined;
        if (!body || Object.keys(body).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body required" }));
          return;
        }
        const row = await createActor(getDb(), SOLO_USER, body as Parameters<typeof createActor>[2]);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(row));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/actors/") && req.method === "PATCH") {
      const actorId = decodeURIComponent(url.pathname.slice("/actors/".length));
      try {
        const body = (await parseBody(req)) as Record<string, unknown> | undefined;
        if (!body || Object.keys(body).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no fields to update" }));
          return;
        }
        const row = await updateActor(getDb(), SOLO_USER, {
          actor_id: actorId,
          ...(body as object),
        } as Parameters<typeof updateActor>[2]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(row));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/actors/") && req.method === "DELETE") {
      const actorId = decodeURIComponent(url.pathname.slice("/actors/".length));
      try {
        await archiveActor(getDb(), SOLO_USER, actorId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ archived: actorId }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // --- Responsibilities: CRUD + assignments ---

    // Match /responsibilities/:id/assignments[/:actorId] first so it doesn't
    // collide with the bare /responsibilities/:id handlers below.
    const respAssignMatch = url.pathname.match(
      /^\/responsibilities\/([^/]+)\/assignments(?:\/([^/]+))?$/,
    );
    if (respAssignMatch) {
      const respId = decodeURIComponent(respAssignMatch[1]);
      const actorIdFromPath = respAssignMatch[2]
        ? decodeURIComponent(respAssignMatch[2])
        : undefined;
      if (req.method === "POST" && !actorIdFromPath) {
        try {
          const body = (await parseBody(req)) as { actor_id?: string } | undefined;
          if (!body || !body.actor_id) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "actor_id required" }));
            return;
          }
          await assignResponsibility(getDb(), SOLO_USER, {
            responsibility_id: respId,
            actor_id: body.actor_id,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          respondError(res, `${req.method} ${url.pathname}`, err);
        }
        return;
      }
      if (req.method === "DELETE" && actorIdFromPath) {
        try {
          await unassignResponsibility(getDb(), SOLO_USER, {
            responsibility_id: respId,
            actor_id: actorIdFromPath,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          respondError(res, `${req.method} ${url.pathname}`, err);
        }
        return;
      }
    }

    if (url.pathname === "/responsibilities" && req.method === "GET") {
      try {
        const filters: { node_id?: string; actor_id?: string } = {};
        const nodeId = url.searchParams.get("node_id");
        const actorId = url.searchParams.get("actor_id");
        if (nodeId) filters.node_id = nodeId;
        if (actorId) filters.actor_id = actorId;
        const rows = await listResponsibilities(getDb(), filters);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname === "/responsibilities" && req.method === "POST") {
      try {
        const body = (await parseBody(req)) as Record<string, unknown> | undefined;
        if (!body || Object.keys(body).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body required" }));
          return;
        }
        const row = await createResponsibility(
          getDb(),
          SOLO_USER,
          body as Parameters<typeof createResponsibility>[2],
        );
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(row));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/responsibilities/") && req.method === "PATCH") {
      const respId = decodeURIComponent(url.pathname.slice("/responsibilities/".length));
      try {
        const body = (await parseBody(req)) as Record<string, unknown> | undefined;
        if (!body || Object.keys(body).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no fields to update" }));
          return;
        }
        const row = await updateResponsibility(getDb(), SOLO_USER, {
          responsibility_id: respId,
          ...(body as object),
        } as Parameters<typeof updateResponsibility>[2]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(row));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/responsibilities/") && req.method === "DELETE") {
      const respId = decodeURIComponent(url.pathname.slice("/responsibilities/".length));
      try {
        await deleteResponsibility(getDb(), SOLO_USER, respId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deleted: respId }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // --- Data sources: POST / DELETE / GET ---

    if (url.pathname === "/data-sources" && req.method === "GET") {
      const nodeId = url.searchParams.get("node_id");
      if (!nodeId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "node_id parameter required" }));
        return;
      }
      try {
        const rows = await listDataSources(getDb(), nodeId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname === "/data-sources" && req.method === "POST") {
      try {
        const body = (await parseBody(req)) as Record<string, unknown> | undefined;
        if (!body || Object.keys(body).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body required" }));
          return;
        }
        const row = await addDataSource(
          getDb(),
          SOLO_USER,
          body as Parameters<typeof addDataSource>[2],
        );
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(row));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/data-sources/") && req.method === "DELETE") {
      const dsId = decodeURIComponent(url.pathname.slice("/data-sources/".length));
      try {
        await removeDataSource(getDb(), SOLO_USER, dsId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deleted: dsId }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/data-sources/") && req.method === "PATCH") {
      const dsId = decodeURIComponent(url.pathname.slice("/data-sources/".length));
      try {
        const body = (await parseBody(req)) as Record<string, unknown> | undefined;
        if (!body || Object.keys(body).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no fields to update" }));
          return;
        }
        const row = await updateDataSource(
          getDb(),
          SOLO_USER,
          dsId,
          body as Parameters<typeof updateDataSource>[3],
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(row));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // --- Tools: POST / DELETE / GET ---

    if (url.pathname === "/tools" && req.method === "GET") {
      const nodeId = url.searchParams.get("node_id");
      if (!nodeId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "node_id parameter required" }));
        return;
      }
      try {
        const rows = await listTools(getDb(), nodeId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname === "/tools" && req.method === "POST") {
      try {
        const body = (await parseBody(req)) as Record<string, unknown> | undefined;
        if (!body || Object.keys(body).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body required" }));
          return;
        }
        const row = await addTool(getDb(), SOLO_USER, body as Parameters<typeof addTool>[2]);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(row));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/tools/") && req.method === "DELETE") {
      const toolId = decodeURIComponent(url.pathname.slice("/tools/".length));
      try {
        await removeTool(getDb(), SOLO_USER, toolId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deleted: toolId }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/tools/") && req.method === "PATCH") {
      const toolId = decodeURIComponent(url.pathname.slice("/tools/".length));
      try {
        const body = (await parseBody(req)) as Record<string, unknown> | undefined;
        if (!body || Object.keys(body).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no fields to update" }));
          return;
        }
        const row = await updateTool(
          getDb(),
          SOLO_USER,
          toolId,
          body as Parameters<typeof updateTool>[3],
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(row));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Per-node sync status. Wraps engine.statusScan so the UI can show a
    // class (clean / push / pull / conflict / orphan / native) per tracked
    // file. Discovery is disabled: untracked files are not listed in the
    // detail pane and discovery does costly remote-list calls.
    const syncStatusMatch = url.pathname.match(
      /^\/nodes\/([^/]+)\/sync-status$/,
    );
    if (syncStatusMatch && req.method === "GET") {
      const nodeId = decodeURIComponent(syncStatusMatch[1]);
      try {
        const result = await statusScan(getDb(), {
          userId: SOLO_USER,
          nodeId,
          includeDiscovery: false,
          // DB-only fast path: no fs.stat, no Drive .stat() calls. The
          // UI indicator is allowed to lag a real on-disk change until
          // the next storeFile/pullFile/sync writes file_state.
          fast: true,
        });
        // engine.statusScan tags deleted_local entries with class:"clean"
        // (legacy of the helper that stamps the cluster). Re-tag here from
        // the bucket the engine put them in, so the UI sees the real class.
        const tagged: Array<{
          file_id: string;
          sync_class: SyncStatusResponse["files"][number]["sync_class"];
          local_hash: string | null;
          remote_hash: string | null;
          last_synced_hash: string | null;
          local_path: string | null;
          remote_name: string | null;
          remote_path: string | null;
        }> = [];
        const push = (
          arr: typeof result.clean,
          cls: SyncStatusResponse["files"][number]["sync_class"],
        ) => {
          for (const e of arr) {
            tagged.push({
              file_id: e.file_id,
              sync_class: cls,
              local_hash: e.local_hash,
              remote_hash: e.remote_hash,
              last_synced_hash: e.last_synced_hash,
              local_path: e.local_path,
              remote_name: e.remote_name,
              remote_path: e.remote_path,
            });
          }
        };
        push(result.clean, "clean");
        push(result.push_candidates, "push");
        push(result.pull_candidates, "pull");
        push(result.conflicts, "conflict");
        push(result.orphan, "orphan");
        push(result.native, "native");
        push(result.deleted_local, "deleted_local");
        const payload: SyncStatusResponse = { files: tagged };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Per-node sync trigger. Re-runs statusScan and acts on it: push
    // candidates are uploaded via storeFile, pull candidates downloaded
    // via pullFile. Conflicts are surfaced but never auto-resolved --
    // the data-safety default ("Portuni never auto-merges") applies. The
    // sequential loop avoids racing on the per-device file_state cache.
    const syncRunMatch = url.pathname.match(/^\/nodes\/([^/]+)\/sync$/);
    if (syncRunMatch && req.method === "POST") {
      const nodeId = decodeURIComponent(syncRunMatch[1]);
      try {
        const db = getDb();
        const scan = await statusScan(db, {
          userId: SOLO_USER,
          nodeId,
          includeDiscovery: false,
        });
        const result: SyncRunResponse = {
          pushed: [],
          pulled: [],
          conflicts: [],
          errors: [],
          skipped: [],
        };
        for (const e of scan.push_candidates) {
          if (!e.local_path) {
            result.errors.push({
              file_id: e.file_id,
              filename: e.filename,
              error: "no local path -- node has no mirror on this device",
            });
            continue;
          }
          try {
            await storeFile(db, {
              userId: SOLO_USER,
              nodeId: e.node_id,
              localPath: e.local_path,
            });
            result.pushed.push({ file_id: e.file_id, filename: e.filename });
          } catch (err) {
            result.errors.push({
              file_id: e.file_id,
              filename: e.filename,
              error: String(err),
            });
          }
        }
        // pull_candidates: remote moved forward, local at last-synced.
        // deleted_local: local file is gone but remote + last_synced_hash
        // are intact -- pull restores it. Both go through pullFile.
        for (const e of [...scan.pull_candidates, ...scan.deleted_local]) {
          try {
            await pullFile(db, { userId: SOLO_USER, fileId: e.file_id });
            result.pulled.push({ file_id: e.file_id, filename: e.filename });
          } catch (err) {
            result.errors.push({
              file_id: e.file_id,
              filename: e.filename,
              error: String(err),
            });
          }
        }
        for (const e of scan.conflicts) {
          result.conflicts.push({ file_id: e.file_id, filename: e.filename });
        }
        for (const e of [...scan.clean, ...scan.orphan, ...scan.native]) {
          result.skipped.push({
            file_id: e.file_id,
            filename: e.filename,
            sync_class: e.class,
          });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname.startsWith("/nodes/") && req.method === "GET") {
      const nodeId = decodeURIComponent(url.pathname.slice("/nodes/".length));
      if (!nodeId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "node id required" }));
        return;
      }
      try {
        const node = await loadNodeDetail(nodeId);
        if (!node) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "node not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(node));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Update fields on an existing node. Routes through updateNodeInternal
    // so lifecycle/owner/goal validation + audit logging stay centralized in
    // the pure function.
    if (url.pathname.startsWith("/nodes/") && req.method === "PATCH") {
      const nodeId = decodeURIComponent(url.pathname.slice("/nodes/".length));
      try {
        const body = (await parseBody(req)) as
          | {
              name?: string;
              description?: string | null;
              goal?: string | null;
              lifecycle_state?: string | null;
              owner_id?: string | null;
              visibility?: string;
            }
          | undefined;
        if (!body) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body required" }));
          return;
        }
        const update: {
          node_id: string;
          name?: string;
          description?: string | null;
          goal?: string | null;
          lifecycle_state?: string | null;
          owner_id?: string | null;
          visibility?: (typeof NODE_VISIBILITIES)[number];
        } = { node_id: nodeId };
        if (typeof body.name === "string" && body.name.trim().length > 0) {
          update.name = body.name.trim();
        }
        if (body.description !== undefined) {
          update.description = body.description === null ? null : String(body.description);
        }
        if (body.goal !== undefined) {
          update.goal = body.goal === null ? null : String(body.goal);
        }
        if (body.lifecycle_state !== undefined) {
          update.lifecycle_state =
            body.lifecycle_state === null ? null : String(body.lifecycle_state);
        }
        if (body.owner_id !== undefined) {
          update.owner_id = body.owner_id === null ? null : String(body.owner_id);
        }
        if (body.visibility !== undefined) {
          if (!(NODE_VISIBILITIES as readonly string[]).includes(body.visibility)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `invalid visibility '${body.visibility}'. Valid: ${NODE_VISIBILITIES.join(", ")}`,
              }),
            );
            return;
          }
          update.visibility = body.visibility as (typeof NODE_VISIBILITIES)[number];
        }
        const hasUpdate =
          update.name !== undefined ||
          update.description !== undefined ||
          update.goal !== undefined ||
          update.lifecycle_state !== undefined ||
          update.owner_id !== undefined ||
          update.visibility !== undefined;
        if (!hasUpdate) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no fields to update" }));
          return;
        }
        await updateNodeInternal(getDb(), SOLO_USER, update);
        const node = await loadNodeDetail(nodeId);
        if (!node) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "node not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(node));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Batch-save persisted node positions. Called by the frontend after
    // layout settles and after the user drops a dragged node. Body shape:
    //   { updates: [{ id, x, y }, ...] }
    // No auth / no audit log -- positions are purely UI state and the MCP
    // tool layer never touches them.
    if (url.pathname === "/positions" && req.method === "POST") {
      try {
        const body = (await parseBody(req)) as
          | { updates?: Array<{ id?: string; x?: number; y?: number }> }
          | undefined;
        const updates = Array.isArray(body?.updates) ? body!.updates : [];
        if (updates.length === 0) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ updated: 0 }));
          return;
        }
        const db = getDb();
        let updated = 0;
        for (const entry of updates) {
          if (
            !entry ||
            typeof entry.id !== "string" ||
            typeof entry.x !== "number" ||
            typeof entry.y !== "number" ||
            !Number.isFinite(entry.x) ||
            !Number.isFinite(entry.y)
          ) {
            continue;
          }
          const result = await db.execute({
            sql: `UPDATE nodes SET pos_x = ?, pos_y = ?
                   WHERE id = ?`,
            args: [entry.x, entry.y, entry.id],
          });
          updated += result.rowsAffected;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ updated }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Create a new node.
    if (url.pathname === "/nodes" && req.method === "POST") {
      try {
        const body = (await parseBody(req)) as
          | { type?: string; name?: string; description?: string | null }
          | undefined;
        if (!body || !body.type || !body.name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "type and name required" }));
          return;
        }
        if (!(NODE_TYPES as readonly string[]).includes(body.type)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `invalid type; must be one of ${NODE_TYPES.join(", ")}`,
            }),
          );
          return;
        }
        const db = getDb();
        const id = ulid();
        const now = new Date().toISOString();
        const syncKey = await generateSyncKey(db, body.name.trim());
        await db.execute({
          sql: `INSERT INTO nodes (id, type, name, description, meta, status, visibility, sync_key, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            body.type,
            body.name.trim(),
            body.description ?? null,
            null,
            "active",
            "team",
            syncKey,
            SOLO_USER,
            now,
            now,
          ],
        });
        await logAudit(SOLO_USER, "create_node", "node", id, {
          type: body.type,
          name: body.name,
        });
        const node = await loadNodeDetail(id);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(node));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Delete a node (archive by setting status, NOT physical delete — edges
    // stay referable and audit history is preserved).
    if (url.pathname.startsWith("/nodes/") && req.method === "DELETE") {
      const nodeId = decodeURIComponent(url.pathname.slice("/nodes/".length));
      try {
        const db = getDb();
        const existing = await db.execute({
          sql: "SELECT id FROM nodes WHERE id = ?",
          args: [nodeId],
        });
        if (existing.rows.length === 0) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "node not found" }));
          return;
        }
        await db.execute({
          sql: "UPDATE nodes SET status = 'archived', updated_at = ? WHERE id = ?",
          args: [new Date().toISOString(), nodeId],
        });
        await logAudit(SOLO_USER, "archive_node", "node", nodeId, {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ archived: nodeId }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Create an edge.
    if (url.pathname === "/edges" && req.method === "POST") {
      try {
        const body = (await parseBody(req)) as
          | { source_id?: string; target_id?: string; relation?: string }
          | undefined;
        if (!body || !body.source_id || !body.target_id || !body.relation) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "source_id, target_id, relation required",
            }),
          );
          return;
        }
        if (!(EDGE_RELATIONS as readonly string[]).includes(body.relation)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `invalid relation; must be one of ${EDGE_RELATIONS.join(", ")}`,
            }),
          );
          return;
        }
        if (body.source_id === body.target_id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "source and target must differ" }));
          return;
        }
        const db = getDb();
        const check = await db.execute({
          sql: "SELECT id FROM nodes WHERE id IN (?, ?)",
          args: [body.source_id, body.target_id],
        });
        if (check.rows.length < 2) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "one or both nodes not found" }));
          return;
        }
        const dup = await db.execute({
          sql: "SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?",
          args: [body.source_id, body.target_id, body.relation],
        });
        if (dup.rows.length > 0) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: dup.rows[0].id,
              duplicate: true,
            }),
          );
          return;
        }
        const id = ulid();
        await db.execute({
          sql: `INSERT INTO edges (id, source_id, target_id, relation, meta, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            body.source_id,
            body.target_id,
            body.relation,
            null,
            SOLO_USER,
            new Date().toISOString(),
          ],
        });
        await logAudit(SOLO_USER, "connect", "edge", id, {
          source_id: body.source_id,
          target_id: body.target_id,
          relation: body.relation,
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            source_id: body.source_id,
            target_id: body.target_id,
            relation: body.relation,
          }),
        );
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Delete an edge by ID.
    if (url.pathname.startsWith("/edges/") && req.method === "DELETE") {
      const edgeId = decodeURIComponent(url.pathname.slice("/edges/".length));
      try {
        const db = getDb();
        const result = await db.execute({
          sql: "DELETE FROM edges WHERE id = ?",
          args: [edgeId],
        });
        if (result.rowsAffected === 0) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "edge not found" }));
          return;
        }
        await logAudit(SOLO_USER, "disconnect", "edge", edgeId, {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deleted: edgeId }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Create an event on a node.
    if (url.pathname === "/events" && req.method === "POST") {
      try {
        const body = (await parseBody(req)) as
          | { node_id?: string; type?: string; content?: string }
          | undefined;
        if (!body || !body.node_id || !body.type || !body.content) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "node_id, type, content required" }));
          return;
        }
        if (!(EVENT_TYPES as readonly string[]).includes(body.type)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `invalid type; must be one of ${EVENT_TYPES.join(", ")}`,
            }),
          );
          return;
        }
        const db = getDb();
        const nodeCheck = await db.execute({
          sql: "SELECT id FROM nodes WHERE id = ?",
          args: [body.node_id],
        });
        if (nodeCheck.rows.length === 0) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "node not found" }));
          return;
        }
        const id = ulid();
        const now = new Date().toISOString();
        await db.execute({
          sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [id, body.node_id, body.type, body.content, null, "active", null, null, SOLO_USER, now],
        });
        await logAudit(SOLO_USER, "log_event", "event", id, {
          node_id: body.node_id,
          type: body.type,
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id,
          node_id: body.node_id,
          type: body.type,
          content: body.content,
          status: "active",
          created_at: now,
        }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Update an event (content, type, or status).
    if (url.pathname.startsWith("/events/") && req.method === "PATCH") {
      const eventId = decodeURIComponent(url.pathname.slice("/events/".length));
      try {
        const body = (await parseBody(req)) as
          | { content?: string; type?: string; status?: string }
          | undefined;
        if (!body) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body required" }));
          return;
        }
        const db = getDb();
        const existing = await db.execute({
          sql: "SELECT id, status FROM events WHERE id = ?",
          args: [eventId],
        });
        if (existing.rows.length === 0) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "event not found" }));
          return;
        }
        const updates: string[] = [];
        const values: (string | null)[] = [];
        if (typeof body.content === "string" && body.content.trim().length > 0) {
          updates.push("content = ?");
          values.push(body.content.trim());
        }
        if (typeof body.type === "string") {
          if (!(EVENT_TYPES as readonly string[]).includes(body.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `invalid type; must be one of ${EVENT_TYPES.join(", ")}`,
              }),
            );
            return;
          }
          updates.push("type = ?");
          values.push(body.type);
        }
        if (typeof body.status === "string") {
          updates.push("status = ?");
          values.push(body.status);
        }
        if (updates.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no fields to update" }));
          return;
        }
        values.push(eventId);
        await db.execute({
          sql: `UPDATE events SET ${updates.join(", ")} WHERE id = ?`,
          args: values,
        });
        await logAudit(SOLO_USER, "update_event", "event", eventId, {
          fields: Object.keys(body),
        });
        const updated = await db.execute({
          sql: "SELECT id, type, content, status, created_at FROM events WHERE id = ?",
          args: [eventId],
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(updated.rows[0]));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    // Archive an event (soft delete).
    if (url.pathname.startsWith("/events/") && req.method === "DELETE") {
      const eventId = decodeURIComponent(url.pathname.slice("/events/".length));
      try {
        const db = getDb();
        const result = await db.execute({
          sql: "UPDATE events SET status = 'archived' WHERE id = ? AND status != 'archived'",
          args: [eventId],
        });
        if (result.rowsAffected === 0) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "event not found or already archived" }));
          return;
        }
        await logAudit(SOLO_USER, "archive_event", "event", eventId, {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ archived: eventId }));
      } catch (err) {
        respondError(res, `${req.method} ${url.pathname}`, err);
      }
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`Portuni MCP server listening on http://${HOST}:${PORT}`);
    console.log(`Streamable HTTP endpoint: http://${HOST}:${PORT}/mcp`);
  });

  process.on("SIGINT", () => {
    clearInterval(sessionGc);
    for (const entry of sessions.values()) {
      entry.transport.close().catch(() => {});
    }
    httpServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
