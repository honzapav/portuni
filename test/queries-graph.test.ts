// test/queries-graph.test.ts
// loadGraph() payload must carry created_at/updated_at per node so the
// empty-workspace picker (apps/web/src/components/WorkspaceEmpty.tsx) can
// rank "recently touched" nodes without a separate round-trip.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { loadGraph } from "../apps/server/domain/queries/graph.js";

async function freshEnv() {
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  await db.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)",
    args: ["U1", "a@b", "A"],
  });
  return db;
}

describe("loadGraph", () => {
  it("includes created_at and updated_at on every node", async () => {
    const db = await freshEnv();
    const id = ulid();
    await db.execute({
      sql: "INSERT INTO nodes (id, type, name, sync_key, created_by) VALUES (?, 'project', 'P', 'p', 'U1')",
      args: [id],
    });
    const graph = await loadGraph(db);
    const node = graph.nodes.find((n) => n.id === id);
    assert.ok(node);
    assert.equal(typeof node!.created_at, "string");
    assert.equal(typeof node!.updated_at, "string");
    assert.ok(node!.created_at.length > 0);
    assert.ok(node!.updated_at.length > 0);
  });
});
