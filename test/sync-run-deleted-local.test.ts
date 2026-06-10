// POST /nodes/:id/sync must NOT resurrect a file the user deleted from the
// mirror on purpose. deleted_local is a decision (restore via portuni_pull,
// or remove via portuni_delete_file), reported in the run result -- never
// an automatic re-download.

process.env.PORT = "14930";
process.env.HOST = "127.0.0.1";
process.env.PORTUNI_AUTH_TOKEN = "";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { storeFile } from "../src/domain/sync/engine.js";
import { registerMirror } from "../src/domain/sync/mirror-registry.js";
import { setDbForTesting } from "../src/infra/db.js";
import { resetGateCachesForTesting } from "../src/http/middleware.js";
import { resetLocalDbForTests } from "../src/domain/sync/local-db.js";
import { resetAdapterCacheForTests } from "../src/domain/sync/adapter-cache.js";
import { startHttpServer, type HttpServerHandle } from "../src/http/server.js";

const BASE = "http://127.0.0.1:14930";

let handle: HttpServerHandle;
let workspace: string;
let nodeId: string;
let fileId: string;
let localPath: string;

before(async () => {
  resetGateCachesForTesting();
  workspace = await mkdtemp(join(tmpdir(), "portuni-syncrun-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  resetLocalDbForTests();
  resetAdapterCacheForTests();

  const shared = await makeSharedDb();
  nodeId = shared.nodeId;
  setDbForTesting(shared.db);

  await registerMirror("01SOLO0000000000000000000", nodeId, join(workspace, "mirror"));
  const src = join(workspace, "doc.md");
  await writeFile(src, "v1");
  const r = await storeFile(shared.db, {
    userId: "01SOLO0000000000000000000",
    nodeId,
    localPath: src,
  });
  fileId = r.file_id;
  localPath = r.local_path;
  // User deletes the local copy on purpose.
  await rm(localPath);

  handle = startHttpServer({ port: 14930, host: "127.0.0.1", registerSigint: false });
  await new Promise((res) => setImmediate(res));
});

after(async () => {
  await handle.shutdown();
  setDbForTesting(null);
  resetLocalDbForTests();
  resetAdapterCacheForTests();
  await rm(workspace, { recursive: true, force: true });
});

describe("sync run vs deleted_local", () => {
  it("reports the deletion instead of re-downloading the file", async () => {
    const res = await fetch(`${BASE}/nodes/${nodeId}/sync`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      pulled: Array<{ file_id: string }>;
      deleted_local: Array<{ file_id: string; filename: string }>;
    };
    assert.ok(
      Array.isArray(body.deleted_local) &&
        body.deleted_local.some((f) => f.file_id === fileId),
      `deleted_local must list the file, got ${JSON.stringify(body)}`,
    );
    assert.ok(
      !body.pulled.some((f) => f.file_id === fileId),
      "the deleted file must not be auto-pulled",
    );
    await assert.rejects(() => stat(localPath), "file must stay deleted on disk");
  });
});
