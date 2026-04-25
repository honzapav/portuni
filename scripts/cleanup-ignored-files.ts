// Find files registered in Portuni that match .portuniignore patterns
// and remove them from Drive + DB (keeping local copies). Used to clean up
// after a bulk-promote that ran with the old broken ignore loader.
//
// Run: varlock run -- node --import tsx scripts/cleanup-ignored-files.ts [--dry-run]

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { getDb } from "../src/db.js";
import { deleteFile } from "../src/sync/engine.js";
import { SOLO_USER } from "../src/schema.js";
import { compileIgnorePatterns } from "../src/portuniignore.js";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const workspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT?.replace(/^~(?=$|\/)/, homedir());
  if (!workspaceRoot) throw new Error("PORTUNI_WORKSPACE_ROOT must be set");

  const ignoreText = await readFile(join(workspaceRoot, ".portuniignore"), "utf-8");
  const isIgnored = compileIgnorePatterns(ignoreText);

  const db = getDb();
  // Use mirrors so we can derive the relative path each file would have under
  // the workspace root. We compare against ignore patterns using that
  // workspace-relative path (consistent with bulk-promote.ts).
  const filesRes = await db.execute({
    sql: `SELECT f.id, f.filename, f.remote_path, f.node_id, n.name as node_name
            FROM files f
            JOIN nodes n ON n.id = f.node_id
           ORDER BY f.created_at`,
  });

  const toDelete: Array<{ id: string; rel: string; node_name: string }> = [];
  for (const row of filesRes.rows) {
    const remotePath = (row.remote_path as string | null) ?? "";
    if (!remotePath) continue;
    // remote_path is org-rooted; mirror folders are also org-rooted under
    // workspace_root, so remote_path is comparable to a workspace-relative path.
    if (isIgnored(remotePath)) {
      toDelete.push({
        id: row.id as string,
        rel: remotePath,
        node_name: row.node_name as string,
      });
    }
  }

  if (toDelete.length === 0) {
    console.log("No registered files match ignore patterns. Nothing to do.");
    return;
  }

  console.log(`Found ${toDelete.length} registered file(s) that match ignore patterns:\n`);
  for (const f of toDelete) {
    console.log(`  - [${f.node_name}] ${f.rel}`);
  }

  if (dryRun) {
    console.log("\n[dry run] no changes applied.");
    return;
  }

  console.log("\nDeleting from Drive + DB (local copies preserved)...");
  let done = 0;
  let failed = 0;
  for (const f of toDelete) {
    try {
      // Two-step destructive contract: preview, then confirm.
      await deleteFile(db, { userId: SOLO_USER, fileId: f.id, mode: "complete" });
      await deleteFile(db, {
        userId: SOLO_USER,
        fileId: f.id,
        mode: "complete",
        confirmed: true,
      });
      console.log(`  ✓ ${f.rel}`);
      done++;
    } catch (e) {
      console.log(`  ✗ ${f.rel} -- ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\nDone. deleted=${done}, failed=${failed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
