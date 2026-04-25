// Promote untracked local files (statusScan().new_local) into tracked files
// by calling storeFile per file. Honors .portuniignore at $PORTUNI_WORKSPACE_ROOT.
//
// Usage:
//   varlock run -- node --import tsx scripts/bulk-promote.ts [options]
//
// Options:
//   --node <id>         restrict to one node id (default: all nodes with new_local)
//   --dry-run           print what would happen, do not upload anything
//   --max-size <bytes>  skip files larger than N bytes (e.g. 100000000 for 100MB)
//   --yes               skip the per-node interactive prompt (with --dry-run, no-op)
//
// Reads SA token from the configured TokenStore via device-tokens.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getDb } from "../src/db.js";
import { compileIgnorePatterns } from "../src/portuniignore.js";
import { statusScan, storeFile } from "../src/sync/engine.js";
import { SOLO_USER } from "../src/schema.js";

interface Args {
  node?: string;
  dryRun: boolean;
  maxSize?: number;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--node") out.node = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--max-size") out.maxSize = Number(argv[++i]);
    else if (a === "--yes") out.yes = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bulk-promote.ts [--node <id>] [--dry-run] [--max-size <bytes>] [--yes]",
      );
      process.exit(0);
    }
  }
  return out;
}

async function loadIgnore(workspaceRoot: string): Promise<(p: string) => boolean> {
  try {
    const raw = await readFile(join(workspaceRoot, ".portuniignore"), "utf-8");
    return compileIgnorePatterns(raw);
  } catch {
    return () => false;
  }
}

function relativeFromWorkspace(absPath: string, workspaceRoot: string): string {
  return absPath.startsWith(workspaceRoot)
    ? absPath.slice(workspaceRoot.length + 1)
    : absPath;
}

interface PendingFile {
  node_id: string;
  node_name: string;
  local_path: string;
  rel_path: string;
  size: number;
  reason_skipped?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT?.replace(/^~(?=$|\/)/, homedir());
  if (!workspaceRoot) throw new Error("PORTUNI_WORKSPACE_ROOT must be set");

  const db = getDb();
  const isIgnored = await loadIgnore(workspaceRoot);

  console.log("Scanning for untracked local files...");
  const scan = await statusScan(db, {
    userId: SOLO_USER,
    nodeId: args.node,
    includeDiscovery: true,
  });
  console.log(`  found ${scan.new_local.length} candidate(s)\n`);

  // Resolve node names once.
  const nodeIds = [...new Set(scan.new_local.map((f) => f.node_id))];
  const nodeNames = new Map<string, string>();
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => "?").join(",");
    const r = await db.execute({
      sql: `SELECT id, name FROM nodes WHERE id IN (${placeholders})`,
      args: nodeIds,
    });
    for (const row of r.rows) nodeNames.set(row.id as string, row.name as string);
  }

  // Classify each candidate.
  const pending: PendingFile[] = [];
  const { stat } = await import("node:fs/promises");
  for (const f of scan.new_local) {
    const rel = relativeFromWorkspace(f.local_path, workspaceRoot);
    const entry: PendingFile = {
      node_id: f.node_id,
      node_name: nodeNames.get(f.node_id) ?? "?",
      local_path: f.local_path,
      rel_path: rel,
      size: 0,
    };
    if (isIgnored(rel)) {
      entry.reason_skipped = "ignored";
      pending.push(entry);
      continue;
    }
    try {
      const s = await stat(f.local_path);
      entry.size = s.size;
    } catch {
      entry.reason_skipped = "stat-failed";
      pending.push(entry);
      continue;
    }
    if (args.maxSize !== undefined && entry.size > args.maxSize) {
      entry.reason_skipped = `too-large (${(entry.size / (1024 * 1024)).toFixed(1)}MB > ${(args.maxSize / (1024 * 1024)).toFixed(0)}MB)`;
    }
    pending.push(entry);
  }

  // Group by node for display.
  const byNode = new Map<string, PendingFile[]>();
  for (const p of pending) {
    if (!byNode.has(p.node_id)) byNode.set(p.node_id, []);
    byNode.get(p.node_id)!.push(p);
  }

  // Print summary.
  let totalUpload = 0;
  let totalSkip = 0;
  let totalBytes = 0;
  for (const [nodeId, files] of byNode) {
    const upload = files.filter((f) => !f.reason_skipped);
    const skip = files.filter((f) => f.reason_skipped);
    totalUpload += upload.length;
    totalSkip += skip.length;
    totalBytes += upload.reduce((s, f) => s + f.size, 0);
    const head = `  [${upload.length} upload, ${skip.length} skip] ${files[0].node_name} (${nodeId.slice(0, 12)}...)`;
    console.log(head);
    for (const u of upload.slice(0, 5)) {
      console.log(`     + ${u.rel_path}  (${(u.size / 1024).toFixed(1)} KB)`);
    }
    if (upload.length > 5) console.log(`     + ... +${upload.length - 5} more`);
    for (const s of skip.slice(0, 3)) {
      console.log(`     - ${s.rel_path}  (${s.reason_skipped})`);
    }
    if (skip.length > 3) console.log(`     - ... +${skip.length - 3} more skipped`);
  }

  console.log();
  console.log(
    `Total: ${totalUpload} to upload (${(totalBytes / (1024 * 1024)).toFixed(2)} MB), ${totalSkip} skipped.`,
  );

  if (args.dryRun) {
    console.log("\n[dry run] no changes applied.");
    return;
  }

  if (totalUpload === 0) {
    console.log("\nNothing to upload.");
    return;
  }

  if (!args.yes) {
    const rl = createInterface({ input, output });
    const ans = (await rl.question("\nProceed with upload? (yes/no) ")).trim().toLowerCase();
    rl.close();
    if (ans !== "yes" && ans !== "y") {
      console.log("Aborted.");
      return;
    }
  }

  // Upload, per node, with progress.
  let done = 0;
  let failed = 0;
  for (const [nodeId, files] of byNode) {
    const toUpload = files.filter((f) => !f.reason_skipped);
    if (toUpload.length === 0) continue;
    console.log(`\n→ ${files[0].node_name} (${toUpload.length} files)`);
    for (const f of toUpload) {
      const t0 = Date.now();
      try {
        const r = await storeFile(db, {
          userId: SOLO_USER,
          nodeId,
          localPath: f.local_path,
        });
        done++;
        console.log(`   ✓ ${f.rel_path} → ${r.remote_path}  (${Date.now() - t0}ms)`);
      } catch (e) {
        failed++;
        console.log(`   ✗ ${f.rel_path}  FAILED: ${(e as Error).message}`);
      }
    }
  }
  console.log(`\nDone. uploaded=${done}, failed=${failed}, skipped=${totalSkip}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
