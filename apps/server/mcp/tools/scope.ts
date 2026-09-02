import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../../infra/db.js";
import { logAudit } from "../../infra/audit.js";
import {
  isEdgeReachable,
  loadNodeScopeMeta,
  seedScopeFromHome,
  violatesHardFloor,
} from "../scope.js";
import { nodeVisibleTo } from "../../auth/node-access.js";
import { getMirrorPath } from "../../domain/sync/mirror-registry.js";
import { writeHandoffAndSuspend } from "../../domain/session-handoff.js";
import type { SessionCtx } from "../server.js";

// portuni_session_init is the manual fallback for seeding the scope set.
// Auto-seed normally fires on connect when the MCP URL carries
// `?home_node_id=...` (every mirror's .mcp.json / .codex/config.toml gets
// this from `portuni_mirror`). This tool exists for clients connecting
// without the query param, programmatic re-init mid-session, or test
// harnesses. Idempotent: replaces the home node and re-seeds.
async function loadNodeIdFromMaybeName(
  args: { home_node_id?: string; home_node_name?: string },
): Promise<string | null> {
  if (args.home_node_id) return args.home_node_id;
  if (!args.home_node_name) return null;
  const db = getDb();
  const r = await db.execute({
    sql: "SELECT id FROM nodes WHERE name = ? COLLATE NOCASE",
    args: [args.home_node_name],
  });
  if (r.rows.length !== 1) return null;
  return r.rows[0].id as string;
}

export function registerScopeTools(server: McpServer, ctx: SessionCtx): void {
  const { scope } = ctx;
  server.tool(
    "portuni_session_init",
    "Manually initialize the read-scope set for this MCP session. Auto-seed normally runs on connect when the URL carries ?home_node_id=…; use this tool only when that is absent (legacy client, ad-hoc connection). Seeds the scope set with the home node and its depth-1 neighbors. Call without home_node_id when cwd is outside any mirror — the scope set stays empty and every read requires explicit expansion.",
    {
      home_node_id: z
        .string()
        .optional()
        .describe(
          "Node ID (ULID) whose local mirror contains the cwd. Provide this OR home_node_name; omit both if cwd is outside any mirror.",
        ),
      home_node_name: z
        .string()
        .optional()
        .describe("Alternative to home_node_id: case-insensitive node name."),
    },
    async (args) => {
      const db = getDb();
      const homeId = await loadNodeIdFromMaybeName(args);

      if (!homeId) {
        // cwd outside any mirror: scope stays empty.
        await logAudit(ctx.identity.userId, "session_init", "scope", "session", {
          home: null,
          session_type: scope.sessionType,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                home_node_id: null,
                session_type: scope.sessionType,
                scope_size: scope.size(),
                note: "No home node — every read requires explicit scope expansion.",
              }),
            },
          ],
        };
      }

      // Verify the node exists.
      const exists = await db.execute({
        sql: "SELECT id, name, type FROM nodes WHERE id = ?",
        args: [homeId],
      });
      if (exists.rows.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `Error: home node ${homeId} not found` },
          ],
          isError: true,
        };
      }

      const seedIds = await seedScopeFromHome(db, scope, homeId, ctx.identity);
      scope.recordExpansion({
        at: new Date().toISOString(),
        node_ids: seedIds,
        reason: "session_init seed (home + depth-1)",
        triggered_by: "init",
      });

      await logAudit(ctx.identity.userId, "session_init", "scope", homeId, {
        home: homeId,
        seeded: seedIds,
        session_type: scope.sessionType,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              home_node_id: homeId,
              home_node_name: exists.rows[0].name,
              home_node_type: exists.rows[0].type,
              session_type: scope.sessionType,
              scope_size: scope.size(),
              seeded: seedIds,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_expand_scope",
    "Add one or more nodes to the current MCP session's read-scope set. Required when a read tool returned {error: scope_expansion_required, ...}: surface the request to the user, get confirmation, then call this. reason: 'user-requested: <quoted prompt fragment>' when the user named the node in the prompt; 'user-confirmed-in-chat' after a chat confirmation. Each accepted node is classified server-side and returned in added_via: 'edge' when it was reachable via a graph edge from the current scope (most calls -- a plain read tool already auto-expands these without needing this tool), 'disconnected' when it was reached only via search/name with no edge path -- the classification is computed by the server, never taken from your reason text. Hard-floor nodes (visibility=private owned by another user, or meta.scope_sensitive=true) need confirmed_hard_floor=true backed by explicit user confirmation; headless sessions cannot override hard floors at all, confirmed_hard_floor is ignored. Pass writable: true to also grant WRITE access (not just read) to the accepted nodes — required before a mutating tool call on a node outside the write set (home node + session-created nodes); impossible for headless sessions, whose write set cannot expand mid-run. Every expansion is audited and surfaced in portuni_session_log. See portuni://scope-rules.",
    {
      node_ids: z
        .array(z.string())
        .min(1)
        .describe("Node IDs (ULIDs) to add to the scope set."),
      reason: z
        .string()
        .min(1)
        .describe(
          "Why scope is being expanded. Be honest about the trigger: 'user-requested: ...' for prompt-derived expansions, 'user-confirmed-in-chat' for chat confirmations.",
        ),
      triggered_by: z
        .enum(["user", "agent"])
        .optional()
        .default("user")
        .describe(
          "user (default) for prompt-named or chat-confirmed expansions; agent for the agent's own initiative (rare — most agent-initiated reaches go through elicitation).",
        ),
      confirmed_hard_floor: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Set to true only when the user has explicitly confirmed reaching a hard-floor node (visibility=private owned by another user, or meta.scope_sensitive=true) — without this flag, such nodes are refused even when reason claims user confirmation.",
        ),
      writable: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When true, also grant write access to the accepted node(s). Each node goes through a real MCP elicitation confirmation dialog with the user — reason alone is never enough. On a client without the elicitation capability the write grant is refused outright (no honor-system fallback for writes). Rejected outright for headless sessions — write-set expansion is not available mid-run for headless.",
        ),
    },
    async (args) => {
      const db = getDb();
      const headless = scope.sessionType === "headless";

      if (args.writable && headless) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "write_expansion_impossible",
                hint:
                  "Headless sessions cannot expand their write set mid-run. Writes are limited " +
                  "to the home node (and nodes created by this session) for the session's lifetime.",
              }),
            },
          ],
          isError: true,
        };
      }

      // Verify each node exists; classify by hard-floor status and accept
      // / refuse accordingly.
      const placeholders = args.node_ids.map(() => "?").join(",");
      const known = await db.execute({
        sql: `SELECT id FROM nodes WHERE id IN (${placeholders})`,
        args: args.node_ids,
      });
      const knownIds = new Set(known.rows.map((r) => r.id as string));

      const accepted: string[] = [];
      const addedVia: Record<string, "edge" | "disconnected"> = {};
      const rejected_unknown: string[] = [];
      const refused_hard_floor: { node_id: string; reason: string; permanent: boolean }[] = [];
      const refused_write: { node_id: string; reason: string }[] = [];

      for (const id of args.node_ids) {
        if (!knownIds.has(id)) {
          rejected_unknown.push(id);
          continue;
        }
        // Group-visibility gate: hidden nodes are treated identically to
        // nonexistent nodes. This prevents existence-oracle probing via
        // expand_scope.
        const visible = await nodeVisibleTo(db, ctx.identity, id);
        if (!visible) {
          rejected_unknown.push(id);
          continue;
        }
        const meta = await loadNodeScopeMeta(db, id);
        if (violatesHardFloor(meta, ctx.identity.userId)) {
          // Headless has no elicitation channel and no deferred-review path
          // for hard floors: always refused, confirmed_hard_floor cannot
          // override it (spec: "Hard floors ... always refused in headless").
          if (headless || !args.confirmed_hard_floor) {
            refused_hard_floor.push({
              node_id: id,
              reason: meta.scopeSensitive
                ? "meta.scope_sensitive=true"
                : "visibility=private and owner is another user",
              permanent: headless,
            });
            continue;
          }
        }
        // Classify the expansion the same way guardNodeRead does: reachable
        // from the current scope set (including nodes just accepted earlier
        // in this same call) is an "edge" traversal; otherwise it is a
        // "disconnected" jump -- the server stamps this regardless of what
        // the agent's `reason` claims.
        const reachable = scope.has(id) || (await isEdgeReachable(db, scope, id));
        addedVia[id] = reachable ? "edge" : "disconnected";
        if (args.writable) {
          // Write-set expansion happens ONLY via elicitation (spec: "Write
          // scope"). The declared `reason` string is not a substitute for a
          // real confirmation -- self-granting write from an honest-sounding
          // reason is exactly the honor-system hole this closes. A client
          // without the elicitation capability cannot fall back to the
          // pre-elicitation convention here the way reads do: it is refused
          // outright.
          const outcome = ctx.elicit
            ? await ctx.elicit.confirm(
                `Grant write access to node ${id}? Reason: ${args.reason}`,
              )
            : "unsupported";
          if (outcome !== "accept") {
            refused_write.push({
              node_id: id,
              reason:
                outcome === "unsupported"
                  ? "This client does not support MCP elicitation dialogs; write-scope expansion has no honor-system fallback."
                  : "The user declined the write-access confirmation dialog.",
            });
            continue;
          }
          scope.addWritable(id);
        } else {
          scope.add(id);
        }
        accepted.push(id);
      }

      if (accepted.length > 0) {
        scope.recordExpansion({
          at: new Date().toISOString(),
          node_ids: accepted,
          reason: args.reason,
          triggered_by: args.triggered_by,
        });
        await logAudit(ctx.identity.userId, "expand_scope", "scope", accepted.join(","), {
          node_ids: accepted,
          added_via: addedVia,
          writable: args.writable,
          reason: args.reason,
          triggered_by: args.triggered_by,
          confirmed_hard_floor: args.confirmed_hard_floor,
        });
      }
      if (refused_hard_floor.length > 0) {
        await logAudit(ctx.identity.userId, "scope_hard_floor_refusal", "scope", refused_hard_floor.map((r) => r.node_id).join(","), {
          refused: refused_hard_floor,
          reason: args.reason,
        });
      }
      if (refused_write.length > 0) {
        await logAudit(ctx.identity.userId, "scope_write_expansion_refused", "scope", refused_write.map((r) => r.node_id).join(","), {
          refused: refused_write,
          reason: args.reason,
        });
      }

      // Project accepted nodes into this session's hardlink projection
      // directory (domain/session-projection.ts) when they have a local
      // mirror on this device -- the Seatbelt sandbox already grants read
      // access to that directory (domain/sandbox-profile.ts), so the agent
      // can read them directly, not only via portuni_read_file.
      const projected: Record<string, string> = {};
      await Promise.all(
        accepted.map(async (id) => {
          const r = await ctx.projector.projectNode(id);
          if (r) projected[id] = r.dir;
        }),
      );

      const overridableRefusals = refused_hard_floor.some((r) => !r.permanent);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              added: accepted,
              added_via: addedVia,
              writable: args.writable ? accepted : [],
              unknown: rejected_unknown,
              refused_hard_floor,
              refused_write,
              scope_size: scope.size(),
              projected,
              hint: overridableRefusals
                ? "Re-call portuni_expand_scope with confirmed_hard_floor=true only after the user explicitly authorises the hard-floor node."
                : refused_write.length > 0
                  ? "Write-access grants require the user to accept a real elicitation dialog; see refused_write for why each node was not granted."
                  : accepted.length > 0
                    ? "Nodes listed in 'projected' are readable at that directory; nodes with no local mirror on this device have no entry there — read them with portuni_read_file (node_id + path)."
                    : undefined,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_session_log",
    "Return the current read-scope set, session type, and ordered expansion history for this MCP session. Use to inspect what the agent has looked at in this session.",
    {},
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              session_id: scope.sessionId,
              home_node_id: scope.homeNodeId,
              session_type: scope.sessionType,
              created_at: scope.createdAt,
              scope_size: scope.size(),
              scope: scope.list(),
              expansions: scope.expansions(),
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_session_suspend",
    "Suspend this session: writes the given handoff content to wip/sessions/<session-id>-handoff.md (a normal synced path, visible to the team), stores its hash and this session's agent-conversation id, and marks the session 'suspended' so it can be resumed later (respawned in the same mirror, continuing the conversation if it still exists or starting fresh from the handoff). Requires a home node -- interactive_chat sessions have no anchor to write into. Call this before the terminal closes: at the end of a task, or (for RALPH-style loops) between iterations. Can be called again on an already-suspended session to update the handoff with newer content.",
    {
      content: z.string().describe("Handoff markdown: what was done, what's next, anything the next session needs to pick up."),
      agent_session_id: z.string().optional().describe("The underlying CLI's own conversation id (e.g. Claude Code's session UUID), so a later resume can offer to continue the same conversation. Omit if unknown."),
    },
    async (args) => {
      if (!scope.sessionId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "session_not_ready",
                hint: "The session record has not finished initializing yet -- retry in a moment.",
              }),
            },
          ],
          isError: true,
        };
      }
      if (!scope.homeNodeId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: no home node -- this session has nothing to suspend a handoff into (interactive_chat has no anchor).",
            },
          ],
          isError: true,
        };
      }
      const mirrorRoot = await getMirrorPath(ctx.identity.userId, scope.homeNodeId);
      if (!mirrorRoot) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: no local mirror for the home node -- nothing to write the handoff into.",
            },
          ],
          isError: true,
        };
      }

      const result = await writeHandoffAndSuspend(
        getDb(),
        ctx.identity.userId,
        { id: scope.sessionId, nodeId: scope.homeNodeId, mirrorRoot },
        args.content,
        args.agent_session_id ?? null,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              session_id: result.session.id,
              state: result.session.state,
              handoff_path: result.handoffPath,
              handoff_hash: result.handoffHash,
            }),
          },
        ],
      };
    },
  );
}
