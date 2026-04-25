// Move "rogue" files (outside wip/outputs/resources) into proper sections
// for selected knowledge-node mirrors. Skips dev-project mirrors entirely.
//
// Strategy per knowledge node:
//   - Files at mirror root            -> wip/<filename>
//   - Custom subdirs at mirror root   -> resources/<subdir>/...
//   - Hidden files/dirs (.git, ...)   -> left in place
//
// Run: varlock run -- node --import tsx scripts/move-rogue-files.ts [--dry-run]

import { readdir, mkdir, rename, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

const KNOWLEDGE_MIRRORS: string[] = [
  "evoluce/projects/251126-dudes-and-barbies-evoluce",
  "tempo/processes/smlouvy",
  "tempo/processes/technical-infrastructure",
  "tempo/projects/260320-fabini-presale",
  "tempo/projects/hedepy-systematicky-rozvoj-ai",
  "workflow/processes/partner-account-management",
  "workflow/processes/workflow-service",
  "workflow/projects/251126-dotoho-webinar",
  "workflow/projects/2601-marketingmilkshake-prj-migrace",
  "workflow/projects/260126-naturamed-nabidka",
  "workflow/projects/260202-matidal-nabidka",
  "workflow/projects/260219-mergado-con-automatizace-2602",
  "workflow/projects/260408-naturamed-prj-asana-2601",
  "workflow/projects/goldea-presale",
];

const SECTIONS = new Set(["wip", "outputs", "resources"]);

interface Plan {
  from: string;
  to: string;
  kind: "root-file" | "subdir";
}

async function planMirror(root: string): Promise<Plan[]> {
  const plans: Plan[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const src = join(root, e.name);
    if (e.isFile()) {
      plans.push({ from: src, to: join(root, "wip", e.name), kind: "root-file" });
    } else if (e.isDirectory() && !SECTIONS.has(e.name)) {
      plans.push({
        from: src,
        to: join(root, "resources", e.name),
        kind: "subdir",
      });
    }
  }
  return plans;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const workspaceRoot = process.env.PORTUNI_WORKSPACE_ROOT?.replace(/^~/, process.env.HOME ?? "");
  if (!workspaceRoot) throw new Error("PORTUNI_WORKSPACE_ROOT must be set");

  let totalMoves = 0;
  for (const rel of KNOWLEDGE_MIRRORS) {
    const root = join(workspaceRoot, rel);
    try {
      await stat(root);
    } catch {
      console.log(`  ! ${rel} -- mirror folder does not exist, skipping`);
      continue;
    }
    const plans = await planMirror(root);
    if (plans.length === 0) {
      console.log(`  - ${rel} -- nothing to move`);
      continue;
    }
    console.log(`\n${rel}  (${plans.length} item(s))`);
    for (const p of plans) {
      const fromShort = p.from.replace(root + "/", "");
      const toShort = p.to.replace(root + "/", "");
      console.log(`  ${p.kind === "subdir" ? "[DIR]" : "[FILE]"}  ${fromShort}  ->  ${toShort}`);
      if (!dryRun) {
        await mkdir(dirname(p.to), { recursive: true });
        await rename(p.from, p.to);
      }
      totalMoves++;
    }
  }

  console.log(`\n${dryRun ? "[dry run] " : ""}Total moves: ${totalMoves}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
