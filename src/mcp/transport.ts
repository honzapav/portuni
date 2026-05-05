// Streamable HTTP transport adapter for the MCP server. One transport
// (and McpServer) per session, kept in a sessions Map keyed by the MCP
// session id. A periodic GC closes idle sessions; SIGINT closes them all.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { parseBody, RequestBodyTooLargeError } from "../http/middleware.js";
import { autoSeedFromHome, parseHomeNodeIdFromUrl } from "./auto-seed.js";
import { logAudit } from "../infra/audit.js";
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";

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

      const { server, scope } = createMcpServer();

      // Auto-seed scope from `?home_node_id=...` on the connection URL.
      // This is what `portuni_mirror` writes into per-mirror configs so
      // every harness gets scope set up without needing to call
      // portuni_session_init explicitly.
      //
      // We deliberately reject the connection when seeding fails for
      // infrastructure reasons (DB unreachable, network hiccup). Letting
      // the connection succeed with an empty scope manifests downstream
      // as scope_expansion_required on every read — which the agent
      // typically surfaces to the user as "scope/session expired", a
      // diagnostic dead-end. A 503 with the underlying reason lets the
      // MCP client retry and the user see what's actually wrong.
      // Mirrors the pre-flight DB ping pattern in src/desktop.ts.
      const homeNodeId = parseHomeNodeIdFromUrl(req.url);
      if (homeNodeId) {
        try {
          await autoSeedFromHome({
            scope,
            homeNodeId,
            db: getDb(),
            auditFn: (action, targetId, detail) =>
              logAudit(SOLO_USER, action, "node", targetId, detail),
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.error("MCP auto-seed failed:", err);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Portuni database unreachable; refusing to start session with empty scope",
              reason,
            }),
          );
          return;
        }
      }

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
