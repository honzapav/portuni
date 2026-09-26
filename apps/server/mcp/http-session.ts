// The request front half both MCP transports share: transport.ts (the
// server's own McpServer sessions) and agent-transport.ts (a team-workspace
// device proxying to the central server). Parsing the body, routing a
// request to a live session with user pinning, the capacity cap and the
// last-resort 500 are the same on both; what a new session is differs.

import type { IncomingMessage, ServerResponse } from "node:http";
import { parseBody, RequestBodyTooLargeError } from "../http/middleware.js";
import type { RequestIdentity } from "../auth/request-identity.js";

interface PinnedSessionEntry {
  transport: { handleRequest(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> };
  lastUsedAt: number;
  userId: string;
}

function writeJsonError(res: ServerResponse, status: number, error: string, code: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error, code }));
}

// The parsed JSON body, or `{ ok: false }` once a 413/400 has been written.
export async function parseMcpBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await parseBody(req) };
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      writeJsonError(res, 413, "Request body too large", "BODY_TOO_LARGE");
      return { ok: false };
    }
    writeJsonError(res, 400, "Invalid JSON body", "INVALID_JSON");
    return { ok: false };
  }
}

// Answers the request when it belongs to an existing session (routed to
// it, or refused: another user's session, an unknown session id) or when
// no new session fits. Returns false when the caller should open a new
// session; a throw from the session's own handleRequest propagates.
export async function routeToExistingSession(
  sessions: ReadonlyMap<string, PinnedSessionEntry>,
  maxSessions: number,
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  body: unknown,
): Promise<boolean> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    // Session pinning: reject cross-user session reuse.
    if (existing.userId !== identity.userId) {
      writeJsonError(res, 403, "Session belongs to a different user", "MCP_SESSION_FORBIDDEN");
      return true;
    }
    existing.lastUsedAt = Date.now();
    await existing.transport.handleRequest(req, res, body);
    return true;
  }

  if (sessionId && !existing) {
    writeJsonError(res, 404, "Session not found", "MCP_SESSION_NOT_FOUND");
    return true;
  }

  if (sessions.size >= maxSessions) {
    writeJsonError(res, 503, "Session capacity reached", "MCP_CAPACITY_REACHED");
    return true;
  }
  return false;
}

// The last-resort answer of a request that threw, unless one was already sent.
export function writeInternalError(res: ServerResponse): void {
  if (!res.headersSent) writeJsonError(res, 500, "Internal server error", "INTERNAL_ERROR");
}
