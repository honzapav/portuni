// HTTP composition root. Boots the Node http listener, wires the shared
// gates (host/origin/CORS/auth) once, and dispatches to either the MCP
// transport or the REST router.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createMcpTransport } from "../mcp/transport.js";
import { routeApiRequest } from "../api/router.js";
import {
  AUTH_ENABLED,
  applyGates,
  assertAuthRequiredIfNotLoopback,
  respondError,
} from "./middleware.js";
import { getOrCreateLimiter, rateLimitKey } from "./rate-limit.js";

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

  // PORTUNI_LOG_REQUESTS=1 enables a single-line access log per request.
  // Used for diagnosing desktop-mode CORS / auth / route problems where
  // the only visible failure is in the webview console.
  const requestLogging = process.env.PORTUNI_LOG_REQUESTS === "1";

  const httpServer = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      // Last-resort guard: an exception escaping the async handler would
      // otherwise become an unhandled rejection and kill the process.
      respondError(res, `${req.method} ${req.url}`, err);
    }
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = requestLogging ? Date.now() : 0;
    if (requestLogging) {
      res.on("finish", () => {
        const took = Date.now() - startedAt;
        console.error(
          `[req] ${req.method} ${req.url} origin=${req.headers.origin ?? "-"} host=${req.headers.host ?? "-"} -> ${res.statusCode} ${took}ms`,
        );
      });
    }

    // Rate limiting: checked before gates so we can short-circuit early.
    // /health is always exempt so uptime monitors are never blocked.
    const rawPath = (req.url ?? "/").split("?")[0];
    if (rawPath !== "/health") {
      const limiter = getOrCreateLimiter();
      const key = rateLimitKey(
        req.headers.authorization as string | undefined,
        req.socket.remoteAddress,
      );
      const result = limiter.check(key);
      if (!result.allowed) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(result.retryAfterSeconds),
        });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
    }

    const gate = await applyGates(req, res);
    if (gate === "handled") return;
    const identity = gate;

    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const url = new URL(req.url ?? "/", `http://${hostHeader || "localhost"}`);

    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      await mcp.handle(req, res, identity);
      return;
    }

    if (url.pathname === "/mcp/info" && req.method === "GET") {
      const address = httpServer.address();
      const boundPort =
        address && typeof address !== "string" ? address.port : port;
      // Read the env var directly rather than the AUTH_ENABLED constant:
      // tests (and any future runtime token rotation) need a live answer,
      // and the constant is captured at module import.
      const body = {
        url: `http://${host}:${boundPort}/mcp`,
        port: boundPort,
        has_auth_token: (process.env.PORTUNI_AUTH_TOKEN ?? "").trim().length > 0,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    const handled = await routeApiRequest(req, res, url, identity);
    if (!handled) {
      res.writeHead(404);
      res.end("Not found");
    }
  }

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
