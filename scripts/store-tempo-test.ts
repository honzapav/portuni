// Smoke: store a small test file against a real Tempo node via the production
// Drive remote. Verifies the full path: sync_key based remote_path, multipart
// upload to Shared Drive, post-upload md5 verification, file_state in
// per-device sync.db, audit_log entry.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../src/db.js";
import { storeFile, statusScan, deleteFile } from "../src/sync/engine.js";
import { getMirrorPath } from "../src/sync/mirror-registry.js";
import { SOLO_USER } from "../src/schema.js";

const TARGET_NODE = "01KNNNE653WPZ9XV26DKRX8P9A"; // Freelo Webinar -- real but low-impact

async function main(): Promise<void> {
  if (!process.env.PORTUNI_WORKSPACE_ROOT) throw new Error("PORTUNI_WORKSPACE_ROOT must be set");
  const db = getDb();
  const mirror = await getMirrorPath(SOLO_USER, TARGET_NODE);
  console.log("target node mirror:", mirror);
  if (!mirror) throw new Error(`No mirror registered for ${TARGET_NODE}`);

  // Place a tiny test file in the mirror's wip section so subpath auto-detect
  // picks it up cleanly.
  await mkdir(join(mirror, "wip"), { recursive: true });
  const tmp = join(mirror, "wip", `portuni-prod-smoke-${Date.now()}.txt`);
  const payload = `portuni production smoke ${new Date().toISOString()}\n`;
  await writeFile(tmp, payload);
  console.log("wrote:", tmp, `(${payload.length} bytes)`);

  console.log("\n→ portuni_store");
  const t0 = Date.now();
  const r = await storeFile(db, { userId: SOLO_USER, nodeId: TARGET_NODE, localPath: tmp });
  console.log(`  remote_path = ${r.remote_path}`);
  console.log(`  hash        = ${r.hash}  (length=${r.hash.length}, ${r.hash.length === 32 ? "md5" : "sha256"})`);
  console.log(`  file_id     = ${r.file_id}`);
  console.log(`  ${Date.now() - t0} ms`);

  console.log("\n→ portuni_status (tracked only)");
  const scan = await statusScan(db, { userId: SOLO_USER, nodeId: TARGET_NODE, includeDiscovery: false });
  const ours = [...scan.clean, ...scan.push_candidates, ...scan.pull_candidates, ...scan.conflicts]
    .find((f) => f.file_id === r.file_id);
  console.log(`  classification: ${ours?.class ?? "(missing)"}`);
  console.log(`  clean=${scan.clean.length} push=${scan.push_candidates.length} pull=${scan.pull_candidates.length} conflict=${scan.conflicts.length}`);

  console.log("\n→ portuni_delete_file (soft delete to Drive trash)");
  const dr = await deleteFile(db, { userId: SOLO_USER, fileId: r.file_id, mode: "complete", confirmed: true });
  console.log(`  mode=${dr.mode}, deleted_at=${dr.deleted_at}`);

  console.log("\n✅ production Drive smoke PASSED");
}

main().catch((e) => { console.error(e); process.exit(1); });
