// HTTP composition root. Boots the Node http listener, wires the shared
// gates (host/origin/CORS/auth) once, and dispatches to either the MCP
// transport or the REST router.

import { createServer, type Server } from "node:http";
import { createMcpTransport } from "../mcp/transport.js";
import { routeApiRequest } from "../api/router.js";
import {
  AUTH_ENABLED,
  applyGates,
  assertAuthRequiredIfNotLoopback,
} from "./middleware.js";

export interface HttpServerHandle {
  server: Server;
  shutdown: () => Promise<void>;
}

export interface StartHttpServerOptions {
  port?: number;
  host?: string;
  // Tests pass false so multiple ad-hoc servers don't leave orphan
  // SIGINT handlers behind in the same process.
  registerSigint?: boolean;
}

export function startHttpServer(opts: StartHttpServerOptions = {}): HttpServerHandle {
  const port = opts.port ?? Number(process.env.PORT ?? 4011);
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const registerSigint = opts.registerSigint ?? true;

  assertAuthRequiredIfNotLoopback(host);

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

  httpServer.listen(port, host, () => {
    console.log(`Portuni MCP server listening on http://${host}:${port}`);
    console.log(`Streamable HTTP endpoint: http://${host}:${port}/mcp`);
    console.log(
      AUTH_ENABLED
        ? "Auth: bearer token required (Authorization: Bearer <PORTUNI_AUTH_TOKEN>)"
        : "Auth: DISABLED (PORTUNI_AUTH_TOKEN unset). Loopback-only access trusted.",
    );
  });

  const shutdown = async (): Promise<void> => {
    mcp.shutdown();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  };

  if (registerSigint) {
    process.on("SIGINT", () => {
      shutdown().finally(() => process.exit(0));
    });
  }

  return { server: httpServer, shutdown };
}
