import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "../../infra/db.js";
import { logAudit } from "../../infra/audit.js";
import { SOLO_USER, EVENT_TYPES, EVENT_STATUSES } from "../../infra/schema.js";
import { EventRow } from "../../shared/types.js";
import type { InValue } from "@libsql/client";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionScope } from "../scope.js";
import { guardListScope } from "../list-scope-gate.js";

export function registerEventTools(server: McpServer, scope: SessionScope): void {
  server.tool(
    "portuni_log",
    "Log a time-ordered knowledge event to a node. ONLY log events that capture substantive knowledge: real decisions, discoveries, blockers, milestones. NEVER log technical operations (mirror moves, file renames, tool actions) or narrate what you just did. Events are organizational memory, not an activity log.",
    {
      node_id: z.string().describe("Node ID (ULID) to attach the event to"),
      type: z.enum(EVENT_TYPES).describe("Event type: decision, discovery, blocker, reference, milestone, note, or change"),
      content: z.string().describe("Event content / description"),
      meta: z.record(z.string(), z.unknown()).optional().describe("Optional structured metadata"),
      refs: z.array(z.string()).optional().describe("Optional array of reference IDs (other events, external)"),
      task_ref: z.string().optional().describe("Optional task reference (e.g. TASK-42)"),
    },
    async (args) => {
      const db = getDb();

      // Verify node exists
      const nodeCheck = await db.execute({
        sql: "SELECT id FROM nodes WHERE id = ?",
        args: [args.node_id],
      });
      if (nodeCheck.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: node ${args.node_id} not found` }],
          isError: true,
        };
      }

      // B5: Validate refs -- warn (not error) if any referenced event is missing.
      let refsWarning: string | null = null;
      if (args.refs && args.refs.length > 0) {
        const ph = args.refs.map(() => "?").join(",");
        const found = await db.execute({
          sql: `SELECT id FROM events WHERE id IN (${ph})`,
          args: args.refs,
        });
        const foundIds = new Set(found.rows.map((r) => r.id as string));
        const missing = args.refs.filter((r) => !foundIds.has(r));
        if (missing.length > 0) {
          refsWarning = `Warning: ${missing.length} referenced event(s) not found: ${missing.join(", ")}. Orphan refs may occur from deleted events.`;
        }
      }

      const id = ulid();
      const now = new Date().toISOString();

      await db.execute({
        sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          args.node_id,
          args.type,
          args.content,
          args.meta ? JSON.stringify(args.meta) : null,
          "active",
          args.refs ? JSON.stringify(args.refs) : null,
          args.task_ref ?? null,
          SOLO_USER,
          now,
        ],
      });

      await logAudit(SOLO_USER, "log_event", "event", id, {
        node_id: args.node_id,
        type: args.type,
      });

      const result: Record<string, unknown> = {
        id,
        node_id: args.node_id,
        type: args.type,
        status: "active",
      };
      if (refsWarning) result.warning = refsWarning;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_resolve",
    "Resolve an active event (e.g. close an issue, confirm a decision). Merges optional resolution text into event meta.",
    {
      event_id: z.string().describe("Event ID (ULID) to resolve"),
      resolution: z.string().optional().describe("Optional resolution text"),
    },
    async (args) => {
      const db = getDb();

      const existing = await db.execute({
        sql: "SELECT * FROM events WHERE id = ?",
        args: [args.event_id],
      });
      if (existing.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: event ${args.event_id} not found` }],
          isError: true,
        };
      }

      const row = EventRow.parse(existing.rows[0]);
      if (row.status !== "active") {
        return {
          content: [{ type: "text" as const, text: `Error: event ${args.event_id} is not active (status: ${row.status})` }],
          isError: true,
        };
      }

      // Merge resolution into existing meta
      const existingMeta = row.meta ? JSON.parse(row.meta) : {};
      if (args.resolution !== undefined) {
        existingMeta.resolution = args.resolution;
      }

      await db.execute({
        sql: "UPDATE events SET status = ?, meta = ? WHERE id = ?",
        args: ["resolved", JSON.stringify(existingMeta), args.event_id],
      });

      await logAudit(SOLO_USER, "resolve_event", "event", args.event_id, {
        resolution: args.resolution ?? null,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id: args.event_id, status: "resolved" }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_supersede",
    "Replace an event with a new version. The old event is marked as superseded and the new one references it.",
    {
      event_id: z.string().describe("Event ID (ULID) to supersede"),
      new_content: z.string().describe("Content for the replacement event"),
      meta: z.record(z.string(), z.unknown()).optional().describe("Optional new metadata (replaces old meta if provided)"),
    },
    async (args) => {
      const db = getDb();

      const existing = await db.execute({
        sql: "SELECT * FROM events WHERE id = ?",
        args: [args.event_id],
      });
      if (existing.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: event ${args.event_id} not found` }],
          isError: true,
        };
      }

      const oldRow = EventRow.parse(existing.rows[0]);

      // Mark old event as superseded
      await db.execute({
        sql: "UPDATE events SET status = ? WHERE id = ?",
        args: ["superseded", args.event_id],
      });

      // Create new event
      const newId = ulid();
      const now = new Date().toISOString();
      const newMeta = args.meta ? JSON.stringify(args.meta) : oldRow.meta;

      await db.execute({
        sql: `INSERT INTO events (id, node_id, type, content, meta, status, refs, task_ref, created_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId,
          oldRow.node_id,
          oldRow.type,
          args.new_content,
          newMeta,
          "active",
          JSON.stringify([args.event_id]),
          oldRow.task_ref,
          SOLO_USER,
          now,
        ],
      });

      await logAudit(SOLO_USER, "supersede_event", "event", newId, {
        superseded_id: args.event_id,
        node_id: oldRow.node_id,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              new_id: newId,
              superseded_id: args.event_id,
              node_id: oldRow.node_id,
              status: "active",
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "portuni_list_events",
    "List events from the knowledge graph, optionally filtered by node, type, status, or time range. Returns up to 100 events by default (newest first); pass `limit` to override. Subject to session scope: with node_id the node must be in scope; without node_id the call is treated as a global query (strict refuses, balanced first-time refuses, permissive auto-allow + audit).",
    {
      node_id: z.string().optional().describe("Filter by node ID"),
      type: z.enum(EVENT_TYPES).optional().describe("Filter by event type"),
      status: z.enum(EVENT_STATUSES).optional().describe("Filter by status (active, resolved, superseded, archived)"),
      since: z.string().optional().describe("Filter events created after this ISO datetime"),
      limit: z.number().int().min(1).max(500).optional().describe("Max rows to return (default 100, hard cap 500)"),
    },
    async (args) => {
      const db = getDb();

      const gate = await guardListScope(
        db,
        scope,
        args.node_id,
        "portuni_list_events",
        "list_events",
        {
          type: args.type ?? null,
          status: args.status ?? null,
          since: args.since ?? null,
        },
      );
      if (gate.kind === "error") return gate.response;

      const conditions: string[] = [];
      const values: InValue[] = [];

      if (args.node_id !== undefined) {
        conditions.push("e.node_id = ?");
        values.push(args.node_id);
      } else {
        // No node filter: when not yet permissive-mode auto-allowed, restrict
        // to the in-memory scope set so unrelated nodes aren't surfaced as
        // a side channel through cross-cutting filters.
        const inScope = scope.list();
        if (scope.mode !== "permissive") {
          if (inScope.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify([], null, 2) }],
            };
          }
          const placeholders = inScope.map(() => "?").join(",");
          conditions.push(`e.node_id IN (${placeholders})`);
          values.push(...inScope);
        }
      }
      if (args.type !== undefined) {
        conditions.push("e.type = ?");
        values.push(args.type);
      }
      if (args.status !== undefined) {
        conditions.push("e.status = ?");
        values.push(args.status);
      }
      if (args.since !== undefined) {
        conditions.push("e.created_at >= ?");
        values.push(args.since);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = args.limit ?? 100;

      const result = await db.execute({
        sql: `SELECT e.id, e.node_id, n.name as node_name, e.type, e.content, e.meta, e.status, e.refs, e.task_ref, e.created_at
              FROM events e
              JOIN nodes n ON e.node_id = n.id
              ${where}
              ORDER BY e.created_at DESC
              LIMIT ?`,
        args: [...values, limit],
      });

      const events = result.rows.map((row) => ({
        id: row.id,
        node_id: row.node_id,
        node_name: row.node_name,
        type: row.type,
        content: row.content,
        meta: row.meta ? JSON.parse(row.meta as string) : null,
        status: row.status,
        refs: row.refs ? JSON.parse(row.refs as string) : null,
        task_ref: row.task_ref,
        created_at: row.created_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(events, null, 2),
          },
        ],
      };
    },
  );
}
