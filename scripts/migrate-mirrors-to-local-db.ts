// One-time pre-migration: copy Turso `local_mirrors` rows into the per-device
// local sync.db before migration 011 drops the Turso table.
//
// Read-only against Turso, idempotent (registerMirror upserts).
// Run from project root with: varlock run -- node --import tsx scripts/migrate-mirrors-to-local-db.ts

import { getDb } from "../src/db.js";
import { registerMirror, listUserMirrors } from "../src/sync/mirror-registry.js";
import { SOLO_USER } from "../src/schema.js";

async function main(): Promise<void> {
  if (!process.env.PORTUNI_WORKSPACE_ROOT) {
    throw new Error("PORTUNI_WORKSPACE_ROOT must be set so the per-device sync.db lands at $ROOT/.portuni/sync.db");
  }
  console.log("Workspace root:", process.env.PORTUNI_WORKSPACE_ROOT);

  const db = getDb();

  // Probe whether Turso still has the legacy table; if it was already dropped,
  // there is nothing to migrate.
  const probe = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='local_mirrors'",
  );
  if (probe.rows.length === 0) {
    console.log("Turso local_mirrors table absent — migration 011 already ran. Nothing to do.");
    const after = await listUserMirrors(SOLO_USER);
    console.log(`Per-device sync.db has ${after.length} mirror row(s).`);
    return;
  }

  const rows = await db.execute({
    sql: "SELECT user_id, node_id, local_path, registered_at FROM local_mirrors WHERE user_id = ?",
    args: [SOLO_USER],
  });
  console.log(`Found ${rows.rows.length} mirror row(s) in Turso for user ${SOLO_USER}.`);
  if (rows.rows.length === 0) return;

  let migrated = 0;
  for (const r of rows.rows) {
    const nodeId = r.node_id as string;
    const localPath = r.local_path as string;
    await registerMirror(SOLO_USER, nodeId, localPath);
    console.log(`  ${nodeId.slice(0, 12)}... -> ${localPath}`);
    migrated++;
  }

  const after = await listUserMirrors(SOLO_USER);
  console.log(`\nMigrated ${migrated} row(s). Per-device sync.db now has ${after.length} mirror row(s).`);
  console.log("Safe to restart the MCP server now; migration 011 will drop the Turso table.");
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
