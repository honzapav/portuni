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
import {
  bindExistingSessionPersistence,
  lookupSpawnSessionForBind,
  rehydrateConnectorWriteGrants,
  resumeSessionPersistence,
} from "./session-persistence.js";
import { spawnSessionIdFromHeader } from "../domain/sessions.js";
import { extractClientNameFromInitializeBody } from "./client-name.js";
import { logAudit } from "../infra/audit.js";
import { getDb } from "../infra/db.js";
import { closeSessionIfRunning } from "../domain/sessions.js";
import { disposeReadFileSpill } from "../domain/read-node-file.js";
import type { SessionRow } from "../shared/types.js";

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
  // Set right before a GC-forced close, read (and cleared) by onclose --
  // the only way to tell "the idle GC closed this transport" apart from
  // "the client disconnected on its own", since both paths end up calling
  // the same transport.onclose handler.
  const idleGcClosing = new Set<string>();

  const sessionGc = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastUsedAt < cutoff) {
        sessions.delete(id);
        idleGcClosing.add(id);
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
        res.end(JSON.stringify({ error: "Request body too large", code: "BODY_TOO_LARGE" }));
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body", code: "INVALID_JSON" }));
      return;
    }

    try {
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        // Session pinning: reject cross-user session reuse.
        if (existing.userId !== identity.userId) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session belongs to a different user", code: "MCP_SESSION_FORBIDDEN" }));
          return;
        }
        existing.lastUsedAt = Date.now();
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      if (sessionId && !existing) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found", code: "MCP_SESSION_NOT_FOUND" }));
        return;
      }

      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session capacity reached", code: "MCP_CAPACITY_REACHED" }));
        return;
      }

      // Parsed here (before createMcpServer) because session_type
      // derivation needs it: a headless-flagged device token is refused
      // below when it's absent, and interactive_task recognition depends
      // on its presence.
      const homeNodeId = parseHomeNodeIdFromUrl(req.url);

      // Resume (#204): a resumed run's MCP connection carries
      // ?resume_session_id= on the MCP URL.
      const resumeSessionId = parseResumeSessionIdFromUrl(req.url);

      // X-Portuni-Spawn-Id (#208 follow-up, runner batch Rule 2): the
      // session id a fresh run's own MCP connection carries so it binds to
      // the row session-runtime.ts already created instead of minting a
      // new one -- see bindSessionPersistence / lookupSpawnSessionForBind.
      // Only meaningful for a fresh (non-resume) connection; a resume
      // already reuses its own known id via resumeSessionPersistence below.
      // Validated as a ULID (spawnSessionIdFromHeader): a malformed header
      // is dropped, not trusted.
      const spawnSessionId = spawnSessionIdFromHeader(req.headers["x-portuni-spawn-id"]);

      // Headless connections without a task anchor are refused at seed
      // time — a headless session has no elicitation channel, so it must
      // arrive with its home node already known (see the session-type
      // table in docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md).
      if (identity.headless && !homeNodeId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "headless_session_requires_home_node", code: "MCP_HOME_NODE_REQUIRED",
            reason: "Headless device tokens must connect with ?home_node_id on the MCP URL.",
          }),
        );
        return;
      }

      // Rule 2 (runner-and-session-design spec, "The session exists before
      // the runner"): a fresh (non-resume) connection whose X-Portuni-Spawn-Id
      // names a row the session runtime already created BINDS to that row
      // instead of creating a second one under the same id -- checked before
      // createMcpServer even runs, same as the capacity/headless checks
      // above, since a refusal here must reject the whole connection. A row
      // that exists but is not running or not owned by this identity is
      // refused outright (SESSION_BIND_REFUSED): silently creating a fresh
      // session under the same spawn id would desync the task's own row from
      // the connection that was supposed to drive it. No row at all is the
      // ordinary case for a hand-opened CLI or any connection predating the
      // runner batch -- createMcpServer's own bindSession still creates one.
      let boundExistingSession: SessionRow | null = null;
      if (spawnSessionId && !resumeSessionId) {
        const lookup = await lookupSpawnSessionForBind(getDb(), identity, spawnSessionId);
        if (lookup.kind === "refused") {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "session is not accepting new connections",
              code: "SESSION_BIND_REFUSED",
              reason: "X-Portuni-Spawn-Id names a session that is not running or not owned by this identity",
            }),
          );
          return;
        }
        if (lookup.kind === "bindable") boundExistingSession = lookup.row;
      }

      // Generated here rather than inside the transport's own
      // sessionIdGenerator so this connection's read-file spill directory
      // can be keyed by it (#406) -- the tools need it from the first call,
      // which is well before onsessioninitialized fires.
      const transportSessionId = randomUUID();

      const { server, scope, bindSession } = createMcpServer(
        identity,
        homeNodeId,
        resumeSessionId,
        spawnSessionId,
        boundExistingSession?.id ?? null,
        transportSessionId,
      );

      if (boundExistingSession) {
        await bindExistingSessionPersistence(getDb(), scope, boundExistingSession);
      }

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
              error: "resume_session_unauthorized", code: "MCP_RESUME_REFUSED",
              reason:
                "resume_session_id is not a suspended session owned by this user and anchored to this node",
            }),
          );
          return;
        }
      }

      // Connector sessions (interactive_chat): restore the durable "created
      // by this user's chats" write grants before the first tool call --
      // see rehydrateConnectorWriteGrants. Best-effort: a failure leaves the
      // write set empty (the pre-existing behavior) and is logged, since
      // nothing a connector session reads depends on it.
      if (scope.sessionType === "interactive_chat") {
        try {
          const granted = await rehydrateConnectorWriteGrants(getDb(), scope, identity);
          if (granted.length > 0) {
            await logAudit(identity.userId, "connector_write_grants_rehydrated", "scope", granted.join(","), {
              node_ids: granted,
            });
          }
        } catch (err) {
          console.error("MCP connector write-grant rehydration failed:", err);
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
              error: "Portuni database unreachable; refusing to start session with empty scope", code: "MCP_SCOPE_UNAVAILABLE",
              reason,
            }),
          );
          return;
        }
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => transportSessionId,
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { transport, lastUsedAt: Date.now(), userId: identity.userId });
          // #272: only now -- a genuine initialize request has been
          // received and accepted for this session id -- is a durable
          // `sessions` row created. A no-op for a resumed connection
          // (its row already exists; see bindSession's doc in server.ts).
          bindSession(extractClientNameFromInitializeBody(body));
        },
      });

      transport.onclose = () => {
        const wasIdleGc = transport.sessionId ? idleGcClosing.delete(transport.sessionId) : false;
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
        // #406: whatever portuni_read_file spilled for THIS connection goes
        // with it. Keyed by the transport's own id, so a sibling connection
        // of the same durable session keeps its own files.
        void disposeReadFileSpill(transportSessionId);
        // GC backstop: a genuine client disconnect or a crash would
        // otherwise leave its session row stuck 'running' until the
        // 30-minute idle GC. closeSessionIfRunning (#329: suspends, not
        // closes) never touches 'suspended' -- an agent that called
        // portuni_session_suspend before disconnecting must stay resumable.
        if (scope.sessionId) {
          closeSessionIfRunning(getDb(), scope.sessionId, wasIdleGc ? "idle" : "disconnect").catch((err) => {
            console.error("closeSessionIfRunning on transport close failed:", err);
          });
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error", code: "INTERNAL_ERROR" }));
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
