// portuni_status (statusScan) remote discovery for a node with NO mirror on
// this device -- Asana 1218386301330150. runDiscovery used to iterate over
// mirrors only, so a single-node scan of an unmirrored node (the connector
// session on the central server, or any device that never mirrored it)
// reported new_remote: [] even with an untracked file sitting on the routed
// remote -- and portuni_adopt_files, the tool built for exactly that file,
// was never surfaced. Remote discovery does not need a mirror; only
// new_local does.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb, type SharedDb } from "./helpers/shared-db.js";
import { resetAdapterCacheForTests, getAdapter } from "../apps/server/domain/sync/adapter-cache.js";
import { resolveNodeInfo } from "../apps/server/domain/sync/node-info.js";
import { buildRemotePath } from "../apps/server/domain/sync/remote-path.js";
import { statusScan, adoptFiles } from "../apps/server/domain/sync/engine.js";
import { getMirrorPath } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { useRemoteCapableEnv } from "./helpers/remote-capable-env.js";

useRemoteCapableEnv();

let shared: SharedDb;
let workspace: string;
let originalEnv: string | undefined;

async function seedRemote(filename: string, content: string): Promise<string> {
  const info = await resolveNodeInfo(shared.db, shared.nodeId);
  const remotePath = buildRemotePath({ ...info, section: "wip", subpath: null, filename });
  const adapter = await getAdapter(shared.db, "test-fs");
  await adapter.put(remotePath, Buffer.from(content, "utf8"));
  return remotePath;
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-status-mirrorless-"));
  originalEnv = process.env.PORTUNI_WORKSPACE_ROOT;
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  shared = await makeSharedDb();
});

afterEach(async () => {
  resetAdapterCacheForTests();
  resetLocalDbForTests();
  if (originalEnv === undefined) delete process.env.PORTUNI_WORKSPACE_ROOT;
  else process.env.PORTUNI_WORKSPACE_ROOT = originalEnv;
  await rm(workspace, { recursive: true, force: true });
  await rm(shared.remoteRoot, { recursive: true, force: true });
});

describe("statusScan: single unmirrored node", () => {
  it("reports an untracked remote file as new_remote, then nothing once adopted", async () => {
    assert.equal(await getMirrorPath("U1", shared.nodeId), null, "precondition: no mirror on this device");
    const remotePath = await seedRemote("260911-shrnuti.md", "# shrnutí\n");

    const before = await statusScan(shared.db, { userId: "U1", nodeId: shared.nodeId });
    assert.deepEqual(
      before.new_remote.map((e) => ({ node_id: e.node_id, remote_path: e.remote_path, filename: e.filename })),
      [{ node_id: shared.nodeId, remote_path: remotePath, filename: "260911-shrnuti.md" }],
    );
    assert.deepEqual(before.new_local, [], "no mirror -> nothing to walk locally");

    const adopted = await adoptFiles(shared.db, { userId: "U1", nodeId: shared.nodeId, paths: [remotePath] });
    assert.equal(adopted.adopted.length, 1);

    const after = await statusScan(shared.db, { userId: "U1", nodeId: shared.nodeId });
    assert.deepEqual(after.new_remote, [], "a tracked file is no longer new");
  });

  it("stays quiet with include_discovery: false or skipRemoteDiscovery", async () => {
    await seedRemote("quiet.md", "x");
    const noDiscovery = await statusScan(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      includeDiscovery: false,
    });
    assert.deepEqual(noDiscovery.new_remote, []);
    const skipRemote = await statusScan(shared.db, {
      userId: "U1",
      nodeId: shared.nodeId,
      skipRemoteDiscovery: true,
    });
    assert.deepEqual(skipRemote.new_remote, []);
  });

  it("does not list a remote for the all-mirrors scan (no node_id) on a device with no mirrors", async () => {
    await seedRemote("elsewhere.md", "x");
    const all = await statusScan(shared.db, { userId: "U1" });
    assert.deepEqual(all.new_remote, [], "the all-mirrors scan is still 'what this device mirrors'");
  });
});
