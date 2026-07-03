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
