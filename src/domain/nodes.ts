// Domain: node CRUD over the POPP graph.
//
// Pure functions over a libsql Client. Validation, lifecycle/status derivation,
// and the organization invariant live here. Both REST (src/api/nodes.ts) and
// MCP (src/mcp/tools/nodes.ts) call into these.

import { z } from "zod";
import { ulid } from "ulid";
import type { Client, InValue } from "@libsql/client";
import {
  NODE_TYPES,
  NODE_STATUSES,
  NODE_VISIBILITIES,
} from "../infra/schema.js";
import { generateSyncKey } from "./sync/sync-key.js";
import { unregisterMirror } from "./sync/mirror-registry.js";
import { getLifecycleStatesForType } from "../shared/popp.js";
import type { NodeType } from "../shared/popp.js";
import { writeAudit } from "../infra/audit.js";

// Cleanup hook for node purge: removes the per-device local mirror row for
// the node being purged. Best-effort -- never fails on local cleanup errors.
// Other devices clean up their stale mirror rows lazily.
//
// _db is unused today (the per-device sync.db is reached via PORTUNI_WORKSPACE_ROOT)
// but kept in the signature for future-proofing.
export async function purgeNodeLocalCleanup(
  _db: Client,
  userId: string,
  nodeId: string,
): Promise<void> {
  try {
    await unregisterMirror(userId, nodeId);
  } catch {
    /* best-effort -- never fail the tool on local cleanup errors */
  }
}

const CreateNodeInput = z.object({
  type: z.enum(NODE_TYPES),
  name: z.string(),
  description: z.string().optional(),
  organization_id: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(NODE_STATUSES).optional(),
  visibility: z.enum(NODE_VISIBILITIES).optional(),
  goal: z.string().optional(),
  lifecycle_state: z.string().optional(),
});
type CreateNodeInput = z.infer<typeof CreateNodeInput>;

const UpdateNodeInput = z.object({
  node_id: z.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  status: z.enum(NODE_STATUSES).optional(),
  visibility: z.enum(NODE_VISIBILITIES).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  goal: z.string().nullable().optional(),
  lifecycle_state: z.string().nullable().optional(),
  owner_id: z.string().nullable().optional(),
});
type UpdateNodeInput = z.infer<typeof UpdateNodeInput>;

export async function updateNodeInternal(
  db: Client,
  updatedBy: string,
  input: UpdateNodeInput,
): Promise<void> {
  const args = UpdateNodeInput.parse(input);

  const row = await db.execute({
    sql: "SELECT type FROM nodes WHERE id = ?",
    args: [args.node_id],
  });
  if (row.rows.length === 0) {
    throw new Error(`node ${args.node_id} not found`);
  }
  const nodeType = row.rows[0].type as NodeType;

  if (args.lifecycle_state !== undefined && args.lifecycle_state !== null) {
    const valid = getLifecycleStatesForType(nodeType);
    if (!valid.includes(args.lifecycle_state)) {
      throw new Error(
        `invalid lifecycle_state '${args.lifecycle_state}' for node type '${nodeType}'. Valid: ${valid.join(", ")}`,
      );
    }
  }

  // Update non-lifecycle fields first (all in one UPDATE so owner_id trigger
  // fires once, and updated_at bumps once).
  const sets: string[] = [];
  const values: InValue[] = [];
  if (args.name !== undefined) {
    sets.push("name = ?");
    values.push(args.name);
  }
  if (args.description !== undefined) {
    sets.push("description = ?");
    values.push(args.description);
  }
  if (args.status !== undefined) {
    sets.push("status = ?");
    values.push(args.status);
  }
  if (args.visibility !== undefined) {
    sets.push("visibility = ?");
    values.push(args.visibility);
  }
  if (args.meta !== undefined) {
    sets.push("meta = ?");
    values.push(JSON.stringify(args.meta));
  }
  if (args.goal !== undefined) {
    sets.push("goal = ?");
    values.push(args.goal);
  }
  if (args.owner_id !== undefined) {
    sets.push("owner_id = ?");
    values.push(args.owner_id);
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(args.node_id);
    await db.execute({
      sql: `UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`,
      args: values,
    });
  }

  // Update lifecycle_state separately so the AFTER UPDATE OF lifecycle_state
  // trigger fires and derives status. (Splitting guarantees the trigger sees
  // a real column-value change on exactly that column.)
  if (args.lifecycle_state !== undefined) {
    await db.execute({
      sql: "UPDATE nodes SET lifecycle_state = ? WHERE id = ?",
      args: [args.lifecycle_state, args.node_id],
    });
  }

  await writeAudit(db, updatedBy, "update_node", "node", args.node_id, { input: args });
}

export async function createNodeInternal(
  db: Client,
  createdBy: string,
  input: CreateNodeInput,
): Promise<string> {
  const args = CreateNodeInput.parse(input);

  // Non-organization nodes must belong to exactly one organization. Verify
  // here so the error message is friendly instead of a DB-level FK/trigger
  // error fired deep inside the batch.
  if (args.type !== "organization") {
    if (!args.organization_id) {
      throw new Error(
        `organization_id is required for type=${args.type}. Every non-organization node must belong to exactly one organization.`,
      );
    }
    const orgCheck = await db.execute({
      sql: "SELECT id, type FROM nodes WHERE id = ?",
      args: [args.organization_id],
    });
    if (orgCheck.rows.length === 0) {
      throw new Error(`organization_id ${args.organization_id} not found`);
    }
    if (orgCheck.rows[0].type !== "organization") {
      throw new Error(
        `${args.organization_id} is a ${orgCheck.rows[0].type}, not an organization`,
      );
    }
  }

  if (args.lifecycle_state !== undefined) {
    const valid = getLifecycleStatesForType(args.type as NodeType);
    if (!valid.includes(args.lifecycle_state)) {
      throw new Error(
        `invalid lifecycle_state '${args.lifecycle_state}' for node type '${args.type}'. Valid: ${valid.join(", ")}`,
      );
    }
  }

  const id = ulid();
  const now = new Date().toISOString();
  const edgeId = args.type !== "organization" ? ulid() : null;
  const syncKey = await generateSyncKey(db, args.name);

  // Atomic batch: node INSERT and (for non-org types) belongs_to edge INSERT
  // succeed or fail together. Guarantees the org invariant from the moment
  // the node comes into existence -- there is no window in which the node
  // exists without its required organization link.
  const statements: Parameters<typeof db.batch>[0] = [
    {
      sql: `INSERT INTO nodes (id, type, name, description, meta, status, visibility, sync_key, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        args.type,
        args.name,
        args.description ?? null,
        args.meta ? JSON.stringify(args.meta) : null,
        args.status ?? "active",
        args.visibility ?? "team",
        syncKey,
        createdBy,
        now,
        now,
      ],
    },
  ];

  if (edgeId && args.organization_id) {
    statements.push({
      sql: `INSERT INTO edges (id, source_id, target_id, relation, meta, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [edgeId, id, args.organization_id, "belongs_to", null, createdBy, now],
    });
  }

  await db.batch(statements, "write");

  // Post-INSERT UPDATE to persist goal and/or lifecycle_state. We do this as
  // an UPDATE (not as part of the INSERT) so the AFTER UPDATE OF
  // lifecycle_state trigger fires and derives status correctly -- the
  // trigger cannot observe an INSERT.
  if (args.lifecycle_state !== undefined) {
    await db.execute({
      sql: "UPDATE nodes SET lifecycle_state = ?, goal = ? WHERE id = ?",
      args: [args.lifecycle_state, args.goal ?? null, id],
    });
  } else if (args.goal !== undefined) {
    await db.execute({
      sql: "UPDATE nodes SET goal = ? WHERE id = ?",
      args: [args.goal, id],
    });
  }

  await writeAudit(db, createdBy, "create_node", "node", id, {
    type: args.type,
    name: args.name,
    ...(args.organization_id ? { organization_id: args.organization_id } : {}),
    ...(args.goal !== undefined ? { goal: args.goal } : {}),
    ...(args.lifecycle_state !== undefined ? { lifecycle_state: args.lifecycle_state } : {}),
  });

  return id;
}
