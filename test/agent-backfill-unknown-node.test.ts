// #635: a mirror of a node central does not know is unregistered by the
// sync agent's backfill sweep (team workspace), and one whose node is gone
// from the graph db by the personal workspace's stale cleanup. The folder
// stays on disk in both; any other central failure keeps the mirror.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHttpCentralClient } from "../apps/server/domain/sync/central/client.js";
import { createCentralBackfillSweep } from "../apps/server/boot/central-backfill.js";
import { cleanStaleMirrorsLogged } from "../apps/server/boot/mirror-watch.js";
import { listUserMirrors, registerMirror } from "../apps/server/domain/sync/mirror-registry.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { openTestDb } from "./helpers/db.js";

const USER = "01SOLO0000000000000000000";

// The fake central server: the batch omits every node (as central does for
// an unknown one), the single GET answers with the status this test set.
let singleStatus = 404;
const requests: string[] = [];
let server: Server;
let baseUrl: string;
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "portuni-unknown-node-"));
  process.env.PORTUNI_WORKSPACE_ROOT = dir;
  resetLocalDbForTests();
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/sync/info-batch") {
        res.statusCode = 200;
        res.end(JSON.stringify({ infos: [] }));
        return;
      }
      res.statusCode = singleStatus;
      res.end(
        JSON.stringify(
          singleStatus === 404
            ? { error: "Node not found", code: "NODE_NOT_FOUND" }
            : { error: "unavailable", code: "INTERNAL" },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  resetLocalDbForTests();
  delete process.env.PORTUNI_WORKSPACE_ROOT;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
});

function capture() {
  const lines: string[] = [];
  const log = {
    warn: (...a: unknown[]) => void lines.push(a.map(String).join(" ")),
    error: (...a: unknown[]) => void lines.push(a.map(String).join(" ")),
  };
  return { lines, log };
}

describe("sync agent backfill sweep: node central does not know (#635)", () => {
  it("404 NODE_NOT_FOUND unregisters the mirror once; the folder stays", async () => {
    singleStatus = 404;
    const folder = join(dir, "test-org");
    await mkdir(join(folder, "wip"), { recursive: true });
    await registerMirror(USER, "N_UNKNOWN", folder);
    const client = createHttpCentralClient({ baseUrl, token: "t", syncInfoTtlMs: 0 });
    const { lines, log } = capture();
    const sweep = createCentralBackfillSweep({ client, userId: USER, log });

    await sweep("boot");
    assert.deepEqual(await listUserMirrors(USER), []);
    assert.ok(existsSync(folder), "files stay on disk");
    const hits = lines.filter((l) => l.includes("N_UNKNOWN"));
    assert.equal(hits.length, 1);
    assert.match(hits[0], /unregistered its mirror/);
    assert.ok(hits[0].includes(folder), "the log names the folder");

    // The next sweep no longer asks about it, so it never logs again.
    requests.length = 0;
    await sweep("sweep");
    assert.deepEqual(requests, []);
    assert.equal(lines.filter((l) => l.includes("N_UNKNOWN")).length, 1);
  });

  it("503 keeps the mirror", async () => {
    singleStatus = 503;
    const folder = join(dir, "kept");
    await mkdir(folder, { recursive: true });
    await registerMirror(USER, "N_FLAKY", folder);
    const client = createHttpCentralClient({ baseUrl, token: "t", syncInfoTtlMs: 0 });
    const { lines, log } = capture();
    await createCentralBackfillSweep({ client, userId: USER, log })("sweep");
    assert.deepEqual(
      (await listUserMirrors(USER)).map((m) => m.node_id),
      ["N_FLAKY"],
    );
    assert.ok(requests.includes("GET /nodes/N_FLAKY/sync-info"));
    assert.ok(lines.some((l) => l.includes("central backfill failed for")));
  });

  it("401 and 429 keep the mirror too", async () => {
    for (const status of [401, 429]) {
      singleStatus = status;
      const client = createHttpCentralClient({ baseUrl, token: "t", syncInfoTtlMs: 0 });
      const { log } = capture();
      await createCentralBackfillSweep({ client, userId: USER, log })("sweep");
      assert.ok((await listUserMirrors(USER)).some((m) => m.node_id === "N_FLAKY"), `status ${status}`);
    }
  });

  it("central unreachable keeps the mirror", async () => {
    const client = createHttpCentralClient({
      baseUrl: "http://127.0.0.1:1",
      token: "t",
      syncInfoTtlMs: 0,
      requestTimeoutMs: 2000,
    });
    const { lines, log } = capture();
    await createCentralBackfillSweep({ client, userId: USER, log })("sweep");
    assert.ok((await listUserMirrors(USER)).some((m) => m.node_id === "N_FLAKY"));
    assert.ok(lines.some((l) => l.includes("central unreachable")));
  });
});

describe("personal workspace: node gone from the graph db (#635)", () => {
  it("unregisters the mirror, logs its folder once, keeps the folder", async () => {
    const shared = await openTestDb();
    await shared.execute("CREATE TABLE nodes (id TEXT PRIMARY KEY)");
    await shared.execute("INSERT INTO nodes (id) VALUES ('N_LIVE')");
    const gone = join(dir, "gone");
    await mkdir(gone, { recursive: true });
    await registerMirror("U_LOCAL", "N_LIVE", join(dir, "live"));
    await registerMirror("U_LOCAL", "N_GONE", gone);
    const { lines, log } = capture();
    await cleanStaleMirrorsLogged(shared, "U_LOCAL", "portuni:watch", log);
    await cleanStaleMirrorsLogged(shared, "U_LOCAL", "portuni:watch", log);
    assert.deepEqual(
      (await listUserMirrors("U_LOCAL")).map((m) => m.node_id),
      ["N_LIVE"],
    );
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(gone));
    assert.ok(existsSync(gone));
  });
});
