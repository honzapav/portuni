import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { buildNodeRoot, buildRemotePath } from "../src/sync/remote-path.js";

async function setup(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, type TEXT, name TEXT, sync_key TEXT UNIQUE,
    created_by TEXT, created_at DATETIME, updated_at DATETIME
  )`);
  await db.execute("INSERT INTO nodes (id,type,name,sync_key,created_by,created_at,updated_at) VALUES ('O1','organization','Workflow','workflow','U1','t','t')");
  await db.execute("INSERT INTO nodes (id,type,name,sync_key,created_by,created_at,updated_at) VALUES ('N1','project','Stan GWS','stan-gws','U1','t','t')");
  return db;
}

describe("rename stability", () => {
  it("rename node name does not change buildNodeRoot output", async () => {
    const db = await setup();
    const syncKey = "stan-gws";
    const before = buildNodeRoot({ orgSyncKey: "workflow", nodeType: "project", nodeSyncKey: syncKey });
    await db.execute({ sql: "UPDATE nodes SET name = ? WHERE id = 'N1'", args: ["Stan GWS Phase 2"] });
    const r = await db.execute({ sql: "SELECT sync_key FROM nodes WHERE id = 'N1'" });
    const after = buildNodeRoot({ orgSyncKey: "workflow", nodeType: "project", nodeSyncKey: r.rows[0].sync_key as string });
    assert.equal(before, after);
  });

  it("two nodes with same display name get different sync_keys; paths do not collide", async () => {
    const db = await setup();
    await db.execute("INSERT INTO nodes (id,type,name,sync_key,created_by,created_at,updated_at) VALUES ('N2','project','Stan GWS','stan-gws-abcdef','U1','t','t')");
    const p1 = buildRemotePath({ orgSyncKey: "workflow", nodeType: "project", nodeSyncKey: "stan-gws", section: "outputs", subpath: null, filename: "r.pdf" });
    const p2 = buildRemotePath({ orgSyncKey: "workflow", nodeType: "project", nodeSyncKey: "stan-gws-abcdef", section: "outputs", subpath: null, filename: "r.pdf" });
    assert.notEqual(p1, p2);
  });
});
