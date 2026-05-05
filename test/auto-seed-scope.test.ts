// Tests for the auto-seed scope mechanism: when an MCP client connects with
// a `?home_node_id=<id>` query param on the URL, the server seeds the
// session scope with that home node + its depth-1 neighbors automatically.
// No explicit portuni_session_init call required — works for any MCP client
// that connects to the URL Portuni's per-mirror config provides.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { SessionScope } from "../src/mcp/scope.js";
import {
  parseHomeNodeIdFromUrl,
  autoSeedFromHome,
} from "../src/mcp/auto-seed.js";

async function freshGraph() {
  const db = createClient({ url: ":memory:" });
  await db.execute(
    `CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, owner_id TEXT, visibility TEXT, meta TEXT)`,
  );
  await db.execute(
    `CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT, relation TEXT)`,
  );
  await db.execute(`INSERT INTO nodes VALUES ('HOME','project','Home',NULL,'team',NULL)`);
  await db.execute(`INSERT INTO nodes VALUES ('NEIGHBOR','process','N',NULL,'team',NULL)`);
  await db.execute(`INSERT INTO nodes VALUES ('FAR','area','F',NULL,'team',NULL)`);
  await db.execute(`INSERT INTO edges VALUES ('e1','HOME','NEIGHBOR','related_to')`);
  return db;
}

describe("parseHomeNodeIdFromUrl", () => {
  it("extracts home_node_id from the query string", () => {
    assert.equal(
      parseHomeNodeIdFromUrl("/mcp?home_node_id=01KQ9CH1AXZ76AQSHKWDJFBJG8"),
      "01KQ9CH1AXZ76AQSHKWDJFBJG8",
    );
  });

  it("works with an absolute URL", () => {
    assert.equal(
      parseHomeNodeIdFromUrl(
        "http://localhost:4011/mcp?home_node_id=01KQ9CH1AXZ76AQSHKWDJFBJG8",
      ),
      "01KQ9CH1AXZ76AQSHKWDJFBJG8",
    );
  });

  it("returns null when the query param is missing", () => {
    assert.equal(parseHomeNodeIdFromUrl("/mcp"), null);
    assert.equal(parseHomeNodeIdFromUrl("/mcp?other=value"), null);
  });

  it("returns null on empty string param", () => {
    assert.equal(parseHomeNodeIdFromUrl("/mcp?home_node_id="), null);
    assert.equal(parseHomeNodeIdFromUrl("/mcp?home_node_id=   "), null);
  });

  it("returns null on malformed url", () => {
    assert.equal(parseHomeNodeIdFromUrl(""), null);
    assert.equal(parseHomeNodeIdFromUrl(undefined), null);
    assert.equal(parseHomeNodeIdFromUrl(null), null);
  });

  it("ignores extra query params", () => {
    assert.equal(
      parseHomeNodeIdFromUrl("/mcp?foo=bar&home_node_id=ABC&baz=qux"),
      "ABC",
    );
  });
});

describe("autoSeedFromHome", () => {
  it("seeds the home node + depth-1 neighbors when called with a valid id", async () => {
    const db = await freshGraph();
    const scope = new SessionScope("strict");
    const audits: { action: string; targetId: string; detail: Record<string, unknown> }[] = [];
    const auditFn = async (action: string, targetId: string, detail: Record<string, unknown>) => {
      audits.push({ action, targetId, detail });
    };

    const result = await autoSeedFromHome({
      scope,
      homeNodeId: "HOME",
      db,
      auditFn,
    });

    assert.equal(result.seeded, true);
    assert.deepEqual(result.nodeIds.sort(), ["HOME", "NEIGHBOR"].sort());
    assert.equal(scope.has("HOME"), true);
    assert.equal(scope.has("NEIGHBOR"), true);
    assert.equal(scope.has("FAR"), false);
    assert.equal(scope.homeNodeId, "HOME");
  });

  it("records an audit entry tagged triggered_by=init", async () => {
    const db = await freshGraph();
    const scope = new SessionScope("strict");
    const audits: { action: string; targetId: string; detail: Record<string, unknown> }[] = [];
    const auditFn = async (action: string, targetId: string, detail: Record<string, unknown>) => {
      audits.push({ action, targetId, detail });
    };

    await autoSeedFromHome({ scope, homeNodeId: "HOME", db, auditFn });

    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "session_init");
    assert.equal(audits[0].targetId, "HOME");
    assert.equal(audits[0].detail.triggered_by, "init");
    assert.deepEqual(
      (audits[0].detail.node_ids as string[]).sort(),
      ["HOME", "NEIGHBOR"].sort(),
    );
  });

  it("is a no-op when homeNodeId is null", async () => {
    const db = await freshGraph();
    const scope = new SessionScope("strict");
    const audits: unknown[] = [];
    const auditFn = async () => {
      audits.push("called");
    };

    const result = await autoSeedFromHome({
      scope,
      homeNodeId: null,
      db,
      auditFn,
    });

    assert.equal(result.seeded, false);
    assert.equal(scope.size(), 0);
    assert.equal(scope.homeNodeId, null);
    assert.equal(audits.length, 0);
  });

  it("is a graceful no-op when the node does not exist", async () => {
    const db = await freshGraph();
    const scope = new SessionScope("strict");
    const audits: unknown[] = [];
    const auditFn = async () => {
      audits.push("called");
    };

    const result = await autoSeedFromHome({
      scope,
      homeNodeId: "DOES_NOT_EXIST",
      db,
      auditFn,
    });

    assert.equal(result.seeded, false);
    assert.equal(scope.size(), 0);
    assert.equal(scope.homeNodeId, null);
    // No audit either — silent fallback.
    assert.equal(audits.length, 0);
  });

  it("propagates DB errors so the caller can reject the connection", async () => {
    // When the DB is unreachable (e.g. Turso DNS lookup fails), we want
    // the seed to throw rather than silently succeed with empty scope.
    // The transport then surfaces a 503 to the MCP client so the user
    // sees the real reason instead of "scope_expansion_required" on every
    // subsequent read.
    const scope = new SessionScope("strict");
    const audits: unknown[] = [];
    const auditFn = async () => {
      audits.push("called");
    };
    const brokenDb = {
      execute: async () => {
        throw new Error("getaddrinfo ENOTFOUND turso.example.com");
      },
    } as unknown as Parameters<typeof autoSeedFromHome>[0]["db"];

    await assert.rejects(
      autoSeedFromHome({ scope, homeNodeId: "HOME", db: brokenDb, auditFn }),
      /ENOTFOUND/,
    );

    // Scope was not partially seeded and no audit entry was written.
    assert.equal(scope.size(), 0);
    assert.equal(scope.homeNodeId, null);
    assert.equal(audits.length, 0);
  });

  it("does not double-seed when called twice on the same scope", async () => {
    const db = await freshGraph();
    const scope = new SessionScope("strict");
    const audits: unknown[] = [];
    const auditFn = async () => {
      audits.push("called");
    };

    const first = await autoSeedFromHome({
      scope,
      homeNodeId: "HOME",
      db,
      auditFn,
    });
    const second = await autoSeedFromHome({
      scope,
      homeNodeId: "HOME",
      db,
      auditFn,
    });

    assert.equal(first.seeded, true);
    assert.equal(second.seeded, false);
    // First call audits once; second call is a no-op.
    assert.equal(audits.length, 1);
  });
});
