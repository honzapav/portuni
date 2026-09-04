import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { ensureSchemaOn, repairSchemaOn } from "../apps/server/infra/schema.js";

// ensureSchemaOn used to replay all 56 CREATE ... IF NOT EXISTS statements and
// then check every migration marker with its own SELECT, on every boot — 91
// calls against a database that was already at the current schema version.
// It now takes a version fast path, which is only safe if the conditions
// below hold exactly.

function counting(db: Client): { db: Client; calls: () => number; reset: () => void } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (p === "execute" || p === "batch") {
        return async (...a: unknown[]) => {
          n += 1;
          return (v as (...args: unknown[]) => unknown).apply(t, a);
        };
      }
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Client;
  return { db: proxy, calls: () => n, reset: () => { n = 0; } };
}

async function tableExists(db: Client, name: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    args: [name],
  });
  return r.rows.length > 0;
}

describe("ensureSchemaOn version fast path", () => {
  it("skips the DDL replay once every migration and the DDL fingerprint are recorded", async () => {
    const raw = createClient({ url: ":memory:" });
    const c = counting(raw);
    await ensureSchemaOn(c.db);
    c.reset();
    await ensureSchemaOn(c.db);
    // PRAGMA foreign_keys, the applied-migration read, and seedSoloUser.
    assert.equal(c.calls(), 3);
    raw.close();
  });

  it("still seeds the solo user on the fast path", async () => {
    const raw = createClient({ url: ":memory:" });
    await ensureSchemaOn(raw);
    await raw.execute("DELETE FROM users");
    await ensureSchemaOn(raw);
    const r = await raw.execute("SELECT id FROM users");
    assert.equal(r.rows.length, 1);
    raw.close();
  });

  it("does NOT silently recreate a dropped object — that is what repair is for", async () => {
    const raw = createClient({ url: ":memory:" });
    await ensureSchemaOn(raw);
    await raw.execute("DROP TABLE tools");

    await ensureSchemaOn(raw);
    assert.equal(await tableExists(raw, "tools"), false);

    await repairSchemaOn(raw);
    assert.equal(await tableExists(raw, "tools"), true);
    raw.close();
  });

  it("honours PORTUNI_SCHEMA_REPAIR=1 as the env equivalent of repairSchemaOn", async () => {
    const raw = createClient({ url: ":memory:" });
    await ensureSchemaOn(raw);
    await raw.execute("DROP TABLE tools");
    const prev = process.env.PORTUNI_SCHEMA_REPAIR;
    process.env.PORTUNI_SCHEMA_REPAIR = "1";
    try {
      await ensureSchemaOn(raw);
    } finally {
      if (prev === undefined) delete process.env.PORTUNI_SCHEMA_REPAIR;
      else process.env.PORTUNI_SCHEMA_REPAIR = prev;
    }
    assert.equal(await tableExists(raw, "tools"), true);
    raw.close();
  });

  it("takes the full path when the migrations table is missing", async () => {
    const raw = createClient({ url: ":memory:" });
    await ensureSchemaOn(raw);
    await raw.execute("DROP TABLE migrations");
    const c = counting(raw);
    c.reset();
    await ensureSchemaOn(c.db);
    assert.ok(c.calls() > 50, `expected a full replay, got ${c.calls()} calls`);
    raw.close();
  });

  it("replays once after the DDL set changes, then settles back", async () => {
    const raw = createClient({ url: ":memory:" });
    await ensureSchemaOn(raw);
    // Standing in for an edit to DDL: the recorded fingerprint no longer
    // matches what this build carries.
    await raw.execute("DELETE FROM migrations WHERE id LIKE 'ddl:%'");

    const c = counting(raw);
    c.reset();
    await ensureSchemaOn(c.db);
    const afterChange = c.calls();
    c.reset();
    await ensureSchemaOn(c.db);
    const nextBoot = c.calls();

    assert.ok(afterChange > 50, `expected a replay, got ${afterChange} calls`);
    assert.equal(nextBoot, 3);
    raw.close();
  });

  it("records exactly one DDL fingerprint row", async () => {
    const raw = createClient({ url: ":memory:" });
    await ensureSchemaOn(raw);
    await ensureSchemaOn(raw);
    await repairSchemaOn(raw);
    const r = await raw.execute("SELECT id FROM migrations WHERE id LIKE 'ddl:%'");
    assert.equal(r.rows.length, 1);
    raw.close();
  });
});
