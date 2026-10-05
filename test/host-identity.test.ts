// #578: the device's host id is a ULID stored in its data dir, the hostname
// only its label; a device claims the records it made under its previous
// ids (the hostname slug) -- directly in a personal workspace's graph db,
// through POST /hosts/claim on the central server in a team workspace.
// The runtime half (Předat and Pokračovat v nové session after a claim) is
// in test/runner-runtime-handoff.test.ts (personal) and
// test/agent-router-sessions.test.ts (fake central).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEVICE_IDENTITY_FILENAME,
  loadDeviceIdentity,
  localHostId,
  localHostLabel,
  resetDeviceIdentityForTests,
  resolveHostLabel,
  setMachineNameForTests,
} from "../apps/server/domain/runner/hosts.js";
import { claimHostRecords } from "../apps/server/domain/sessions.js";
import { DbSessionStore } from "../apps/server/domain/runner/store.js";
import { setDbForTesting, type DbClient } from "../apps/server/infra/db.js";
import { insertIgnore } from "../apps/server/infra/sql.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import { createHttpCentralClient } from "../apps/server/domain/sync/central/client.js";
import type { RequestIdentity } from "../apps/server/auth/request-identity.js";
import { makeSharedDb } from "./helpers/shared-db.js";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("device identity (#578)", () => {
  let dir: string | null = null;
  const savedHostId = process.env.PORTUNI_HOST_ID;
  const savedLabel = process.env.PORTUNI_HOST_LABEL;

  afterEach(async () => {
    setMachineNameForTests(null);
    resetDeviceIdentityForTests();
    if (savedHostId === undefined) delete process.env.PORTUNI_HOST_ID;
    else process.env.PORTUNI_HOST_ID = savedHostId;
    if (savedLabel === undefined) delete process.env.PORTUNI_HOST_LABEL;
    else process.env.PORTUNI_HOST_LABEL = savedLabel;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function freshDir(): Promise<string> {
    delete process.env.PORTUNI_HOST_ID;
    delete process.env.PORTUNI_HOST_LABEL;
    dir = await mkdtemp(join(tmpdir(), "portuni-host-id-"));
    return dir;
  }

  it("the first boot mints a ULID and remembers the hostname slug as the previous id", async () => {
    const d = await freshDir();
    setMachineNameForTests(() => "Honzas-MacBook-Pro.local");
    const identity = loadDeviceIdentity(d);
    assert.ok(identity);
    assert.match(identity.host_id, ULID_RE);
    assert.deepEqual(identity.previous_host_ids, ["honzas-macbook-pro"]);
    assert.equal(localHostId(), identity.host_id);
    const onDisk = JSON.parse(readFileSync(join(d, DEVICE_IDENTITY_FILENAME), "utf8"));
    assert.deepEqual(onDisk, identity);
  });

  it("the stored id survives a hostname change; the label follows the hostname", async () => {
    const d = await freshDir();
    setMachineNameForTests(() => "honzapav-mbp-m5.local");
    const first = loadDeviceIdentity(d);
    assert.ok(first);

    setMachineNameForTests(() => "case-mac.local");
    resetDeviceIdentityForTests();
    const second = loadDeviceIdentity(d);
    assert.deepEqual(second, first, "renaming the machine changes nothing in the file");
    assert.equal(localHostId(), first.host_id);
    assert.equal(localHostLabel(), "case-mac");
    assert.equal(resolveHostLabel(first.host_id), "case-mac");
  });

  it("PORTUNI_HOST_ID overrides the id: nothing is written and nothing is claimed", async () => {
    const d = await freshDir();
    process.env.PORTUNI_HOST_ID = "dev-loop";
    assert.equal(loadDeviceIdentity(d), null);
    assert.equal(existsSync(join(d, DEVICE_IDENTITY_FILENAME)), false);
    assert.equal(localHostId(), "dev-loop");
  });

  it("an unreadable file is left for a human to repair; the process runs under the hostname slug", async () => {
    const d = await freshDir();
    setMachineNameForTests(() => "case-mac");
    writeFileSync(join(d, DEVICE_IDENTITY_FILENAME), "{ not json");
    assert.equal(loadDeviceIdentity(d), null);
    assert.equal(readFileSync(join(d, DEVICE_IDENTITY_FILENAME), "utf8"), "{ not json");
    assert.equal(localHostId(), "case-mac");
  });
});

// Two users' threads, each with a run, under the old id and under another
// device's id. Returns the ids to look them up by.
async function seedRecords(db: DbClient, nodeId: string) {
  await db.execute({
    sql: insertIgnore(db.dialect, "INSERT OR IGNORE INTO users (id, email, name) VALUES (?, ?, ?)"),
    args: ["U2", "u2@b", "U2"],
  });
  const store = new DbSessionStore(db);
  const make = async (userId: string, hostId: string) => {
    const s = await store.createSession({ node_id: nodeId, user_id: userId, runner: "fake", instance_id: null, host_id: hostId });
    const r = await store.createRun({ session_id: s.id, runner: "fake", instance_id: null, host_id: hostId });
    return { sessionId: s.id, runId: r.id };
  };
  return {
    mine: await make("U1", "stary-mac"),
    mineElsewhere: await make("U1", "druhy-mac"),
    theirs: await make("U2", "stary-mac"),
  };
}

async function hostsOf(db: DbClient, ids: { sessionId: string; runId: string }) {
  const s = await db.execute({ sql: "SELECT host_id FROM sessions WHERE id = ?", args: [ids.sessionId] });
  const r = await db.execute({ sql: "SELECT host_id FROM session_runs WHERE id = ?", args: [ids.runId] });
  return { session: s.rows[0].host_id, run: r.rows[0].host_id };
}

describe("claimHostRecords (#578)", () => {
  afterEach(() => setDbForTesting(null));

  it("rewrites only the listed old ids, only the owner's, and a second claim is a no-op", async () => {
    const { db, nodeId } = await makeSharedDb();
    const ids = await seedRecords(db, nodeId);

    const first = await claimHostRecords(db, { hostId: "NEWID", previousHostIds: ["stary-mac"], userId: "U1" });
    assert.deepEqual(first, { sessions: 1, runs: 1 });
    assert.deepEqual(await hostsOf(db, ids.mine), { session: "NEWID", run: "NEWID" });
    assert.deepEqual(await hostsOf(db, ids.mineElsewhere), { session: "druhy-mac", run: "druhy-mac" });
    assert.deepEqual(await hostsOf(db, ids.theirs), { session: "stary-mac", run: "stary-mac" });

    const again = await claimHostRecords(db, { hostId: "NEWID", previousHostIds: ["stary-mac"], userId: "U1" });
    assert.deepEqual(again, { sessions: 0, runs: 0 });
  });

  it("a personal workspace's boot claim (no owner) takes every record under the old id", async () => {
    const { db, nodeId } = await makeSharedDb();
    const ids = await seedRecords(db, nodeId);
    const r = await claimHostRecords(db, { hostId: "NEWID", previousHostIds: ["stary-mac", "NEWID", ""] });
    assert.deepEqual(r, { sessions: 2, runs: 2 });
    assert.deepEqual(await hostsOf(db, ids.theirs), { session: "NEWID", run: "NEWID" });
    assert.deepEqual(await hostsOf(db, ids.mineElsewhere), { session: "druhy-mac", run: "druhy-mac" });
  });
});

function identityOf(userId: string, scope: RequestIdentity["globalScope"] = "write"): RequestIdentity {
  return { userId, email: `${userId}@x`, name: userId, globalScope: scope, groups: [], groupIds: [], via: "env" };
}

async function callRoute(identity: RequestIdentity, method: string, path: string, body: unknown) {
  const captured = { statusCode: 0, body: "" };
  const bodyStr = JSON.stringify(body);
  const req = new Readable({
    read() {
      this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = { "content-type": "application/json" };
  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (code: number) => void }).writeHead = (code: number) => {
    captured.statusCode = code;
  };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };
  await routeApiRequest(req, res, new URL(`http://localhost${path}`), identity);
  return captured;
}

describe("POST /hosts/claim (#578, central server)", () => {
  afterEach(() => setDbForTesting(null));

  it("rewrites the caller's records only; repeating it changes nothing", async () => {
    const { db, nodeId } = await makeSharedDb();
    setDbForTesting(db);
    const ids = await seedRecords(db, nodeId);

    const res = await callRoute(identityOf("U1"), "POST", "/hosts/claim", {
      host_id: "NEWID",
      previous_host_ids: ["stary-mac"],
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { sessions: 1, runs: 1 });
    assert.deepEqual(await hostsOf(db, ids.mine), { session: "NEWID", run: "NEWID" });
    assert.deepEqual(await hostsOf(db, ids.theirs), { session: "stary-mac", run: "stary-mac" });

    const again = await callRoute(identityOf("U1"), "POST", "/hosts/claim", {
      host_id: "NEWID",
      previous_host_ids: ["stary-mac"],
    });
    assert.deepEqual(JSON.parse(again.body), { sessions: 0, runs: 0 });
  });

  it("needs the write scope and a well-formed body", async () => {
    const { db } = await makeSharedDb();
    setDbForTesting(db);
    const readOnly = await callRoute(identityOf("U1", "read"), "POST", "/hosts/claim", {
      host_id: "NEWID",
      previous_host_ids: [],
    });
    assert.equal(readOnly.statusCode, 403);
    const bad = await callRoute(identityOf("U1"), "POST", "/hosts/claim", { host_id: "", previous_host_ids: [] });
    assert.equal(bad.statusCode, 400);
  });

  it("CentralClient.claimHost posts the identity and returns the counts", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ sessions: 2, runs: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createHttpCentralClient({ baseUrl: "https://api.example.com", token: "t", fetchImpl });
    const r = await client.claimHost({ host_id: "NEWID", previous_host_ids: ["stary-mac"] });
    assert.deepEqual(r, { sessions: 2, runs: 3 });
    assert.deepEqual(calls, [
      { url: "https://api.example.com/hosts/claim", method: "POST", body: { host_id: "NEWID", previous_host_ids: ["stary-mac"] } },
    ]);
  });
});
