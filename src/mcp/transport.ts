// Streamable HTTP transport adapter for the MCP server. One transport
// (and McpServer) per session, kept in a sessions Map keyed by the MCP
// session id. A periodic GC closes idle sessions; SIGINT closes them all.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { parseBody, RequestBodyTooLargeError } from "../http/middleware.js";

const MAX_SESSIONS = Number(process.env.PORTUNI_MAX_SESSIONS ?? 100);
const SESSION_TTL_MS = Number(process.env.PORTUNI_SESSION_TTL_MS ?? 30 * 60 * 1000);
const SESSION_GC_INTERVAL_MS = Number(
  process.env.PORTUNI_SESSION_GC_INTERVAL_MS ?? 60 * 1000,
);

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
}

export interface McpTransport {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  shutdown: () => void;
}

export function createMcpTransport(): McpTransport {
  const sessions = new Map<string, SessionEntry>();

  const sessionGc = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) {
        sessions.delete(id);
        entry.transport.close().catch(() => undefined);
      }
    }
  }, SESSION_GC_INTERVAL_MS);
  sessionGc.unref?.();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

      const { server } = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  }

  function shutdown(): void {
    clearInterval(sessionGc);
    for (const entry of sessions.values()) {
      entry.transport.close().catch(() => undefined);
    }
  }

  return { handle, shutdown };
}
