// HTTP composition root. Boots the Node http listener, wires the shared
// gates (host/origin/CORS/auth) once, and dispatches to either the MCP
// transport or the REST router.

import { createServer } from "node:http";
import { createMcpTransport } from "../mcp/transport.js";
import { routeApiRequest } from "../api/router.js";
import {
  AUTH_ENABLED,
  applyGates,
  assertAuthRequiredIfNotLoopback,
} from "./middleware.js";

const PORT = Number(process.env.PORT ?? 4011);
const HOST = process.env.HOST ?? "127.0.0.1";

export function startHttpServer(): void {
  assertAuthRequiredIfNotLoopback(HOST);

  const mcp = createMcpTransport();

  const httpServer = createServer(async (req, res) => {
    if (applyGates(req, res)) return;

    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const url = new URL(req.url ?? "/", `http://${hostHeader || "localhost"}`);

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      await mcp.handle(req, res);
      return;
    }

    const handled = await routeApiRequest(req, res, url);
    if (!handled) {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.log(`Portuni MCP server listening on http://${HOST}:${PORT}`);
    console.log(`Streamable HTTP endpoint: http://${HOST}:${PORT}/mcp`);
    console.log(
      AUTH_ENABLED
        ? "Auth: bearer token required (Authorization: Bearer <PORTUNI_AUTH_TOKEN>)"
        : "Auth: DISABLED (PORTUNI_AUTH_TOKEN unset). Loopback-only access trusted.",
    );
  });

  process.on("SIGINT", () => {
    mcp.shutdown();
    httpServer.close();
    process.exit(0);
  });
}
