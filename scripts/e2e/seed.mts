// Seed the fake-central DB for the teammate-mirrors E2E: schema + one org,
// one project, one fs remote routed for everything.
import { createClient } from "@libsql/client";
import { ulid } from "ulid";
import { ensureSchemaOn } from "../../apps/server/infra/schema.js";
import { upsertRemote, addRule } from "../../apps/server/domain/sync/routing.js";

const dbPath = process.argv[2];
const remoteRoot = process.argv[3];
if (!dbPath || !remoteRoot) throw new Error("usage: e2e-seed.ts <dbPath> <remoteRoot>");

const db = createClient({ url: `file:${dbPath}` });
await ensureSchemaOn(db);

const orgId = "E2E0000000000000000000ORG0";
const nodeId = "E2E000000000000000000PROJ0";
const solo = "01SOLO0000000000000000000";
await db.execute({
  sql: "INSERT OR IGNORE INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
  args: [orgId, "organization", "E2E Org", "e2e-org", solo],
});
await db.execute({
  sql: "INSERT OR IGNORE INTO nodes (id,type,name,sync_key,created_by) VALUES (?,?,?,?,?)",
  args: [nodeId, "project", "E2E Project", "e2e-proj", solo],
});
await db.execute({
  sql: "INSERT OR IGNORE INTO edges (id,source_id,target_id,relation,created_by) VALUES (?,?,?,?,?)",
  args: [ulid(), nodeId, orgId, "belongs_to", solo],
});
await upsertRemote(db, {
  name: "e2e-fs",
  type: "fs",
  config: { root: remoteRoot },
  created_by: solo,
});
await addRule(db, { priority: 10, node_type: null, org_slug: null, remote_name: "e2e-fs" });
console.log(`seeded ${dbPath}; node=${nodeId}`);
