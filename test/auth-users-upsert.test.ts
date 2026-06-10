import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import { upsertUserFromIdentity } from "../src/auth/users.js";

test("existing user matched by email is enriched, id preserved", async () => {
  const { db } = await makeSharedDb();
  // SOLO_USER seed exists with email solo@localhost (ensureSchemaOn).
  const userId = await upsertUserFromIdentity(
    db,
    {
      email: "solo@localhost",
      name: "Honza Pav",
      sub: "google-sub-123",
    },
    "https://avatar.example/a.png"
  );
  assert.equal(userId, "01SOLO0000000000000000000");
  const r = await db.execute({
    sql: "SELECT google_sub, avatar_url, last_login_at, name FROM users WHERE id = ?",
    args: [userId],
  });
  assert.equal(r.rows[0].google_sub, "google-sub-123");
  assert.equal(r.rows[0].avatar_url, "https://avatar.example/a.png");
  assert.ok(r.rows[0].last_login_at);
});

test("second login matches by google_sub even if email changed", async () => {
  const { db } = await makeSharedDb();
  const first = await upsertUserFromIdentity(
    db,
    {
      email: "a@x.com",
      name: "A",
      sub: "sub-A",
    },
    null
  );
  const second = await upsertUserFromIdentity(
    db,
    {
      email: "a-renamed@x.com",
      name: "A",
      sub: "sub-A",
    },
    null
  );
  assert.equal(first, second);
});

test("unknown identity creates a new user", async () => {
  const { db } = await makeSharedDb();
  const userId = await upsertUserFromIdentity(
    db,
    {
      email: "new@x.com",
      name: "New",
      sub: "sub-new",
    },
    null
  );
  const r = await db.execute({
    sql: "SELECT email, name, google_sub FROM users WHERE id = ?",
    args: [userId],
  });
  assert.equal(r.rows[0].email, "new@x.com");
  assert.equal(r.rows[0].name, "New");
  assert.equal(r.rows[0].google_sub, "sub-new");
});

test("sub-match login does not crash when another row owns the email", async () => {
  const { db } = await makeSharedDb();
  const a = await upsertUserFromIdentity(db, { email: "a@x.com", name: "A", sub: "sub-A" }, null);
  await upsertUserFromIdentity(db, { email: "b@x.com", name: "B", sub: "sub-B" }, null);
  // user A's Google account email changes to b@x.com (owned by B's row)
  const again = await upsertUserFromIdentity(db, { email: "b@x.com", name: "A", sub: "sub-A" }, null);
  assert.equal(again, a);
  const r = await db.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [a] });
  assert.equal(r.rows[0].email, "a@x.com", "old email kept, no constraint crash");
});
