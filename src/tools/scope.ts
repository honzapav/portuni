import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";
import { SOLO_USER } from "../schema.js";
import { logAudit } from "../audit.js";
import {
  loadNodeScopeMeta,
  type SessionScope,
  seedScopeFromHome,
  violatesHardFloor,
} from "../scope.js";

// portuni_session_init is called by the SessionStart hook with the home node
// id (the node whose mirror contains the cwd). Seeds the scope set with the
// home node + its depth-1 neighbors so the agent can immediately read what is
// directly relevant. Calling without home_node_id is allowed (cwd outside any
// mirror) — the scope set stays empty and every read requires expansion.
//
// Idempotent: calling a second time replaces the home node + re-seeds. This
// makes the hook robust against retries.
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

export function registerScopeTools(server: McpServer, scope: SessionScope): void {
  server.tool(
    "portuni_session_init",
    "Initialize the read-scope set for this MCP session. Called by the SessionStart hook with the home node (the node whose local mirror contains the current working directory). Seeds the scope set with the home node and its depth-1 neighbors. Call without home_node_id when cwd is outside any mirror — the scope set stays empty and every read requires explicit expansion.",
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
        await logAudit(SOLO_USER, "session_init", "scope", "session", {
          home: null,
          mode: scope.mode,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                home_node_id: null,
                mode: scope.mode,
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

      const seedIds = await seedScopeFromHome(db, scope, homeId);
      scope.recordExpansion({
        at: new Date().toISOString(),
        node_ids: seedIds,
        reason: "session_init seed (home + depth-1)",
        triggered_by: "init",
      });

      await logAudit(SOLO_USER, "session_init", "scope", homeId, {
        home: homeId,
        seeded: seedIds,
        mode: scope.mode,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              home_node_id: homeId,
              home_node_name: exists.rows[0].name,
              home_node_type: exists.rows[0].type,
              mode: scope.mode,
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
    "Add one or more nodes to the current MCP session's read-scope set. Required when a read tool returned {error: scope_expansion_required, ...}: surface the request to the user, get confirmation, then call this. reason: 'user-requested: <quoted prompt fragment>' when the user named the node in the prompt; 'user-confirmed-in-chat' after a chat confirmation. Hard-floor nodes (visibility=private owned by another user, or meta.scope_sensitive=true) require confirmed_hard_floor=true backed by an explicit user confirmation -- never set this on agent initiative. Every expansion is audited and surfaced in portuni_session_log. See portuni://scope-rules.",
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
          "Set to true ONLY when the user has explicitly confirmed reaching a hard-floor node (visibility=private owned by another user, or meta.scope_sensitive=true). Without this flag, hard-floor nodes are refused even when reason claims user confirmation.",
        ),
    },
    async (args) => {
      const db = getDb();

      // Verify each node exists; classify by hard-floor status and accept
      // / refuse accordingly.
      const placeholders = args.node_ids.map(() => "?").join(",");
      const known = await db.execute({
        sql: `SELECT id FROM nodes WHERE id IN (${placeholders})`,
        args: args.node_ids,
      });
      const knownIds = new Set(known.rows.map((r) => r.id as string));

      const accepted: string[] = [];
      const rejected_unknown: string[] = [];
      const refused_hard_floor: { node_id: string; reason: string }[] = [];

      for (const id of args.node_ids) {
        if (!knownIds.has(id)) {
          rejected_unknown.push(id);
          continue;
        }
        const meta = await loadNodeScopeMeta(db, id);
        if (violatesHardFloor(meta, SOLO_USER) && !args.confirmed_hard_floor) {
          refused_hard_floor.push({
            node_id: id,
            reason: meta.scopeSensitive
              ? "meta.scope_sensitive=true"
              : "visibility=private and owner is another user",
          });
          continue;
        }
        scope.add(id);
        accepted.push(id);
      }

      if (accepted.length > 0) {
        scope.recordExpansion({
          at: new Date().toISOString(),
          node_ids: accepted,
          reason: args.reason,
          triggered_by: args.triggered_by,
        });
        await logAudit(SOLO_USER, "expand_scope", "scope", accepted.join(","), {
          node_ids: accepted,
          reason: args.reason,
          triggered_by: args.triggered_by,
          confirmed_hard_floor: args.confirmed_hard_floor,
        });
      }
      if (refused_hard_floor.length > 0) {
        await logAudit(SOLO_USER, "scope_hard_floor_refusal", "scope", refused_hard_floor.map((r) => r.node_id).join(","), {
          refused: refused_hard_floor,
          reason: args.reason,
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              added: accepted,
              unknown: rejected_unknown,
              refused_hard_floor,
              scope_size: scope.size(),
              hint: refused_hard_floor.length > 0
                ? "Re-call portuni_expand_scope with confirmed_hard_floor=true ONLY after the user explicitly authorises the hard-floor node."
                : undefined,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_session_log",
    "Return the current read-scope set, scope mode, and ordered expansion history for this MCP session. Useful both for the user (\"what did the agent look at?\") and for retrospective review of an autonomous run.",
    {},
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              home_node_id: scope.homeNodeId,
              mode: scope.mode,
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
}
