import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createHttpCentralClient,
  CentralHttpError,
} from "../apps/server/domain/sync/central/client.js";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(
  responses: Array<{ status: number; json: unknown }>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      status: r.status,
      json: async () => r.json,
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = { baseUrl: "https://api.example.com/", token: "ptk_test" };

describe("createHttpCentralClient", () => {
  it("syncInfo hits the right URL with the bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, json: { node: { id: "N1" }, remote_name: "r", files: [] } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const info = await c.syncInfo("N1");
    assert.equal(info.remote_name, "r");
    assert.equal(calls[0].url, "https://api.example.com/nodes/N1/sync-info");
    assert.equal(calls[0].headers.authorization, "Bearer ptk_test");
  });

  it("registerFile posts relPath and expects 201", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 201, json: { id: "F1", filename: "a.md", remote_name: "r", remote_path: "p" } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const r = await c.registerFile("N1", "wip/a.md");
    assert.equal(r.id, "F1");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body ?? ""), { relPath: "wip/a.md" });
  });

  it("getFileRaw decodes base64 and carries version + canonical hash", async () => {
    const bytes = Buffer.from([0x00, 0x01, 0xff]);
    const { fetchImpl, calls } = fakeFetch([
      {
        status: 200,
        json: { content_base64: bytes.toString("base64"), version: "v", canonical_hash: "h" },
      },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const r = await c.getFileRaw("N1", "wip/p.png");
    assert.deepEqual(r.bytes, bytes);
    assert.equal(r.version, "v");
    assert.equal(r.canonicalHash, "h");
    assert.ok(calls[0].url.includes("encoding=base64"));
    assert.ok(calls[0].url.includes("path=wip%2Fp.png"));
  });

  it("putFileRaw sends base64 + baseVersion and maps CONFLICT", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 409, json: { error: "changed", code: "CONFLICT", currentVersion: "cv" } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    await assert.rejects(
      () => c.putFileRaw("N1", "wip/a.md", Buffer.from("x"), { baseVersion: "old" }),
      (e: unknown) =>
        e instanceof CentralHttpError &&
        e.status === 409 &&
        e.code === "CONFLICT" &&
        e.currentVersion === "cv",
    );
    const sent = JSON.parse(calls[0].body ?? "");
    assert.equal(sent.baseVersion, "old");
    assert.equal(sent.content_base64, Buffer.from("x").toString("base64"));
  });

  it("syncInfo micro-cache: sequential + concurrent calls within TTL share one fetch", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, json: { node: { id: "N1" }, remote_name: "r", files: [] } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl, syncInfoTtlMs: 60_000 });
    const [a, b] = await Promise.all([c.syncInfo("N1"), c.syncInfo("N1")]);
    await c.syncInfo("N1");
    assert.equal(calls.length, 1);
    assert.equal(a.remote_name, "r");
    assert.equal(b.remote_name, "r");
  });

  it("syncInfo cache: mutation through the client invalidates the node", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, json: { node: { id: "N1" }, remote_name: "r", files: [] } },
      { status: 201, json: { id: "F1", filename: "a", remote_name: "r", remote_path: "p" } },
      { status: 200, json: { node: { id: "N1" }, remote_name: "r", files: [{ id: "F1" }] } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl, syncInfoTtlMs: 60_000 });
    await c.syncInfo("N1");
    await c.registerFile("N1", "wip/a.md");
    const after = await c.syncInfo("N1");
    assert.equal(calls.length, 3); // info, register, fresh info
    assert.equal((after.files as unknown[]).length, 1);
  });

  it("syncInfo cache: failures are never cached; ttl 0 disables caching", async () => {
    const failing = fakeFetch([
      { status: 500, json: { error: "boom" } },
      { status: 200, json: { node: { id: "N1" }, remote_name: "r", files: [] } },
    ]);
    const c1 = createHttpCentralClient({ ...BASE, fetchImpl: failing.fetchImpl, syncInfoTtlMs: 60_000 });
    await assert.rejects(() => c1.syncInfo("N1"));
    const ok = await c1.syncInfo("N1");
    assert.equal(ok.remote_name, "r");
    assert.equal(failing.calls.length, 2);

    const uncached = fakeFetch([
      { status: 200, json: { node: { id: "N1" }, remote_name: "r", files: [] } },
    ]);
    const c2 = createHttpCentralClient({ ...BASE, fetchImpl: uncached.fetchImpl, syncInfoTtlMs: 0 });
    await c2.syncInfo("N1");
    await c2.syncInfo("N1");
    assert.equal(uncached.calls.length, 2);
  });

  it("syncInfoBatch posts node_ids and seeds the cache", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        status: 200,
        json: { infos: [{ node: { id: "N1" }, remote_name: "r", files: [] }, { node: { id: "N2" }, remote_name: "r", files: [] }] },
      },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl, syncInfoTtlMs: 60_000 });
    const infos = await c.syncInfoBatch(["N1", "N2"]);
    assert.equal(infos.length, 2);
    // Seeded cache -- no extra fetches for the same nodes.
    await c.syncInfo("N1");
    await c.syncInfo("N2");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.com/sync/info-batch");
    assert.deepEqual(JSON.parse(calls[0].body ?? ""), { node_ids: ["N1", "N2"] });
  });

  it("registerFiles posts the batch and putFileRaw carries preconditions", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 201, json: { files: [{ id: "F1" }, { id: "F2" }] } },
      { status: 200, json: { version: "v", canonical_hash: "h" } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const regs = await c.registerFiles("N1", ["wip/a.md", "wip/b.md"]);
    assert.equal(regs.length, 2);
    await c.putFileRaw("N1", "wip/a.md", Buffer.from("x"), {
      baseCanonicalHash: "abc",
      ifAbsent: true,
    });
    const putBody = JSON.parse(calls[1].body ?? "");
    assert.equal(putBody.baseCanonicalHash, "abc");
    assert.equal(putBody.ifAbsent, true);
  });

  it("request retries once on a network failure (GH #80)", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return {
        status: 200,
        json: async () => ({ node: { id: "N1" }, remote_name: "r", files: [] }),
      } as Response;
    }) as typeof fetch;
    const c = createHttpCentralClient({ ...BASE, fetchImpl, syncInfoTtlMs: 0 });
    const info = await c.syncInfo("N1");
    assert.equal(info.remote_name, "r");
    assert.equal(attempts, 2);
  });

  it("request does NOT retry on an HTTP error status", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 500, json: { error: "boom" } }]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl, syncInfoTtlMs: 0 });
    await assert.rejects(
      () => c.syncInfo("N1"),
      (e: unknown) => e instanceof CentralHttpError && e.status === 500,
    );
    assert.equal(calls.length, 1);
  });

  it("a hung request is aborted by the timeout and retried on a fresh call (GH #80)", async () => {
    // AbortSignal.timeout timers are unref'd; a REF'd timer keeps the event
    // loop alive until they fire (on Node 20 the loop otherwise drains and
    // the runner reports a still-pending promise).
    const keepAlive = setTimeout(() => undefined, 5_000);
    try {
      let attempts = 0;
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        attempts += 1;
        if (attempts === 1) {
          // Simulate the zombie keep-alive slot: never settles on its own,
          // rejects only when the timeout signal aborts it.
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        return {
          status: 201,
          json: async () => ({ id: "F1", filename: "a.md", remote_name: "r", remote_path: "p" }),
        } as Response;
      }) as typeof fetch;
      const c = createHttpCentralClient({ ...BASE, fetchImpl, requestTimeoutMs: 30 });
      const r = await c.registerFile("N1", "wip/a.md");
      assert.equal(r.id, "F1");
      assert.equal(attempts, 2);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it("two hung attempts surface as a rejection, not a silent hang", async () => {
    const keepAlive = setTimeout(() => undefined, 5_000);
    try {
      const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }) as typeof fetch;
      const c = createHttpCentralClient({ ...BASE, fetchImpl, requestTimeoutMs: 20 });
      await assert.rejects(() => c.registerFile("N1", "wip/a.md"));
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it("nodeExists maps 200/404 and throws on other statuses", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, json: {} },
      { status: 404, json: { error: "nope" } },
      { status: 500, json: { error: "boom" } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    assert.equal(await c.nodeExists("A"), true);
    assert.equal(await c.nodeExists("B"), false);
    await assert.rejects(
      () => c.nodeExists("C"),
      (e: unknown) => e instanceof CentralHttpError && e.status === 500,
    );
  });

  it("nodeOrganizationId reads the outgoing belongs_to edge off node detail", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        status: 200,
        json: {
          edges: [
            // An incoming belongs_to (something belongs to THIS node) and a
            // non-organization peer are both the wrong edge.
            { relation: "belongs_to", direction: "incoming", peer_id: "NX", peer_type: "organization" },
            { relation: "belongs_to", direction: "outgoing", peer_id: "NY", peer_type: "project" },
            { relation: "belongs_to", direction: "outgoing", peer_id: "ORG1", peer_type: "organization" },
          ],
        },
      },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    assert.equal(await c.nodeOrganizationId("N1"), "ORG1");
    assert.equal(calls[0].url, "https://api.example.com/nodes/N1");
  });

  it("nodeOrganizationId is null without a matching edge and on 404", async () => {
    const { fetchImpl } = fakeFetch([
      {
        status: 200,
        json: {
          edges: [{ relation: "supports", direction: "outgoing", peer_id: "ORG1", peer_type: "organization" }],
        },
      },
      { status: 404, json: { error: "nope" } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    assert.equal(await c.nodeOrganizationId("N1"), null);
    assert.equal(await c.nodeOrganizationId("N2"), null);
  });

  it("remoteSweep posts to the right URL and invalidates the sync-info cache", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, json: { node: { id: "N1" }, remote_name: "r", files: [] } },
      {
        status: 200,
        json: {
          adopted: [{ file_id: "F1", filename: "a.md", remote_path: "p/a.md" }],
          deleted_on_remote: [],
          errors: [],
        },
      },
      { status: 200, json: { node: { id: "N1" }, remote_name: "r", files: [{ id: "F1" }] } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl, syncInfoTtlMs: 60_000 });
    await c.syncInfo("N1");
    const result = await c.remoteSweep("N1");
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "https://api.example.com/nodes/N1/sync/remote-sweep");
    assert.deepEqual(result.adopted, [{ file_id: "F1", filename: "a.md", remote_path: "p/a.md" }]);
    const after = await c.syncInfo("N1");
    assert.equal(calls.length, 3); // info, sweep, fresh info -- the sweep must invalidate the cache
    assert.equal((after.files as unknown[]).length, 1);
  });

  it("remoteSweep maps a non-200 status to CentralHttpError", async () => {
    const { fetchImpl } = fakeFetch([{ status: 404, json: { error: "node not found", code: "NOT_FOUND" } }]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    await assert.rejects(
      () => c.remoteSweep("N1"),
      (e: unknown) => e instanceof CentralHttpError && e.status === 404 && e.code === "NOT_FOUND",
    );
  });

  // Session/runner record half (#323).
  it("getSessionRecord returns null on 404, the row otherwise", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 404, json: { error: "not found" } }]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    assert.equal(await c.getSessionRecord("S1"), null);
    assert.equal(calls[0].url, "https://api.example.com/sessions/S1");
    assert.equal(calls[0].method, "GET");
  });

  it("createSessionRecord posts to /sessions/record", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: { id: "S1", state: "running" } }]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const row = await c.createSessionRecord({
      node_id: "N1",
      user_id: "U1",
      brief: "go",
      runner: "fake",
      instance_id: null,
      host_id: null,
    });
    assert.equal(row.id, "S1");
    assert.equal(calls[0].url, "https://api.example.com/sessions/record");
    assert.equal(calls[0].method, "POST");
  });

  it("createDraftSessionRecord posts the draft shape to the same route", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: { id: "S2", state: "draft" } }]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const row = await c.createDraftSessionRecord({ node_id: "N1", user_id: "U1", model: "sonnet", runner: "claude" });
    assert.equal(row.state, "draft");
    assert.equal(calls[0].url, "https://api.example.com/sessions/record");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0].body)), {
      draft: true,
      node_id: "N1",
      model: "sonnet",
      effort: null,
      runner: "claude",
      instance_id: null,
    });
  });

  it("patchSessionRecord PATCHes /sessions/:id", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, json: { id: "S1", state: "suspended" } }]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const row = await c.patchSessionRecord("S1", { state: "suspended" });
    assert.equal(row.state, "suspended");
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls[0].url, "https://api.example.com/sessions/S1");
  });

  it("createSessionRun posts to /sessions/:id/runs and unwraps { run }", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 201, json: { run: { id: "R1", session_id: "S1", runner: "fake" } } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const run = await c.createSessionRun({ session_id: "S1", runner: "fake", instance_id: null, host_id: null });
    assert.equal(run.id, "R1");
    assert.equal(calls[0].url, "https://api.example.com/sessions/S1/runs");
    assert.equal(calls[0].method, "POST");
  });

  it("patchSessionRun PATCHes /sessions/:id/runs/:run_id and unwraps { run }", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, json: { run: { id: "R1", session_id: "S1", ended_at: "t", end_reason: "completed" } } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const run = await c.patchSessionRun("S1", "R1", { ended_at: "t", end_reason: "completed" });
    assert.equal(run.end_reason, "completed");
    assert.equal(calls[0].url, "https://api.example.com/sessions/S1/runs/R1");
    assert.equal(calls[0].method, "PATCH");
  });

  it("listSessionRuns GETs /sessions/:id/runs and unwraps { runs }", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, json: { runs: [{ id: "R1" }, { id: "R2" }] } }]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const runs = await c.listSessionRuns("S1");
    assert.equal(runs.length, 2);
    assert.equal(calls[0].url, "https://api.example.com/sessions/S1/runs");
    assert.equal(calls[0].method, "GET");
  });

  it("appendSessionEvents posts run_id + events and returns the assigned seqs", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, json: { seqs: [1, 2] } }]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const events = [
      { kind: "user_message", payload: { text: "hi", source: "chat" } },
      { kind: "assistant_message", payload: { text: "hello" } },
    ];
    const seqs = await c.appendSessionEvents("S1", "R1", events as never);
    assert.deepEqual(seqs, [1, 2]);
    assert.equal(calls[0].url, "https://api.example.com/sessions/S1/events");
    assert.deepEqual(JSON.parse(calls[0].body ?? ""), { run_id: "R1", events });
  });

  it("listSessionEvents GETs /sessions/:id/events with after/limit and re-stringifies the payload", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        status: 200,
        json: { events: [{ id: "E1", session_id: "S1", run_id: "R1", seq: 3, kind: "assistant_message", payload: { text: "hi" }, created_at: "t" }] },
      },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const events = await c.listSessionEvents("S1", { after: 2, limit: 50 });
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 3);
    assert.deepEqual(JSON.parse(events[0].payload), { text: "hi" });
    assert.equal(calls[0].url, "https://api.example.com/sessions/S1/events?after=2&limit=50");
  });

  it("orientation GETs /nodes/:id/orientation and returns null on 404 or a null orientation", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, json: { orientation: { node: { name: "N", type: "project" } } } },
    ]);
    const c = createHttpCentralClient({ ...BASE, fetchImpl });
    const o = await c.orientation("N1");
    assert.equal((o as { node: { name: string } }).node.name, "N");
    assert.equal(calls[0].url, "https://api.example.com/nodes/N1/orientation");

    const { fetchImpl: fetchImpl404 } = fakeFetch([{ status: 404, json: { error: "not found" } }]);
    const c2 = createHttpCentralClient({ ...BASE, fetchImpl: fetchImpl404 });
    assert.equal(await c2.orientation("missing"), null);
  });
});
