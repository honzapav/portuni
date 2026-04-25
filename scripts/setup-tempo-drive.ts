// Set up the tempo-drive remote against the production Turso DB.
// Reads SA JSON from disk, never echoes it.
// Run: varlock run -- node --import tsx scripts/setup-tempo-drive.ts

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../src/db.js";
import { setupRemoteService, setRoutingPolicyService, listRemotesService } from "../src/tools/sync-remotes.js";
import { SOLO_USER } from "../src/schema.js";

const SA_PATH = join(homedir(), ".config/portuni/sa-keys/portuni-sync-test-89642.json");
const SHARED_DRIVE_ID = "0AFIxOA-MBlNzUk9PVA";

async function main(): Promise<void> {
  if (!process.env.PORTUNI_WORKSPACE_ROOT) {
    throw new Error("PORTUNI_WORKSPACE_ROOT must be set");
  }
  const sa = await readFile(SA_PATH, "utf-8");
  const db = getDb();

  console.log("Configuring tempo-drive remote against shared_drive_id =", SHARED_DRIVE_ID);
  await setupRemoteService(db, {
    userId: SOLO_USER,
    name: "tempo-drive",
    type: "gdrive",
    config: { shared_drive_id: SHARED_DRIVE_ID },
    service_account_json: sa,
  });
  console.log("  remote upserted, SA JSON written to TokenStore");

  console.log("Setting routing policy: wildcard -> tempo-drive");
  await setRoutingPolicyService(db, [
    { priority: 99, node_type: null, org_slug: null, remote_name: "tempo-drive" },
  ]);

  console.log("\nConfigured remotes:");
  for (const r of await listRemotesService(db)) {
    console.log(`  ${r.name.padEnd(20)} type=${r.type.padEnd(10)} authenticated=${r.authenticated}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
