// REST tests for user listing + invite (Task 6): GET /auth/users (manage,
// ACL picker shape), GET /auth/users/admin (admin, invited + global_scope),
// POST /auth/users/invite (admin, 201/409). Same harness as api-access.test.ts:
// routeApiRequest with a lightweight mock req/res and RequestIdentity objects
// constructed directly, plus setIdentityContextForTesting for a fake adapter.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { createClient as createDbClient, type Client as DbClient } from "@libsql/client";
import { ensureSchemaOn } from "../apps/server/infra/schema.js";
import { setDbForTesting } from "../apps/server/infra/db.js";
import { resetLocalDbForTests } from "../apps/server/domain/sync/local-db.js";
import { routeApiRequest } from "../apps/server/api/router.js";
import type { RequestIdentity, IdentityContext } from "../apps/server/auth/request-identity.js";
import type { IdentityAdapter } from "../apps/server/auth/adapter.js";
import {
  setIdentityContextForTesting,
  resetIdentityContextForTesting,
} from "../apps/server/http/middleware.js";
import { upsertUserFromIdentity, inviteUser, UserExistsError } from "../apps/server/auth/users.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const SOLO = "01SOLO0000000000000000000";

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function makeTestDb() {
  const db = createDbClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  return db;
}

// Simulates the race in inviteUser's SELECT-then-INSERT: wraps a real db
// client and, right when inviteUser's own INSERT for `raceEmail` is about to
// run, sneaks in a direct INSERT of the same email first -- as if a second
// concurrent inviteUser call for that email had already won. inviteUser's
// pre-check SELECT still runs first and sees no row (deterministic, no
// actual concurrency needed); by the time its INSERT fires, the row exists,
// so libsql's UNIQUE constraint on users.email fires for real.
function makeRacyDbForConcurrentInsert(realDb: DbClient, raceEmail: string): DbClient {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (arg: unknown) => {
          const sql = typeof arg === "string" ? arg : (arg as { sql: string }).sql;
          const args = typeof arg === "string" ? undefined : (arg as { args?: unknown[] }).args;
          if (
            sql.startsWith("INSERT INTO users") &&
            Array.isArray(args) &&
            args.includes(raceEmail)
          ) {
            await target.execute({
              sql: "INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime('now'))",
              args: [`racer-${raceEmail}`, raceEmail, "racer"],
            });
          }
          return target.execute(arg as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as DbClient;
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

function makeAdmin(): RequestIdentity {
  return {
    userId: SOLO,
    email: "admin@x.com",
    name: "Admin",
    globalScope: "admin",
    groups: [],
    groupIds: [],
    via: "env",
  };
}

function makeManager(): RequestIdentity {
  return {
    userId: SOLO,
    email: "manager@x.com",
    name: "Manager",
    globalScope: "manage",
    groups: [],
    groupIds: [],
    via: "env",
  };
}

// ---------------------------------------------------------------------------
// Minimal mock req/res for routeApiRequest
// ---------------------------------------------------------------------------

interface MockResponse {
  statusCode: number;
  body: string;
}

function makeMockReqRes(
  method: string,
  pathname: string,
  bodyJson?: unknown,
): { req: IncomingMessage; res: ServerResponse; captured: MockResponse } {
  const captured: MockResponse = { statusCode: 0, body: "" };

  const bodyStr = bodyJson !== undefined ? JSON.stringify(bodyJson) : "";
  const req = new Readable({
    read() {
      if (bodyStr) this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  }) as unknown as IncomingMessage;
  req.method = method;
  req.url = pathname;
  req.headers = bodyJson !== undefined ? { "content-type": "application/json" } : {};

  const res = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      captured.body += chunk.toString();
      cb();
    },
  }) as unknown as ServerResponse;
  (res as unknown as { writeHead: (code: number, hdrs?: Record<string, string>) => void }).writeHead =
    (code: number) => {
      captured.statusCode = code;
    };
  (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
    if (data) captured.body += data;
  };

  return { req, res, captured };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe("Users: listing + invite (Task 6)", () => {
  let db: DbClient;
  let workspace: string;

  function makeCtxWithAdapter(adapter: IdentityAdapter): IdentityContext {
    return {
      db,
      mode: "google",
      jwtSecret: "test-secret-at-least-32-characters-long",
      adapter,
      soloUserId: SOLO,
    };
  }

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), "portuni-api-users-admin-"));
    process.env.PORTUNI_WORKSPACE_ROOT = workspace;
    resetLocalDbForTests();

    db = await makeTestDb();
    setDbForTesting(db);

    const fakeAdapter: IdentityAdapter = {
      verify: async () => ({ email: "admin@x.com", name: "Admin", sub: "env:admin@x.com" }),
      resolveAccess: async (email: string) => ({
        globalScope: "admin",
        groups: [],
        groupIds: [`scope-for-${email}`],
      }),
    };
    setIdentityContextForTesting(makeCtxWithAdapter(fakeAdapter));
  });

  after(async () => {
    resetIdentityContextForTesting();
    setDbForTesting(null);
    resetLocalDbForTests();
    await rm(workspace, { recursive: true, force: true });
  });

  // 1. POST /auth/users/invite -> 201, row inserted with google_sub NULL, audit logged.
  test("1. POST /auth/users/invite -> 201, google_sub NULL, audit row", async () => {
    const admin = makeAdmin();
    const { req, res, captured } = makeMockReqRes("POST", "/auth/users/invite", {
      email: "New.User@Example.com",
    });
    await routeApiRequest(req, res, new URL("http://localhost/auth/users/invite"), admin);

    assert.equal(captured.statusCode, 201, `expected 201, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.email, "new.user@example.com");
    assert.equal(parsed.name, "new.user");
    assert.ok(parsed.id, "expected an id in the response");

    const row = await db.execute({
      sql: "SELECT google_sub FROM users WHERE id = ?",
      args: [parsed.id],
    });
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].google_sub, null);

    const auditRows = await db.execute({
      sql: "SELECT action FROM audit_log WHERE target_id = ? AND action = 'user.invite'",
      args: [parsed.id],
    });
    assert.equal(auditRows.rows.length, 1, "expected exactly one user.invite audit row");
  });

  // 2. Duplicate invite (same email) -> 409, no second row.
  test("2. duplicate invite -> 409", async () => {
    const admin = makeAdmin();
    const { req, res, captured } = makeMockReqRes("POST", "/auth/users/invite", {
      email: "new.user@example.com",
    });
    await routeApiRequest(req, res, new URL("http://localhost/auth/users/invite"), admin);

    assert.equal(captured.statusCode, 409, `expected 409, got ${captured.statusCode}; body: ${captured.body}`);

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM users WHERE email = ?",
      args: ["new.user@example.com"],
    });
    assert.equal(rows.rows[0].cnt, 1);
  });

  // 2b. Concurrent invite race: pre-check SELECT passes for both callers,
  // but the second INSERT hits users.email's UNIQUE constraint. inviteUser
  // must map that into the same UserExistsError as the fast-path duplicate
  // check, not let the raw libsql constraint error escape.
  test("2b. inviteUser race on INSERT -> UserExistsError, no generic throw", async () => {
    const raceEmail = "race@example.com";
    const racyDb = makeRacyDbForConcurrentInsert(db, raceEmail);

    await assert.rejects(
      () => inviteUser(racyDb, raceEmail),
      (err: unknown) => {
        assert.ok(err instanceof UserExistsError, `expected UserExistsError, got ${err}`);
        assert.equal((err as UserExistsError).email, raceEmail);
        return true;
      },
    );

    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS cnt FROM users WHERE email = ?",
      args: [raceEmail],
    });
    assert.equal(rows.rows[0].cnt, 1, "only the racer's row should exist, not inviteUser's");
  });

  // 2c. Same race, but at the HTTP layer: the handler's catch only maps
  // UserExistsError to 409, so this pins that the race resolves to 409, not
  // the generic 500 (or the middleware's raw SQLITE_CONSTRAINT 409) the
  // review flagged as the risk before this fix.
  test("2c. POST /auth/users/invite race on INSERT -> 409, not 500", async () => {
    const raceEmail = "race-http@example.com";
    const racyDb = makeRacyDbForConcurrentInsert(db, raceEmail);
    setDbForTesting(racyDb);
    try {
      const admin = makeAdmin();
      const { req, res, captured } = makeMockReqRes("POST", "/auth/users/invite", {
        email: raceEmail,
      });
      await routeApiRequest(req, res, new URL("http://localhost/auth/users/invite"), admin);

      assert.equal(captured.statusCode, 409, `expected 409, got ${captured.statusCode}; body: ${captured.body}`);
    } finally {
      setDbForTesting(db);
    }
  });

  // 3. Login identity with the same email as an invited row pairs by email:
  // fills google_sub, keeps the same id (upsertUserFromIdentity — do not change its logic).
  test("3. upsertUserFromIdentity pairs invited row by email (fills sub, keeps id)", async () => {
    const before = await db.execute({
      sql: "SELECT id FROM users WHERE email = ?",
      args: ["new.user@example.com"],
    });
    assert.equal(before.rows.length, 1);
    const existingId = String(before.rows[0].id);

    const identity = { email: "new.user@example.com", name: "New User", sub: "google-sub-123" };
    const returnedId = await upsertUserFromIdentity(db, identity, null);

    assert.equal(returnedId, existingId, "id must not change when pairing an invited row");

    const after = await db.execute({
      sql: "SELECT google_sub, name FROM users WHERE id = ?",
      args: [existingId],
    });
    assert.equal(after.rows[0].google_sub, "google-sub-123");
    assert.equal(after.rows[0].name, "New User");
  });

  // 3b. Case-mismatch pairing: inviteUser stores the invited row lowercase
  // ("Mixed.Case@Example.com" -> "mixed.case@example.com"). upsertUserFromIdentity
  // itself does a plain case-sensitive `email = ?` match with no lowercasing
  // of its own -- it is safe here only because GoogleAdapter.assertAllowedIdentity
  // (apps/server/auth/google-adapter.ts) always lowercases the email before
  // building the Identity it hands to upsertUserFromIdentity. This test pins
  // that invariant: it feeds upsertUserFromIdentity an already-lowercased
  // email (as the adapter guarantees), not the mixed-case one, and asserts it
  // still pairs onto the invited row.
  test("3b. invited mixed-case email pairs with adapter-lowercased login identity", async () => {
    const admin = makeAdmin();
    const { req, res, captured } = makeMockReqRes("POST", "/auth/users/invite", {
      email: "Mixed.Case@Example.com",
    });
    await routeApiRequest(req, res, new URL("http://localhost/auth/users/invite"), admin);
    assert.equal(captured.statusCode, 201, `expected 201, got ${captured.statusCode}; body: ${captured.body}`);
    const invited = JSON.parse(captured.body);
    assert.equal(invited.email, "mixed.case@example.com", "invite stores email lowercased");

    // GoogleAdapter.assertAllowedIdentity guarantees this is already lowercase
    // (payload.email.toLowerCase()) by the time upsertUserFromIdentity sees it.
    const identity = {
      email: "mixed.case@example.com",
      name: "Mixed Case",
      sub: "google-sub-mixed-case",
    };
    const returnedId = await upsertUserFromIdentity(db, identity, null);

    assert.equal(returnedId, invited.id, "must pair onto the invited row, not create a new one");

    const row = await db.execute({
      sql: "SELECT google_sub, id FROM users WHERE email = ?",
      args: ["mixed.case@example.com"],
    });
    assert.equal(row.rows.length, 1, "no duplicate row for the same (lowercased) email");
    assert.equal(row.rows[0].google_sub, "google-sub-mixed-case");
    assert.equal(row.rows[0].id, invited.id);
  });

  // 4. manage identity on /auth/users/admin -> 403 (min-scope gate, admin-only route).
  test("4. manage identity on GET /auth/users/admin -> 403", async () => {
    const manager = makeManager();
    const { req, res, captured } = makeMockReqRes("GET", "/auth/users/admin");
    await routeApiRequest(req, res, new URL("http://localhost/auth/users/admin"), manager);

    assert.equal(captured.statusCode, 403, `expected 403, got ${captured.statusCode}; body: ${captured.body}`);
  });

  // 5. admin sees invited=true for a still-invited row (never logged in), and
  // invited=false plus global_scope (from resolveAccess) for the paired one.
  test("5. GET /auth/users/admin (admin) -> invited flags + global_scope", async () => {
    const admin = makeAdmin();
    const { req: inviteReq, res: inviteRes, captured: inviteCaptured } = makeMockReqRes(
      "POST",
      "/auth/users/invite",
      { email: "still.invited@example.com" },
    );
    await routeApiRequest(
      inviteReq,
      inviteRes,
      new URL("http://localhost/auth/users/invite"),
      admin,
    );
    assert.equal(inviteCaptured.statusCode, 201);

    const { req, res, captured } = makeMockReqRes("GET", "/auth/users/admin");
    await routeApiRequest(req, res, new URL("http://localhost/auth/users/admin"), admin);

    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.ok(Array.isArray(parsed.users));

    const stillInvited = parsed.users.find((u: { email: string }) => u.email === "still.invited@example.com");
    assert.ok(stillInvited, "expected the still-invited row");
    assert.equal(stillInvited.invited, true);
    assert.equal(stillInvited.global_scope, "admin");

    const paired = parsed.users.find((u: { email: string }) => u.email === "new.user@example.com");
    assert.ok(paired, "expected the paired row");
    assert.equal(paired.invited, false);
    assert.equal(paired.global_scope, "admin");
  });

  // 6. GET /auth/users (manage) -> ACL picker shape, no admin-only fields.
  test("6. GET /auth/users (manage) -> picker shape", async () => {
    const manager = makeManager();
    const { req, res, captured } = makeMockReqRes("GET", "/auth/users");
    await routeApiRequest(req, res, new URL("http://localhost/auth/users"), manager);

    assert.equal(captured.statusCode, 200, `expected 200, got ${captured.statusCode}; body: ${captured.body}`);
    const parsed = JSON.parse(captured.body);
    assert.ok(Array.isArray(parsed.users));
    assert.ok(parsed.users.length > 0);
    for (const u of parsed.users) {
      assert.ok("id" in u);
      assert.ok("name" in u);
      assert.ok("email" in u);
      assert.ok("avatar_url" in u);
      assert.ok(!("invited" in u), "picker shape must not leak admin-only fields");
      assert.ok(!("global_scope" in u), "picker shape must not leak admin-only fields");
    }
  });
});
