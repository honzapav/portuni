// Streamable HTTP transport adapter for the MCP server. One transport
// (and McpServer) per session, kept in a sessions Map keyed by the MCP
// session id. A periodic GC closes idle sessions; SIGINT closes them all.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { parseBody, RequestBodyTooLargeError } from "../http/middleware.js";
import type { RequestIdentity } from "../auth/request-identity.js";
import { autoSeedFromHome, parseHomeNodeIdFromUrl, parseResumeSessionIdFromUrl } from "./auto-seed.js";
import { resumeSessionPersistence } from "./session-persistence.js";
import { disposeSessionProjection } from "./disk-projection.js";
import { logAudit } from "../infra/audit.js";
import { getDb } from "../infra/db.js";

const MAX_SESSIONS = Number(process.env.PORTUNI_MAX_SESSIONS ?? 100);
const SESSION_TTL_MS = Number(process.env.PORTUNI_SESSION_TTL_MS ?? 30 * 60 * 1000);
const SESSION_GC_INTERVAL_MS = Number(
  process.env.PORTUNI_SESSION_GC_INTERVAL_MS ?? 60 * 1000,
);

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
  userId: string;
}

export interface McpTransport {
  handle: (req: IncomingMessage, res: ServerResponse, identity: RequestIdentity) => Promise<void>;
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

  async function handle(req: IncomingMessage, res: ServerResponse, identity: RequestIdentity): Promise<void> {
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
        // Session pinning: reject cross-user session reuse.
        if (existing.userId !== identity.userId) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session belongs to a different user" }));
          return;
        }
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
          sessions.set(newSessionId, { transport, lastUsedAt: Date.now(), userId: identity.userId });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
        // Disk contract: the agent never manages its projection directory
        // (spec: "Disk contract") -- clean it up here, at session end.
        // `scope` is assigned by createMcpServer below; this closure only
        // runs after that call returns.
        disposeSessionProjection(scope, identity.userId);
      };

      // Parsed here (before createMcpServer) because session_type
      // derivation needs it: a headless-flagged device token is refused
      // below when it's absent, and interactive_task recognition depends
      // on its presence.
      const homeNodeId = parseHomeNodeIdFromUrl(req.url);

      // Resume (#204): the app respawns a terminal for a suspended session
      // with ?resume_session_id= on the MCP URL, same param name the
      // disk-plane sandbox-profile endpoints use for restart consolidation.
      const resumeSessionId = parseResumeSessionIdFromUrl(req.url);

      // X-Portuni-Profile: the spawn profile id (phase 3), sent only by
      // Claude Code connections whose per-mirror .mcp.json carries the
      // ${PORTUNI_PROFILE_ID:-} header expansion (buildClaudeMcpJson) --
      // absent/empty for every other CLI or a plain, profile-less spawn.
      const profileIdHeader = req.headers["x-portuni-profile"];
      const profileId =
        (Array.isArray(profileIdHeader) ? profileIdHeader[0] : profileIdHeader)?.trim() || null;

      // X-Portuni-Spawn-Id (#208 follow-up): the id the Seatbelt profile's
      // projection grant was already narrowed to at spawn time, sent the
      // same way X-Portuni-Profile is -- see bindSessionPersistence. Only
      // meaningful for a fresh (non-resume) connection; a resume already
      // reuses its own known id via resumeSessionPersistence below.
      const spawnIdHeader = req.headers["x-portuni-spawn-id"];
      const spawnSessionId =
        (Array.isArray(spawnIdHeader) ? spawnIdHeader[0] : spawnIdHeader)?.trim() || null;

      // Headless connections without a task anchor are refused at seed
      // time — a headless session has no elicitation channel, so it must
      // arrive with its home node already known (see the session-type
      // table in docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md).
      if (identity.headless && !homeNodeId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "headless_session_requires_home_node",
            reason: "Headless device tokens must connect with ?home_node_id on the MCP URL.",
          }),
        );
        return;
      }

      const { server, scope } = createMcpServer(
        identity,
        homeNodeId,
        profileId,
        resumeSessionId,
        spawnSessionId,
      );

      // Resume (#204): must be authorized and rehydrated before any tool
      // call is served, so it is awaited here -- before auto-seed and
      // before the connection is allowed to proceed -- rather than left to
      // createMcpServer's fire-and-forget bindSessionPersistence path.
      // A resumeSessionId that fails authorization (not owned by this user,
      // anchored to a different node, or not suspended -- see
      // domain/sessions.ts's loadResumableSession) is refused outright: a
      // silent fallback to a fresh session would look like a successful
      // resume to the agent while actually starting from empty scope.
      if (resumeSessionId) {
        const resumed = await resumeSessionPersistence(
          getDb(),
          scope,
          identity,
          resumeSessionId,
          homeNodeId,
        );
        if (!resumed) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "resume_session_unauthorized",
              reason:
                "resume_session_id is not a suspended session owned by this user and anchored to this node",
            }),
          );
          return;
        }
      }

      // Auto-seed scope from `?home_node_id=...` on the connection URL.
      // A successful resume above already set scope.homeNodeId, so this is
      // a no-op in that case (autoSeedFromHome's own guard).
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
      if (homeNodeId) {
        try {
          await autoSeedFromHome({
            scope,
            homeNodeId,
            db: getDb(),
            auditFn: (action, targetId, detail) =>
              logAudit(identity.userId, action, "node", targetId, detail),
            identity,
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
