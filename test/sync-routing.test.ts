import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import {
  DDL_REMOTES_TABLE,
  DDL_REMOTE_ROUTING_TABLE,
  INDEX_REMOTE_ROUTING_PRIORITY,
} from "../src/infra/schema.js";
import {
  upsertRemote,
  getRemote,
  listRemotes,
  deleteRemote,
  addRule,
  listRules,
  replaceRules,
  resolveRemote,
} from "../src/domain/sync/routing.js";

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.execute(DDL_REMOTES_TABLE);
  await db.execute(DDL_REMOTE_ROUTING_TABLE);
  await db.execute(INDEX_REMOTE_ROUTING_PRIORITY);
  await db.execute("PRAGMA foreign_keys = ON");
  return db;
}

describe("routing -- remotes CRUD", () => {
  it("upsertRemote creates a row; re-upsert updates", async () => {
    const db = await freshDb();
    await upsertRemote(db, {
      name: "main",
      type: "fs",
      config: { root: "/tmp/a" },
      created_by: "U1",
    });
    let r = await getRemote(db, "main");
    assert.ok(r);
    assert.equal(r.type, "fs");
    assert.deepEqual(r.config, { root: "/tmp/a" });

    await upsertRemote(db, {
      name: "main",
      type: "s3",
      config: { bucket: "b" },
      created_by: "U1",
    });
    r = await getRemote(db, "main");
    assert.ok(r);
    assert.equal(r.type, "s3");
    assert.deepEqual(r.config, { bucket: "b" });
  });

  it("getRemote returns null for missing name", async () => {
    const db = await freshDb();
    assert.equal(await getRemote(db, "nope"), null);
  });

  it("listRemotes returns all by name asc", async () => {
    const db = await freshDb();
    await upsertRemote(db, { name: "z", type: "fs", config: { root: "/z" }, created_by: "U" });
    await upsertRemote(db, { name: "a", type: "fs", config: { root: "/a" }, created_by: "U" });
    const all = await listRemotes(db);
    assert.deepEqual(
      all.map((r) => r.name),
      ["a", "z"],
    );
  });

  it("deleteRemote removes the row", async () => {
    const db = await freshDb();
    await upsertRemote(db, { name: "x", type: "fs", config: {}, created_by: "U" });
    await deleteRemote(db, "x");
    assert.equal(await getRemote(db, "x"), null);
  });
});

describe("routing -- rules CRUD", () => {
  async function dbWithRemote(): Promise<Client> {
    const db = await freshDb();
    await upsertRemote(db, { name: "fallback", type: "fs", config: {}, created_by: "U" });
    return db;
  }

  it("addRule inserts a rule, listRules orders by priority then id", async () => {
    const db = await dbWithRemote();
    await upsertRemote(db, { name: "r2", type: "fs", config: {}, created_by: "U" });
    await addRule(db, { priority: 20, node_type: null, org_slug: null, remote_name: "fallback" });
    await addRule(db, { priority: 5, node_type: "project", org_slug: null, remote_name: "r2" });
    await addRule(db, { priority: 5, node_type: null, org_slug: "workflow", remote_name: "fallback" });
    const rules = await listRules(db);
    assert.equal(rules.length, 3);
    // priority 5 rules come first, in insertion (id) order
    assert.equal(rules[0].priority, 5);
    assert.equal(rules[0].node_type, "project");
    assert.equal(rules[1].priority, 5);
    assert.equal(rules[1].org_slug, "workflow");
    assert.equal(rules[2].priority, 20);
  });

  it("replaceRules atomically clears + reinserts", async () => {
    const db = await dbWithRemote();
    await addRule(db, { priority: 10, node_type: null, org_slug: null, remote_name: "fallback" });
    await replaceRules(db, [
      { priority: 1, node_type: "project", org_slug: "w", remote_name: "fallback" },
      { priority: 2, node_type: null, org_slug: null, remote_name: "fallback" },
    ]);
    const rules = await listRules(db);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].priority, 1);
    assert.equal(rules[0].node_type, "project");
    assert.equal(rules[1].priority, 2);
  });
});

describe("routing -- resolveRemote", () => {
  async function dbWithRemotes(): Promise<Client> {
    const db = await freshDb();
    await upsertRemote(db, { name: "fallback", type: "fs", config: {}, created_by: "U" });
    await upsertRemote(db, { name: "specific", type: "fs", config: {}, created_by: "U" });
    return db;
  }

  it("returns null when no rules exist", async () => {
    const db = await dbWithRemotes();
    assert.equal(await resolveRemote(db, "project", "workflow"), null);
  });

  it("wildcard rule (null/null) matches any call", async () => {
    const db = await dbWithRemotes();
    await addRule(db, {
      priority: 10,
      node_type: null,
      org_slug: null,
      remote_name: "fallback",
    });
    assert.equal(await resolveRemote(db, "project", "workflow"), "fallback");
    assert.equal(await resolveRemote(db, "process", null), "fallback");
    assert.equal(await resolveRemote(db, "anything", "anyorg"), "fallback");
  });

  it("priority-ordered rule wins (lower priority number first)", async () => {
    const db = await dbWithRemotes();
    await addRule(db, {
      priority: 20,
      node_type: null,
      org_slug: null,
      remote_name: "fallback",
    });
    await addRule(db, {
      priority: 5,
      node_type: "project",
      org_slug: "workflow",
      remote_name: "specific",
    });
    assert.equal(
      await resolveRemote(db, "project", "workflow"),
      "specific",
      "more specific lower-priority wins",
    );
    assert.equal(
      await resolveRemote(db, "process", "workflow"),
      "fallback",
      "specific does not match; fallback wins",
    );
  });

  it("non-null filter does not match wildcard call (org_slug = null)", async () => {
    // A rule with org_slug='workflow' must NOT match a call with orgSlug=null.
    const db = await dbWithRemotes();
    await addRule(db, {
      priority: 5,
      node_type: null,
      org_slug: "workflow",
      remote_name: "specific",
    });
    assert.equal(await resolveRemote(db, "project", null), null);
    assert.equal(await resolveRemote(db, "project", "workflow"), "specific");
  });
});
