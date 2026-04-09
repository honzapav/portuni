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

import { getDb } from "./db.js";
import { SOLO_USER } from "./schema.js";
import { NodeSummaryRow } from "./types.js";

const PORT = Number(process.env.PORT ?? 3001);

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
