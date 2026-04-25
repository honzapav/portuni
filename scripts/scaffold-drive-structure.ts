// One-time backfill: ensure each registered mirror has its corresponding
// folder structure on the routed remote. Idempotent.
//
// - Organization nodes get <org_sync_key>/{projects,processes,areas,principles}
// - All other nodes get <nodeRoot>/{wip,outputs,resources}
//
// Run: varlock run -- node --import tsx scripts/scaffold-drive-structure.ts

import { getDb } from "../src/db.js";
import { listUserMirrors } from "../src/sync/mirror-registry.js";
import { resolveNodeInfo } from "../src/sync/engine.js";
import { resolveRemote } from "../src/sync/routing.js";
import { getAdapter } from "../src/sync/adapter-cache.js";
import { buildNodeRoot } from "../src/sync/remote-path.js";
import { SOLO_USER } from "../src/schema.js";

const ORG_PLURALS = ["projects", "processes", "areas", "principles"] as const;
const NODE_SECTIONS = ["wip", "outputs", "resources"] as const;

async function main(): Promise<void> {
  if (!process.env.PORTUNI_WORKSPACE_ROOT) {
    throw new Error("PORTUNI_WORKSPACE_ROOT must be set (TokenStore reads from $ROOT/.portuni)");
  }
  const db = getDb();
  const mirrors = await listUserMirrors(SOLO_USER);
  console.log(`Scaffolding remote structure for ${mirrors.length} registered mirror(s)...`);

  let nodes = 0;
  let folders = 0;
  let skipped = 0;
  let errors = 0;

  for (const m of mirrors) {
    let info: Awaited<ReturnType<typeof resolveNodeInfo>>;
    try {
      info = await resolveNodeInfo(db, m.node_id);
    } catch (e) {
      console.log(`  ! ${m.node_id.slice(0, 12)}... node missing (${(e as Error).message})`);
      skipped++;
      continue;
    }
    const remoteName = await resolveRemote(db, info.nodeType, info.orgSyncKey);
    if (!remoteName) {
      console.log(`  - ${info.nodeSyncKey} (${info.nodeType}) -- no routing, skipped`);
      skipped++;
      continue;
    }
    const adapter = await getAdapter(db, remoteName);
    if (!adapter.ensureFolder) {
      console.log(`  - ${info.nodeSyncKey} -- adapter does not support ensureFolder`);
      skipped++;
      continue;
    }
    const nodeRoot = buildNodeRoot(info);
    const subpaths = info.nodeType === "organization" ? ORG_PLURALS : NODE_SECTIONS;
    const created: string[] = [];
    let nodeError = false;
    for (const sub of subpaths) {
      const target = `${nodeRoot}/${sub}`;
      try {
        await adapter.ensureFolder(target);
        created.push(target);
        folders++;
      } catch (e) {
        console.log(`    ✗ ${target}  FAILED: ${(e as Error).message}`);
        errors++;
        nodeError = true;
      }
    }
    if (!nodeError) {
      nodes++;
      const head = info.nodeType === "organization"
        ? `org "${info.nodeSyncKey}"`
        : `${info.nodeType} "${info.nodeSyncKey}"`;
      console.log(`  ✓ ${head}  -> ${created.length} folder(s) at ${nodeRoot}/`);
    }
  }

  console.log(`\nDone. nodes_scaffolded=${nodes}, folders=${folders}, skipped=${skipped}, errors=${errors}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
