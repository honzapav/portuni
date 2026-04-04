import "varlock/auto-load";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ensureSchema } from "./schema.js";
import { registerNodeTools } from "./tools/nodes.js";
import { registerGetNodeTool } from "./tools/get-node.js";
import { registerEdgeTools } from "./tools/edges.js";

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  await ensureSchema();

  const mcpServer = new McpServer({
    name: "portuni",
    version: "0.1.0",
  });

  registerNodeTools(mcpServer);
  registerGetNodeTool(mcpServer);
  registerEdgeTools(mcpServer);

  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => { transports.delete(transport.sessionId); };
      await mcpServer.connect(transport);
      return;
    }

    if (url.pathname === "/messages" && req.method === "POST") {
      const sessionId = url.searchParams.get("sessionId");
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown session" }));
        return;
      }
      await transport.handlePostMessage(req, res);
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
    console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
