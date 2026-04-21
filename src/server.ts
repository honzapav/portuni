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
  removeDataSource,
  listDataSources,
  addTool,
  removeTool,
  listTools,
} from "./tools/entity-attributes.js";
import { updateNodeInternal } from "./tools/nodes.js";

import { getDb } from "./db.js";
import { SOLO_USER, NODE_TYPES, EDGE_RELATIONS, EVENT_TYPES } from "./schema.js";
import { NodeRow, NodeSummaryRow } from "./types.js";
import type { GraphPayload, NodeDetail } from "./api-types.js";
import { ulid } from "ulid";
import { logAudit } from "./audit.js";

const PORT = Number(process.env.PORT ?? 4011);

async function loadGraph(): Promise<GraphPayload> {
  const db = getDb();

  const nodesRes = await db.execute({
    sql: `SELECT id, type, name, description, status, lifecycle_state, pos_x, pos_y
          FROM nodes
          WHERE status = 'active'
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

  const fileRes = await db.execute({
    sql: `SELECT id, filename, status, description, local_path, mime_type
          FROM files WHERE node_id = ? ORDER BY created_at DESC`,
    args: [row.id],
  });
  const files = fileRes.rows.map((f) => ({
    id: f.id as string,
    filename: f.filename as string,
    status: f.status as string,
    description: (f.description as string | null) ?? null,
    local_path: (f.local_path as string | null) ?? null,
    mime_type: (f.mime_type as string | null) ?? null,
  }));

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

  const mirrorRes = await db.execute({
    sql: `SELECT local_path, registered_at
          FROM local_mirrors WHERE user_id = ? AND node_id = ?`,
    args: [SOLO_USER, row.id],
  });
  const local_mirror =
    mirrorRes.rows.length > 0
      ? {
          local_path: mirrorRes.rows[0].local_path as string,
          registered_at: mirrorRes.rows[0].registered_at as string,
        }
      : null;

  // Owner
  const ownerRow = row.owner_id
    ? (await db.execute({ sql: "SELECT id, name FROM actors WHERE id = ?", args: [row.owner_id] })).rows[0]
    : null;
  const owner = ownerRow ? { id: ownerRow.id as string, name: ownerRow.name as string } : null;

  // Responsibilities with assignees
  const respRes = await db.execute({
    sql: "SELECT id, title, description, sort_order FROM responsibilities WHERE node_id = ? ORDER BY sort_order, title",
    args: [row.id],
  });
  const responsibilities = [];
  for (const r of respRes.rows) {
    const as = await db.execute({
      sql: `SELECT a.id, a.name, a.type FROM actors a
            JOIN responsibility_assignments ra ON ra.actor_id = a.id
            WHERE ra.responsibility_id = ?
            ORDER BY a.name`,
      args: [r.id as string],
    });
    responsibilities.push({
      id: r.id as string,
      title: r.title as string,
      description: (r.description as string | null) ?? null,
      sort_order: (r.sort_order as number) ?? 0,
      assignees: as.rows.map((x) => ({
        id: x.id as string,
        name: x.name as string,
        type: x.type as string,
      })),
    });
  }

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

  // Find node whose local_path matches or is a parent of the given path
  const mirrors = await db.execute({
    sql: "SELECT node_id, local_path FROM local_mirrors WHERE user_id = ? ORDER BY length(local_path) DESC",
    args: [SOLO_USER],
  });

  let nodeId: string | null = null;
  let mirrorPath: string | null = null;
  for (const row of mirrors.rows) {
    const lp = row.local_path as string;
    if (path === lp || path.startsWith(lp + "/")) {
      nodeId = row.node_id as string;
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

  // Get local mirrors for related nodes
  const relatedIds = edges.rows.map((r) => r.related_id as string);
  let relatedMirrors: Record<string, string> = {};
  if (relatedIds.length > 0) {
    const ph = relatedIds.map(() => "?").join(",");
    const mr = await db.execute({
      sql: `SELECT node_id, local_path FROM local_mirrors WHERE user_id = ? AND node_id IN (${ph})`,
      args: [SOLO_USER, ...relatedIds],
    });
    for (const row of mr.rows) {
      relatedMirrors[row.node_id as string] = row.local_path as string;
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
  registerEventTools(server);
  registerActorTools(server);
  registerResponsibilityTools(server);
  registerEntityAttributeTools(server);
  return server;
}

function parseBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk; });
    req.on("end", () => {
      try {
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

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
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

      const body = await parseBody(req);

      try {
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          await transport.handleRequest(req, res, body);
          return;
        }

        if (sessionId && !sessions.has(sessionId)) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }

        // New session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, transport);
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === "/graph" && req.method === "GET") {
      try {
        const graph = await loadGraph();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(graph));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
          sql: `SELECT id, type, name, description, is_placeholder, user_id, notes, external_id
                FROM actors ${where} ORDER BY type, name`,
          args: values,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rows.rows));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
          const e = err as Error;
          const status = e?.name === "ZodError" ? 400 : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
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
          const e = err as Error;
          const status = e?.name === "ZodError" ? 400 : 500;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        const hasUpdate =
          update.name !== undefined ||
          update.description !== undefined ||
          update.goal !== undefined ||
          update.lifecycle_state !== undefined ||
          update.owner_id !== undefined;
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
        const e = err as Error;
        const status = e?.name === "ZodError" ? 400 : 500;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        await db.execute({
          sql: `INSERT INTO nodes (id, type, name, description, meta, status, visibility, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            body.type,
            body.name.trim(),
            body.description ?? null,
            null,
            "active",
            "team",
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
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

  httpServer.listen(PORT, () => {
    console.log(`Portuni MCP server listening on http://localhost:${PORT}`);
    console.log(`Streamable HTTP endpoint: http://localhost:${PORT}/mcp`);
  });

  process.on("SIGINT", () => {
    for (const transport of sessions.values()) {
      transport.close().catch(() => {});
    }
    httpServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
