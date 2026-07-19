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
});
