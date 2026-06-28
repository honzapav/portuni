import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { statusScan } from "../apps/server/domain/sync/engine.js";
import { listUntrackedLocal } from "../apps/server/domain/sync/discover-local.js";
import { registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../apps/server/domain/sync/adapter-cache.js";

let workspace: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-ignore-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
});
afterEach(async () => {
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
});

// Junk that lands in every macOS mirror folder (.DS_Store from Finder,
// .obsidian/ from notes apps, ~$ lock files from Office) must never be
// discovered as new_local / untracked -- discovery feeds auto-adopt, which
// uploads to the remote and registers a files row.
async function seedMirror(nodeId: string): Promise<string> {
  const mirrorRoot = join(workspace, "mirror");
  await registerMirror("U1", nodeId, mirrorRoot);
  await mkdir(join(mirrorRoot, "wip", ".obsidian"), { recursive: true });
  await writeFile(join(mirrorRoot, "wip", "real.md"), "content");
  await writeFile(join(mirrorRoot, "wip", ".DS_Store"), "junk");
  await writeFile(join(mirrorRoot, "wip", ".obsidian", "cache.json"), "{}");
  await writeFile(join(mirrorRoot, "wip", "~$report.docx"), "lock");
  return mirrorRoot;
}

describe("sync walkers skip junk and ignored files", () => {
  it("statusScan new_local excludes dotfiles, dot-dirs and default junk", async () => {
    const { db, nodeId } = await makeSharedDb();
    await seedMirror(nodeId);

    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    const paths = scan.new_local.map((e) => e.local_path);
    assert.ok(
      paths.some((p) => p.endsWith("real.md")),
      `real.md should be discovered, got ${JSON.stringify(paths)}`,
    );
    assert.ok(!paths.some((p) => p.includes(".DS_Store")), ".DS_Store must be skipped");
    assert.ok(!paths.some((p) => p.includes(".obsidian")), "dot-dirs must be skipped");
    assert.ok(!paths.some((p) => p.includes("~$")), "Office lock files must be skipped");
  });

  it("listUntrackedLocal excludes dotfiles, dot-dirs and default junk", async () => {
    const { db, nodeId } = await makeSharedDb();
    await seedMirror(nodeId);

    const untracked = await listUntrackedLocal(db, { userId: "U1", nodeId });
    const paths = untracked.map((e) => e.local_path);
    assert.ok(paths.some((p) => p.endsWith("real.md")));
    assert.ok(!paths.some((p) => p.includes(".DS_Store")));
    assert.ok(!paths.some((p) => p.includes(".obsidian")));
    assert.ok(!paths.some((p) => p.includes("~$")));
  });

  it("respects .portuniignore patterns at the mirror root", async () => {
    const { db, nodeId } = await makeSharedDb();
    const mirrorRoot = await seedMirror(nodeId);
    await writeFile(join(mirrorRoot, ".portuniignore"), "*.tmp\ndrafts/\n");
    await mkdir(join(mirrorRoot, "wip", "drafts"), { recursive: true });
    await writeFile(join(mirrorRoot, "wip", "scratch.tmp"), "x");
    await writeFile(join(mirrorRoot, "wip", "drafts", "wip.md"), "x");

    const scan = await statusScan(db, { userId: "U1", nodeId, includeDiscovery: true });
    const scanPaths = scan.new_local.map((e) => e.local_path);
    assert.ok(!scanPaths.some((p) => p.endsWith("scratch.tmp")), "*.tmp must be ignored");
    assert.ok(!scanPaths.some((p) => p.includes("/drafts/")), "drafts/ must be ignored");
    assert.ok(scanPaths.some((p) => p.endsWith("real.md")));

    const untracked = await listUntrackedLocal(db, { userId: "U1", nodeId });
    const utPaths = untracked.map((e) => e.local_path);
    assert.ok(!utPaths.some((p) => p.endsWith("scratch.tmp")));
    assert.ok(!utPaths.some((p) => p.includes("/drafts/")));
    assert.ok(utPaths.some((p) => p.endsWith("real.md")));
  });
});
