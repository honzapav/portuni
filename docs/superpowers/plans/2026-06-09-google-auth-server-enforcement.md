# Google Auth + Server-Side Enforcement Implementation Plan (1/4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user identity (Google OAuth + Workspace Groups) and real server-side access control (global roles + node-level group visibility) in the Portuni backend.

**Architecture:** Pluggable `IdentityAdapter` (EnvAdapter for local dev, GoogleAdapter for production); request identity resolved in HTTP middleware from a Portuni session JWT or a device token; identity threaded through REST handlers and MCP sessions replacing the hardcoded `SOLO_USER`; enforcement in two layers — declarative min-role per tool/route, and node-level `visibility='group'` checks with `belongs_to` inheritance. Spec: `docs/superpowers/specs/2026-06-09-google-groups-auth-design.md`.

**Tech Stack:** Node 20+, TypeScript ESM, libSQL/Turso, `jose` (session JWT), `google-auth-library` (OIDC verify + DWD Directory API), node:test + tsx.

**This is plan 1 of 4.** Follow-ups (separate plans, do NOT start here): VPS deployment, desktop login UI, sync-agent REST migration.

**Conventions used below:**
- Tests run with `npm test` (runs `node --import tsx --test test/*.test.ts`). Single file: `node --import tsx --test test/<file>.test.ts`.
- All new code is TypeScript ESM with `.js` import suffixes (project style).
- In-memory DB fixture: `makeSharedDb()` from `test/helpers/shared-db.ts` (runs full schema + migrations).
- Default behavior must stay identical: `PORTUNI_AUTH_MODE` defaults to `env`, which preserves today's static-token semantics. Existing tests must keep passing after every task.

---

### Task 1: Global roles module

**Files:**
- Create: `src/auth/roles.ts`
- Test: `test/auth-roles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/auth-roles.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveGlobalScope,
  scopeAtLeast,
  groupRoleConfigFromEnv,
} from "../src/auth/roles.js";

test("scopeAtLeast respects ordering read < write < manage < admin", () => {
  assert.equal(scopeAtLeast("admin", "read"), true);
  assert.equal(scopeAtLeast("write", "manage"), false);
  assert.equal(scopeAtLeast("manage", "manage"), true);
  assert.equal(scopeAtLeast("read", "write"), false);
});

test("resolveGlobalScope picks highest matching group, defaults to read", () => {
  const cfg = {
    admin: ["portuni-admins@example.com"],
    manage: ["portuni-managers@example.com"],
    write: ["portuni-team@example.com"],
  };
  assert.equal(resolveGlobalScope([], cfg), "read");
  assert.equal(resolveGlobalScope(["portuni-team@example.com"], cfg), "write");
  assert.equal(
    resolveGlobalScope(
      ["portuni-team@example.com", "portuni-managers@example.com"],
      cfg,
    ),
    "manage",
  );
  assert.equal(
    resolveGlobalScope(["PORTUNI-ADMINS@EXAMPLE.COM"], cfg),
    "admin",
    "matching is case-insensitive",
  );
});

test("groupRoleConfigFromEnv parses comma lists and trims", () => {
  const cfg = groupRoleConfigFromEnv({
    PORTUNI_GROUPS_ADMIN: "a@x.com, b@x.com",
    PORTUNI_GROUPS_MANAGE: "",
    PORTUNI_GROUPS_WRITE: "team@x.com",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.admin, ["a@x.com", "b@x.com"]);
  assert.deepEqual(cfg.manage, []);
  assert.deepEqual(cfg.write, ["team@x.com"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth-roles.test.ts`
Expected: FAIL — cannot find module `src/auth/roles.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/auth/roles.ts
// Global role model. Roles come from Google Workspace group membership
// (or the EnvAdapter, which grants admin). Mapping group-email -> role is
// server configuration (env), not data — see spec §3.

export const GLOBAL_SCOPES = ["read", "write", "manage", "admin"] as const;
export type GlobalScope = (typeof GLOBAL_SCOPES)[number];

const RANK: Record<GlobalScope, number> = { read: 0, write: 1, manage: 2, admin: 3 };

export function scopeAtLeast(actual: GlobalScope, required: GlobalScope): boolean {
  return RANK[actual] >= RANK[required];
}

export interface GroupRoleConfig {
  admin: string[];
  manage: string[];
  write: string[];
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function groupRoleConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GroupRoleConfig {
  return {
    admin: parseList(env.PORTUNI_GROUPS_ADMIN),
    manage: parseList(env.PORTUNI_GROUPS_MANAGE),
    write: parseList(env.PORTUNI_GROUPS_WRITE),
  };
}

// Highest matching group wins; any authenticated user gets at least read.
export function resolveGlobalScope(
  groups: string[],
  cfg: GroupRoleConfig,
): GlobalScope {
  const set = new Set(groups.map((g) => g.toLowerCase()));
  if (cfg.admin.some((g) => set.has(g))) return "admin";
  if (cfg.manage.some((g) => set.has(g))) return "manage";
  if (cfg.write.some((g) => set.has(g))) return "write";
  return "read";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/auth-roles.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/roles.ts test/auth-roles.test.ts
git commit -m "feat(auth): global role model with group-email mapping"
```

---

### Task 2: IdentityAdapter interface + EnvAdapter

**Files:**
- Create: `src/auth/adapter.ts`
- Create: `src/auth/env-adapter.ts`
- Test: `test/auth-env-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/auth-env-adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvAdapter } from "../src/auth/env-adapter.js";

test("EnvAdapter returns identity from env with defaults", async () => {
  const adapter = new EnvAdapter({
    PORTUNI_USER_EMAIL: "honza@workflow.ooo",
    PORTUNI_USER_NAME: "Honza",
  } as NodeJS.ProcessEnv);
  const id = await adapter.verify("ignored");
  assert.equal(id.email, "honza@workflow.ooo");
  assert.equal(id.name, "Honza");
  assert.equal(id.sub, "env:honza@workflow.ooo");
});

test("EnvAdapter defaults match the historical SOLO_USER seed", async () => {
  const adapter = new EnvAdapter({} as NodeJS.ProcessEnv);
  const id = await adapter.verify("ignored");
  assert.equal(id.email, "solo@localhost");
  assert.equal(id.name, "Solo User");
});

test("EnvAdapter grants admin with no groups", async () => {
  const adapter = new EnvAdapter({} as NodeJS.ProcessEnv);
  const access = await adapter.resolveAccess("solo@localhost");
  assert.equal(access.globalScope, "admin");
  assert.deepEqual(access.groups, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth-env-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/auth/adapter.ts
// Identity adapter contract. The backend authorization layer only ever
// sees Identity + AccessResolution; which IdP produced them is invisible.
// Portuni session JWTs and device tokens are verified by the server core
// (src/http/identity.ts), NOT by adapters — adapters verify IdP
// credentials only (Google ID token, env identity, future Microsoft...).

import type { GlobalScope } from "./roles.js";

export interface Identity {
  email: string;
  name: string;
  // Stable IdP-scoped subject ("env:<email>" for EnvAdapter, Google `sub`
  // for GoogleAdapter). Stored as users.google_sub for Google.
  sub: string;
}

export interface AccessResolution {
  globalScope: GlobalScope;
  groups: string[];
}

export interface IdentityAdapter {
  verify(credential: string): Promise<Identity>;
  resolveAccess(email: string): Promise<AccessResolution>;
}
```

```ts
// src/auth/env-adapter.ts
// Dev/local adapter: identity from env, full admin. Preserves the
// pre-multi-user behavior (single trusted local user) and proves the
// IdentityAdapter interface has a second implementation from day one.

import type { AccessResolution, Identity, IdentityAdapter } from "./adapter.js";

export class EnvAdapter implements IdentityAdapter {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async verify(_credential: string): Promise<Identity> {
    const email = this.env.PORTUNI_USER_EMAIL ?? "solo@localhost";
    const name = this.env.PORTUNI_USER_NAME ?? "Solo User";
    return { email, name, sub: `env:${email}` };
  }

  async resolveAccess(_email: string): Promise<AccessResolution> {
    return { globalScope: "admin", groups: [] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/auth-env-adapter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/adapter.ts src/auth/env-adapter.ts test/auth-env-adapter.test.ts
git commit -m "feat(auth): IdentityAdapter interface with EnvAdapter"
```

---

### Task 3: Migration 015 — users identity columns + device_tokens table

**Files:**
- Modify: `src/infra/schema-migrations.ts` (append to `MIGRATIONS` array; last entry today is `014_drop_owner_real_person_trigger` at line ~877)
- Modify: `src/infra/schema-triggers.ts` (add `device_tokens` to fresh DDL next to the `users` table at line ~35)
- Test: `test/migration-015-identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migration-015-identity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ensureSchemaOn } from "../src/infra/schema.js";

test("migration 015 adds identity columns to users", async () => {
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  const cols = await db.execute("PRAGMA table_info(users)");
  const names = cols.rows.map((r) => r.name as string);
  assert.ok(names.includes("google_sub"));
  assert.ok(names.includes("avatar_url"));
  assert.ok(names.includes("last_login_at"));
});

test("migration 015 creates device_tokens with expected columns", async () => {
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  const cols = await db.execute("PRAGMA table_info(device_tokens)");
  const names = cols.rows.map((r) => r.name as string);
  for (const c of [
    "id", "user_id", "label", "token_hash",
    "created_at", "expires_at", "revoked_at", "last_used_at",
  ]) {
    assert.ok(names.includes(c), `missing column ${c}`);
  }
});

test("migration 015 is idempotent (re-running ensureSchemaOn is safe)", async () => {
  const db = createClient({ url: ":memory:" });
  await ensureSchemaOn(db);
  await ensureSchemaOn(db); // must not throw
  const r = await db.execute(
    "SELECT count(*) AS n FROM migrations WHERE id = '015_users_identity'",
  );
  assert.equal(Number(r.rows[0].n), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/migration-015-identity.test.ts`
Expected: FAIL — `google_sub` missing / `device_tokens` table missing.

- [ ] **Step 3: Write minimal implementation**

In `src/infra/schema-triggers.ts`, add a named export near the `users` DDL and include it in the `DDL` array (fresh installs get it without the migration):

```ts
export const DDL_DEVICE_TOKENS = `CREATE TABLE IF NOT EXISTS device_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    label TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    created_at DATETIME NOT NULL DEFAULT (datetime('now')),
    expires_at DATETIME,
    revoked_at DATETIME,
    last_used_at DATETIME
  )`;
```

(Then add `DDL_DEVICE_TOKENS` as an element of the exported `DDL` array, right after the `users` table entry.)

In `src/infra/schema-migrations.ts`, append to `MIGRATIONS` after `014_drop_owner_real_person_trigger`. Follow the column-existence-gated ALTER pattern of migration 003/010 (each ALTER checked via `PRAGMA table_info`, so re-runs are safe):

```ts
  // Migration 015: per-user identity (Google) columns on users +
  // device_tokens table for agent/MCP auth. Spec:
  // docs/superpowers/specs/2026-06-09-google-groups-auth-design.md §4.
  {
    id: "015_users_identity",
    up: async (db) => {
      const cols = await db.execute("PRAGMA table_info(users)");
      const names = new Set(cols.rows.map((r) => String(r.name)));
      if (!names.has("google_sub")) {
        await db.execute("ALTER TABLE users ADD COLUMN google_sub TEXT");
        await db.execute(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL",
        );
      }
      if (!names.has("avatar_url")) {
        await db.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT");
      }
      if (!names.has("last_login_at")) {
        await db.execute("ALTER TABLE users ADD COLUMN last_login_at DATETIME");
      }
      await db.execute(DDL_DEVICE_TOKENS);
    },
  },
```

Import `DDL_DEVICE_TOKENS` from `./schema-triggers.js` at the top of `schema-migrations.ts` (an import block from that module already exists — extend it).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/migration-015-identity.test.ts`
Expected: PASS (3 tests). Then run the whole suite — `npm test` — to confirm nothing regressed.

- [ ] **Step 5: Commit**

```bash
git add src/infra/schema-migrations.ts src/infra/schema-triggers.ts test/migration-015-identity.test.ts
git commit -m "feat(auth): migration 015 - user identity columns + device_tokens"
```

---

### Task 4: visibility='group' — enum + migration 016 (nodes CHECK rebuild)

**Files:**
- Modify: `src/shared/popp.ts:60` (`NODE_VISIBILITIES`)
- Modify: `src/infra/schema-migrations.ts` (append migration 016)
- Test: `test/migration-016-visibility-group.test.ts`

Background: SQLite CHECK constraints cannot be altered in place. Fresh installs pick up `'group'` automatically because the DDL interpolates `NODE_VISIBILITIES_SQL` from `popp.ts`. Existing DBs need a nodes-table rebuild. **Copy the exact recreate sequence from migration `004_check_constraints`** (`src/infra/schema-migrations.ts:425-485`: `PRAGMA foreign_keys = OFF` → create `nodes_new` → `INSERT ... SELECT` → drop/rename → recreate indexes and the org-invariant triggers → `PRAGMA foreign_keys = ON` in a finally block), with the **current** nodes column list, which since migrations 005-013 also includes: `owner_id`, `lifecycle_state`, `goal`, `sync_key` (see the fresh DDL in `src/infra/schema-triggers.ts:41-61` — the `nodes_new` DDL must match it exactly, including `CHECK(updated_at >= created_at)`). After the rename, recreate `idx_nodes_sync_key` exactly as `runMigration013` does, plus the org-invariant triggers `TRIGGER_PREVENT_MULTI_PARENT_ORG` and `TRIGGER_PREVENT_ORPHAN_ON_EDGE_DELETE` are on edges, not nodes — they survive; verify with the test below.

- [ ] **Step 1: Write the failing test**

```ts
// test/migration-016-visibility-group.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import { NODE_VISIBILITIES } from "../src/shared/popp.js";

test("NODE_VISIBILITIES includes group", () => {
  assert.ok((NODE_VISIBILITIES as readonly string[]).includes("group"));
});

test("nodes accept visibility='group' after migration", async () => {
  const { db, orgId } = await makeSharedDb();
  const id = ulid();
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
          VALUES (?, 'project', 'Secret', 'active', 'group', ?, '01SOLO0000000000000000000')`,
    args: [id, `project:secret-${id}`],
  });
  await db.execute({
    sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by)
          VALUES (?, ?, ?, 'belongs_to', '01SOLO0000000000000000000')`,
    args: [ulid(), id, orgId],
  });
  const r = await db.execute({
    sql: "SELECT visibility FROM nodes WHERE id = ?",
    args: [id],
  });
  assert.equal(r.rows[0].visibility, "group");
});

test("invalid visibility still rejected", async () => {
  const { db } = await makeSharedDb();
  await assert.rejects(
    db.execute({
      sql: `INSERT INTO nodes (id, type, name, status, visibility, sync_key, created_by)
            VALUES (?, 'project', 'Bad', 'active', 'nonsense', ?, '01SOLO0000000000000000000')`,
      args: [ulid(), `project:bad-${Date.now()}`],
    }),
  );
});

test("org-invariant triggers survive the rebuild", async () => {
  const { db } = await makeSharedDb();
  const r = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='trigger'",
  );
  const names = r.rows.map((x) => String(x.name));
  assert.ok(names.some((n) => n.includes("multi_parent") || n.includes("orphan")),
    `expected org triggers, got: ${names.join(", ")}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/migration-016-visibility-group.test.ts`
Expected: FAIL — `NODE_VISIBILITIES` lacks `group`; INSERT with `'group'` violates CHECK.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/popp.ts:60`:

```ts
export const NODE_VISIBILITIES = ["team", "private", "group"] as const;
```

In `src/infra/schema-migrations.ts`, append:

```ts
  // Migration 016: extend nodes.visibility CHECK with 'group'.
  // SQLite cannot ALTER a CHECK; rebuild the nodes table following the
  // migration-004 recreate sequence with the current column set.
  {
    id: "016_nodes_visibility_group",
    isApplied: async (db) => {
      const r = await db.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'",
        args: [],
      });
      return String(r.rows[0]?.sql ?? "").includes("'group'");
    },
    up: async (db) => {
      await db.execute("PRAGMA foreign_keys = OFF");
      try {
        await db.execute(`CREATE TABLE nodes_new (
          id TEXT PRIMARY KEY CHECK(length(id) = 26),
          type TEXT NOT NULL CHECK(type IN (${NODE_TYPES_SQL})),
          name TEXT NOT NULL,
          description TEXT,
          summary TEXT,
          summary_updated_at DATETIME,
          meta TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (${NODE_STATUSES_SQL})),
          visibility TEXT NOT NULL DEFAULT 'team' CHECK(visibility IN (${NODE_VISIBILITIES_SQL})),
          pos_x REAL,
          pos_y REAL,
          owner_id TEXT,
          lifecycle_state TEXT,
          goal TEXT,
          sync_key TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT (datetime('now')),
          updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
          CHECK(updated_at >= created_at)
        )`);
        await db.execute(`INSERT INTO nodes_new (
          id, type, name, description, summary, summary_updated_at, meta,
          status, visibility, pos_x, pos_y, owner_id, lifecycle_state, goal,
          sync_key, created_by, created_at, updated_at
        ) SELECT
          id, type, name, description, summary, summary_updated_at, meta,
          status, visibility, pos_x, pos_y, owner_id, lifecycle_state, goal,
          sync_key, created_by, created_at, updated_at
        FROM nodes`);
        await db.execute("DROP TABLE nodes");
        await db.execute("ALTER TABLE nodes_new RENAME TO nodes");
        await db.execute(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_sync_key ON nodes(sync_key)",
        );
      } finally {
        await db.execute("PRAGMA foreign_keys = ON");
      }
    },
  },
```

Before finalizing, compare the column list against the live fresh DDL in `src/infra/schema-triggers.ts:41-61` and against the index DDL created by `runMigration013` (`013_nodes_sync_key` — check whether the sync_key index is partial/unique and copy it verbatim). If they differ from the snippet above, the live files win.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/migration-016-visibility-group.test.ts`
Expected: PASS (4 tests). Then `npm test` — full suite green (migration tests for 006-013 exercise the rebuild path).

- [ ] **Step 5: Commit**

```bash
git add src/shared/popp.ts src/infra/schema-migrations.ts test/migration-016-visibility-group.test.ts
git commit -m "feat(auth): visibility='group' enum + nodes CHECK rebuild (migration 016)"
```

---

### Task 5: Portuni session JWT

**Files:**
- Modify: `package.json` (add dependency `jose`)
- Create: `src/auth/session-token.ts`
- Test: `test/auth-session-token.test.ts`

- [ ] **Step 1: Install dependency**

Run: `npm install jose`
Expected: `jose` appears in `package.json` dependencies.

- [ ] **Step 2: Write the failing test**

```ts
// test/auth-session-token.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signSessionToken,
  verifySessionToken,
} from "../src/auth/session-token.js";

const SECRET = "test-secret-at-least-32-chars-long!!";

test("round-trips claims", async () => {
  const token = await signSessionToken(
    {
      userId: "01USER0000000000000000000",
      email: "a@x.com",
      name: "A",
      globalScope: "manage",
      groups: ["apollo@x.com"],
    },
    SECRET,
  );
  const claims = await verifySessionToken(token, SECRET);
  assert.ok(claims);
  assert.equal(claims.userId, "01USER0000000000000000000");
  assert.equal(claims.globalScope, "manage");
  assert.deepEqual(claims.groups, ["apollo@x.com"]);
});

test("rejects wrong secret", async () => {
  const token = await signSessionToken(
    { userId: "u", email: "a@x.com", name: "A", globalScope: "read", groups: [] },
    SECRET,
  );
  assert.equal(await verifySessionToken(token, "other-secret-32-chars-long!!!!!!"), null);
});

test("rejects expired token", async () => {
  const token = await signSessionToken(
    { userId: "u", email: "a@x.com", name: "A", globalScope: "read", groups: [] },
    SECRET,
    -10, // already expired
  );
  assert.equal(await verifySessionToken(token, SECRET), null);
});

test("rejects garbage", async () => {
  assert.equal(await verifySessionToken("not-a-jwt", SECRET), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test test/auth-session-token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/auth/session-token.ts
// Short-lived Portuni session JWT, issued by POST /auth/login after the
// IdentityAdapter verified the IdP credential. HS256 with a server-side
// secret (PORTUNI_JWT_SECRET) — only this server signs and verifies.
// Groups/scope are baked in; the 1h TTL bounds membership staleness
// alongside the 15-min adapter cache.

import { SignJWT, jwtVerify } from "jose";
import { GLOBAL_SCOPES, type GlobalScope } from "./roles.js";

export interface SessionClaims {
  userId: string;
  email: string;
  name: string;
  globalScope: GlobalScope;
  groups: string[];
}

const DEFAULT_TTL_SECONDS = 60 * 60;

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(
  claims: SessionClaims,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: claims.email,
    name: claims.name,
    scope: claims.globalScope,
    groups: claims.groups,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer("portuni")
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key(secret));
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: "portuni",
      algorithms: ["HS256"],
    });
    const scope = payload.scope as string;
    if (!(GLOBAL_SCOPES as readonly string[]).includes(scope)) return null;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      return null;
    }
    return {
      userId: payload.sub,
      email: payload.email,
      name: typeof payload.name === "string" ? payload.name : "",
      globalScope: scope as GlobalScope,
      groups: Array.isArray(payload.groups)
        ? payload.groups.filter((g): g is string => typeof g === "string")
        : [],
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/auth-session-token.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/auth/session-token.ts test/auth-session-token.test.ts
git commit -m "feat(auth): portuni session JWT (jose, HS256)"
```

---

### Task 6: Device tokens (mint / verify / revoke / list)

**Files:**
- Create: `src/auth/device-tokens.ts`
- Test: `test/auth-device-tokens.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/auth-device-tokens.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  mintDeviceToken,
  verifyDeviceToken,
  revokeDeviceToken,
  listDeviceTokens,
} from "../src/auth/device-tokens.js";

const USER = "01SOLO0000000000000000000";

test("mint returns plaintext once; verify resolves the user", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, USER, "MacBook – Claude Code");
  assert.ok(minted.token.startsWith("ptk_"));
  const hit = await verifyDeviceToken(db, minted.token);
  assert.ok(hit);
  assert.equal(hit.userId, USER);
  assert.equal(hit.tokenId, minted.id);
});

test("plaintext token is not stored", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, USER, "x");
  const r = await db.execute({
    sql: "SELECT token_hash FROM device_tokens WHERE id = ?",
    args: [minted.id],
  });
  assert.notEqual(r.rows[0].token_hash, minted.token);
});

test("revoked token stops verifying; list shows revoked_at", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, USER, "x");
  await revokeDeviceToken(db, USER, minted.id);
  assert.equal(await verifyDeviceToken(db, minted.token), null);
  const rows = await listDeviceTokens(db, USER);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].revoked_at);
});

test("expired token stops verifying", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, USER, "x", { ttlDays: -1 });
  assert.equal(await verifyDeviceToken(db, minted.token), null);
});

test("unknown token verifies to null", async () => {
  const { db } = await makeSharedDb();
  assert.equal(await verifyDeviceToken(db, "ptk_does-not-exist"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth-device-tokens.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/auth/device-tokens.ts
// Long-lived per-user per-device tokens for MCP/agent clients
// (.mcp.json). Server stores only the sha256 hash; the plaintext is
// shown exactly once at mint time. Spec §2 "Auth pro agenty".

import { createHash, randomBytes } from "node:crypto";
import type { Client } from "@libsql/client";
import { ulid } from "ulid";

const DEFAULT_TTL_DAYS = 180;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface MintedDeviceToken {
  id: string;
  token: string; // plaintext, shown once
  expires_at: string;
}

export async function mintDeviceToken(
  db: Client,
  userId: string,
  label: string,
  opts: { ttlDays?: number } = {},
): Promise<MintedDeviceToken> {
  const id = ulid();
  const token = `ptk_${randomBytes(32).toString("base64url")}`;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  await db.execute({
    sql: `INSERT INTO device_tokens (id, user_id, label, token_hash, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, userId, label, hashToken(token), expiresAt],
  });
  return { id, token, expires_at: expiresAt };
}

export interface DeviceTokenHit {
  tokenId: string;
  userId: string;
}

export async function verifyDeviceToken(
  db: Client,
  token: string,
): Promise<DeviceTokenHit | null> {
  const r = await db.execute({
    sql: `SELECT id, user_id FROM device_tokens
          WHERE token_hash = ?
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    args: [hashToken(token)],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  await db.execute({
    sql: "UPDATE device_tokens SET last_used_at = datetime('now') WHERE id = ?",
    args: [row.id],
  });
  return { tokenId: String(row.id), userId: String(row.user_id) };
}

export async function revokeDeviceToken(
  db: Client,
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const r = await db.execute({
    sql: `UPDATE device_tokens SET revoked_at = datetime('now')
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    args: [tokenId, userId],
  });
  return r.rowsAffected > 0;
}

export interface DeviceTokenRow {
  id: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export async function listDeviceTokens(
  db: Client,
  userId: string,
): Promise<DeviceTokenRow[]> {
  const r = await db.execute({
    sql: `SELECT id, label, created_at, expires_at, revoked_at, last_used_at
          FROM device_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    args: [userId],
  });
  return r.rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    created_at: String(row.created_at),
    expires_at: row.expires_at == null ? null : String(row.expires_at),
    revoked_at: row.revoked_at == null ? null : String(row.revoked_at),
    last_used_at: row.last_used_at == null ? null : String(row.last_used_at),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/auth-device-tokens.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/device-tokens.ts test/auth-device-tokens.test.ts
git commit -m "feat(auth): device tokens - mint/verify/revoke/list, hash-only storage"
```

---

### Task 7: User upsert on login

**Files:**
- Create: `src/auth/users.ts`
- Test: `test/auth-users-upsert.test.ts`

Semantics (spec §4): match by `google_sub` first; else by `email` — this **enriches the existing SOLO_USER row** on the owner's first Google login, keeping all historical attribution; else insert a new user. Always bumps `last_login_at`.

- [ ] **Step 1: Write the failing test**

```ts
// test/auth-users-upsert.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import { upsertUserFromIdentity } from "../src/auth/users.js";

test("existing user matched by email is enriched, id preserved", async () => {
  const { db } = await makeSharedDb();
  // SOLO_USER seed exists with email solo@localhost (ensureSchemaOn).
  const userId = await upsertUserFromIdentity(db, {
    email: "solo@localhost",
    name: "Honza Pav",
    sub: "google-sub-123",
  }, "https://avatar.example/a.png");
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
  const first = await upsertUserFromIdentity(db, {
    email: "a@x.com", name: "A", sub: "sub-A",
  }, null);
  const second = await upsertUserFromIdentity(db, {
    email: "a-renamed@x.com", name: "A", sub: "sub-A",
  }, null);
  assert.equal(first, second);
});

test("unknown identity creates a new user", async () => {
  const { db } = await makeSharedDb();
  const userId = await upsertUserFromIdentity(db, {
    email: "new@x.com", name: "New", sub: "sub-new",
  }, null);
  const r = await db.execute({
    sql: "SELECT email, name, google_sub FROM users WHERE id = ?",
    args: [userId],
  });
  assert.equal(r.rows[0].email, "new@x.com");
  assert.equal(r.rows[0].google_sub, "sub-new");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth-users-upsert.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/auth/users.ts
// Identity -> users row resolution at login time. Match order:
// google_sub, then email (enriches the pre-multi-user SOLO_USER row so
// history stays attributed), then insert.

import type { Client } from "@libsql/client";
import { ulid } from "ulid";
import type { Identity } from "./adapter.js";

export async function upsertUserFromIdentity(
  db: Client,
  identity: Identity,
  avatarUrl: string | null,
): Promise<string> {
  const bySub = await db.execute({
    sql: "SELECT id FROM users WHERE google_sub = ?",
    args: [identity.sub],
  });
  if (bySub.rows.length > 0) {
    const id = String(bySub.rows[0].id);
    await db.execute({
      sql: `UPDATE users SET email = ?, name = ?, avatar_url = COALESCE(?, avatar_url),
                   last_login_at = datetime('now') WHERE id = ?`,
      args: [identity.email, identity.name, avatarUrl, id],
    });
    return id;
  }

  const byEmail = await db.execute({
    sql: "SELECT id FROM users WHERE email = ?",
    args: [identity.email],
  });
  if (byEmail.rows.length > 0) {
    const id = String(byEmail.rows[0].id);
    await db.execute({
      sql: `UPDATE users SET google_sub = ?, name = ?, avatar_url = COALESCE(?, avatar_url),
                   last_login_at = datetime('now') WHERE id = ?`,
      args: [identity.sub, identity.name, avatarUrl, id],
    });
    return id;
  }

  const id = ulid();
  await db.execute({
    sql: `INSERT INTO users (id, email, name, google_sub, avatar_url, last_login_at, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    args: [id, identity.email, identity.name, identity.sub, avatarUrl],
  });
  return id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/auth-users-upsert.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/users.ts test/auth-users-upsert.test.ts
git commit -m "feat(auth): user upsert on login with SOLO_USER email enrichment"
```

---

### Task 8: GoogleAdapter (verify + resolveAccess + 15-min cache)

**Files:**
- Modify: `package.json` (add dependency `google-auth-library`)
- Create: `src/auth/google-adapter.ts`
- Test: `test/auth-google-adapter.test.ts`

Design for testability: the class takes injected functions for the two Google calls; `createGoogleAdapter()` wires the real clients from env. Tests never touch the network.

- [ ] **Step 1: Install dependency**

Run: `npm install google-auth-library`

- [ ] **Step 2: Write the failing test**

```ts
// test/auth-google-adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleAdapter } from "../src/auth/google-adapter.js";

const basePayload = {
  sub: "g-sub-1",
  email: "a@workflow.ooo",
  email_verified: true,
  name: "A",
  picture: "https://p/x.png",
  hd: "workflow.ooo",
};

function makeAdapter(overrides: Partial<{
  payload: typeof basePayload | null;
  groups: string[];
  allowedDomain: string;
  roleConfig: { admin: string[]; manage: string[]; write: string[] };
  now: () => number;
}> = {}) {
  let groupCalls = 0;
  const adapter = new GoogleAdapter({
    verifyIdToken: async () => overrides.payload === undefined ? basePayload : overrides.payload,
    listGroups: async () => {
      groupCalls += 1;
      return overrides.groups ?? [];
    },
    allowedDomain: overrides.allowedDomain ?? "workflow.ooo",
    roleConfig: overrides.roleConfig ?? {
      admin: ["portuni-admins@workflow.ooo"],
      manage: [],
      write: ["portuni-team@workflow.ooo"],
    },
    now: overrides.now ?? (() => Date.now()),
  });
  return { adapter, groupCalls: () => groupCalls };
}

test("verify returns identity for a valid token in the allowed domain", async () => {
  const { adapter } = makeAdapter();
  const id = await adapter.verify("token");
  assert.equal(id.email, "a@workflow.ooo");
  assert.equal(id.sub, "g-sub-1");
});

test("verify rejects wrong domain", async () => {
  const { adapter } = makeAdapter({
    payload: { ...basePayload, email: "x@evil.com", hd: "evil.com" },
  });
  await assert.rejects(adapter.verify("token"), /domain/i);
});

test("verify rejects unverified email", async () => {
  const { adapter } = makeAdapter({
    payload: { ...basePayload, email_verified: false },
  });
  await assert.rejects(adapter.verify("token"));
});

test("resolveAccess maps groups to scope", async () => {
  const { adapter } = makeAdapter({ groups: ["portuni-team@workflow.ooo"] });
  const access = await adapter.resolveAccess("a@workflow.ooo");
  assert.equal(access.globalScope, "write");
  assert.deepEqual(access.groups, ["portuni-team@workflow.ooo"]);
});

test("resolveAccess caches for 15 minutes", async () => {
  let t = 1_000_000;
  const { adapter, groupCalls } = makeAdapter({
    groups: ["portuni-team@workflow.ooo"],
    now: () => t,
  });
  await adapter.resolveAccess("a@workflow.ooo");
  await adapter.resolveAccess("a@workflow.ooo");
  assert.equal(groupCalls(), 1, "second call within TTL served from cache");
  t += 16 * 60 * 1000;
  await adapter.resolveAccess("a@workflow.ooo");
  assert.equal(groupCalls(), 2, "expired cache refetches");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test test/auth-google-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/auth/google-adapter.ts
// Google OAuth + Workspace Groups identity adapter (spec §2).
// verify(): OIDC ID-token verification + allowed-domain gate.
// resolveAccess(): Admin SDK Directory API groups.list(userKey=email)
// through a DWD service account, mapped to a global role; cached 15 min.

import { OAuth2Client, JWT } from "google-auth-library";
import type { AccessResolution, Identity, IdentityAdapter } from "./adapter.js";
import {
  groupRoleConfigFromEnv,
  resolveGlobalScope,
  type GroupRoleConfig,
} from "./roles.js";

const GROUP_CACHE_TTL_MS = 15 * 60 * 1000;

export interface GoogleIdTokenPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  hd?: string;
}

export interface GoogleAdapterDeps {
  verifyIdToken: (idToken: string) => Promise<GoogleIdTokenPayload | null>;
  listGroups: (email: string) => Promise<string[]>;
  allowedDomain: string;
  roleConfig: GroupRoleConfig;
  now?: () => number;
}

export class GoogleAdapter implements IdentityAdapter {
  private readonly cache = new Map<string, { at: number; access: AccessResolution }>();
  private readonly now: () => number;

  constructor(private readonly deps: GoogleAdapterDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async verify(credential: string): Promise<Identity> {
    const payload = await this.deps.verifyIdToken(credential);
    if (!payload) throw new Error("Invalid Google ID token");
    if (!payload.email_verified) throw new Error("Google email not verified");
    const domain = payload.email.split("@")[1]?.toLowerCase() ?? "";
    if (domain !== this.deps.allowedDomain.toLowerCase()) {
      // External Google accounts are a future phase (spec: rozhodnutí
      // "Externí uživatelé"); for the team test only the org domain logs in.
      throw new Error(`Account domain '${domain}' is not allowed`);
    }
    return {
      email: payload.email.toLowerCase(),
      name: payload.name ?? payload.email,
      sub: payload.sub,
    };
  }

  // Exposed so /auth/login can pass the avatar through to upsertUser.
  async verifyWithProfile(
    credential: string,
  ): Promise<{ identity: Identity; avatarUrl: string | null }> {
    const payload = await this.deps.verifyIdToken(credential);
    if (!payload) throw new Error("Invalid Google ID token");
    const identity = await this.verify(credential);
    return { identity, avatarUrl: payload.picture ?? null };
  }

  async resolveAccess(email: string): Promise<AccessResolution> {
    const key = email.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < GROUP_CACHE_TTL_MS) return hit.access;
    const groups = (await this.deps.listGroups(key)).map((g) => g.toLowerCase());
    const access: AccessResolution = {
      globalScope: resolveGlobalScope(groups, this.deps.roleConfig),
      groups,
    };
    this.cache.set(key, { at: this.now(), access });
    return access;
  }
}

// Production wiring from env:
//   PORTUNI_GOOGLE_CLIENT_IDS   comma list of accepted OAuth client IDs
//   PORTUNI_ALLOWED_DOMAIN      e.g. workflow.ooo
//   PORTUNI_GOOGLE_SA_KEY_JSON  service-account key JSON (DWD-enabled)
//   PORTUNI_GOOGLE_IMPERSONATE  admin user the SA impersonates
//   PORTUNI_GROUPS_ADMIN/MANAGE/WRITE  group-email lists (roles.ts)
export function createGoogleAdapter(env: NodeJS.ProcessEnv = process.env): GoogleAdapter {
  const clientIds = (env.PORTUNI_GOOGLE_CLIENT_IDS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (clientIds.length === 0) {
    throw new Error("PORTUNI_GOOGLE_CLIENT_IDS is required in google auth mode");
  }
  const allowedDomain = env.PORTUNI_ALLOWED_DOMAIN ?? "";
  if (!allowedDomain) {
    throw new Error("PORTUNI_ALLOWED_DOMAIN is required in google auth mode");
  }
  const saJson = env.PORTUNI_GOOGLE_SA_KEY_JSON ?? "";
  const impersonate = env.PORTUNI_GOOGLE_IMPERSONATE ?? "";
  if (!saJson || !impersonate) {
    throw new Error(
      "PORTUNI_GOOGLE_SA_KEY_JSON and PORTUNI_GOOGLE_IMPERSONATE are required in google auth mode",
    );
  }
  const sa = JSON.parse(saJson) as { client_email: string; private_key: string };
  const oauth = new OAuth2Client();

  const directoryClient = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/admin.directory.group.readonly"],
    subject: impersonate,
  });

  return new GoogleAdapter({
    verifyIdToken: async (idToken) => {
      const ticket = await oauth.verifyIdToken({ idToken, audience: clientIds });
      return (ticket.getPayload() as GoogleIdTokenPayload | undefined) ?? null;
    },
    listGroups: async (email) => {
      const groups: string[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL("https://admin.googleapis.com/admin/directory/v1/groups");
        url.searchParams.set("userKey", email);
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const res = await directoryClient.request<{
          groups?: Array<{ email: string }>;
          nextPageToken?: string;
        }>({ url: url.toString() });
        for (const g of res.data.groups ?? []) groups.push(g.email);
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      return groups;
    },
    allowedDomain,
    roleConfig: groupRoleConfigFromEnv(env),
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --import tsx --test test/auth-google-adapter.test.ts`
Expected: PASS (5 tests). Also run `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/auth/google-adapter.ts test/auth-google-adapter.test.ts
git commit -m "feat(auth): GoogleAdapter - OIDC verify + Directory API groups with cache"
```

---

### Task 9: Request identity resolution in HTTP middleware

**Files:**
- Create: `src/auth/request-identity.ts`
- Modify: `src/http/middleware.ts` (auth section of `applyGates`, lines 76-101 and 257-270)
- Modify: `src/http/server.ts:52` (pass identity onward)
- Test: `test/auth-request-identity.test.ts`

Behavior:
- `PORTUNI_AUTH_MODE=env` (default, **today's semantics preserved**): the static `PORTUNI_AUTH_TOKEN` gate stays exactly as-is; identity is the EnvAdapter identity with `userId = SOLO_USER`.
- `PORTUNI_AUTH_MODE=google`: the bearer value is either a device token (`ptk_` prefix → `verifyDeviceToken` + adapter `resolveAccess`) or a Portuni session JWT (`verifySessionToken`). No match → 401. `PORTUNI_JWT_SECRET` required.

```ts
export interface RequestIdentity {
  userId: string;
  email: string;
  name: string;
  globalScope: GlobalScope;
  groups: string[];
  via: "env" | "session_jwt" | "device_token";
}
```

- [ ] **Step 1: Write the failing test**

```ts
// test/auth-request-identity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSharedDb } from "./helpers/shared-db.js";
import { resolveRequestIdentity } from "../src/auth/request-identity.js";
import { mintDeviceToken } from "../src/auth/device-tokens.js";
import { signSessionToken } from "../src/auth/session-token.js";
import { EnvAdapter } from "../src/auth/env-adapter.js";

const SECRET = "test-secret-at-least-32-chars-long!!";
const SOLO = "01SOLO0000000000000000000";

function ctx(db: Awaited<ReturnType<typeof makeSharedDb>>["db"], mode: "env" | "google") {
  return {
    db,
    mode,
    jwtSecret: SECRET,
    adapter: new EnvAdapter({} as NodeJS.ProcessEnv),
    soloUserId: SOLO,
  };
}

test("env mode yields solo admin identity regardless of header", async () => {
  const { db } = await makeSharedDb();
  const id = await resolveRequestIdentity(ctx(db, "env"), undefined);
  assert.ok(id);
  assert.equal(id.userId, SOLO);
  assert.equal(id.globalScope, "admin");
  assert.equal(id.via, "env");
});

test("google mode accepts a valid session JWT", async () => {
  const { db } = await makeSharedDb();
  const token = await signSessionToken(
    { userId: "u1", email: "a@x.com", name: "A", globalScope: "write", groups: ["g@x.com"] },
    SECRET,
  );
  const id = await resolveRequestIdentity(ctx(db, "google"), `Bearer ${token}`);
  assert.ok(id);
  assert.equal(id.userId, "u1");
  assert.equal(id.globalScope, "write");
  assert.equal(id.via, "session_jwt");
});

test("google mode accepts a device token and resolves access via adapter", async () => {
  const { db } = await makeSharedDb();
  const minted = await mintDeviceToken(db, SOLO, "test");
  const id = await resolveRequestIdentity(ctx(db, "google"), `Bearer ${minted.token}`);
  assert.ok(id);
  assert.equal(id.userId, SOLO);
  assert.equal(id.via, "device_token");
  assert.equal(id.globalScope, "admin"); // EnvAdapter resolveAccess
});

test("google mode rejects garbage and missing header", async () => {
  const { db } = await makeSharedDb();
  assert.equal(await resolveRequestIdentity(ctx(db, "google"), undefined), null);
  assert.equal(await resolveRequestIdentity(ctx(db, "google"), "Bearer nonsense"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth-request-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/auth/request-identity.ts
// Resolves "who is making this HTTP request" from the Authorization
// header. Pure function over an injected context so tests need no env
// mutation. The http middleware builds the context once per process.

import type { Client } from "@libsql/client";
import type { IdentityAdapter } from "./adapter.js";
import type { GlobalScope } from "./roles.js";
import { verifyDeviceToken } from "./device-tokens.js";
import { verifySessionToken } from "./session-token.js";

export interface RequestIdentity {
  userId: string;
  email: string;
  name: string;
  globalScope: GlobalScope;
  groups: string[];
  via: "env" | "session_jwt" | "device_token";
}

export interface IdentityContext {
  db: Client;
  mode: "env" | "google";
  jwtSecret: string;
  adapter: IdentityAdapter;
  soloUserId: string;
}

function bearerValue(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

export async function resolveRequestIdentity(
  ctx: IdentityContext,
  authorizationHeader: string | undefined,
): Promise<RequestIdentity | null> {
  if (ctx.mode === "env") {
    const identity = await ctx.adapter.verify("");
    const access = await ctx.adapter.resolveAccess(identity.email);
    return {
      userId: ctx.soloUserId,
      email: identity.email,
      name: identity.name,
      globalScope: access.globalScope,
      groups: access.groups,
      via: "env",
    };
  }

  const value = bearerValue(authorizationHeader);
  if (!value) return null;

  if (value.startsWith("ptk_")) {
    const hit = await verifyDeviceToken(ctx.db, value);
    if (!hit) return null;
    const user = await ctx.db.execute({
      sql: "SELECT email, name FROM users WHERE id = ?",
      args: [hit.userId],
    });
    if (user.rows.length === 0) return null;
    const email = String(user.rows[0].email);
    const access = await ctx.adapter.resolveAccess(email);
    return {
      userId: hit.userId,
      email,
      name: String(user.rows[0].name),
      globalScope: access.globalScope,
      groups: access.groups,
      via: "device_token",
    };
  }

  const claims = await verifySessionToken(value, ctx.jwtSecret);
  if (!claims) return null;
  return { ...claims, via: "session_jwt" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/auth-request-identity.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into the HTTP layer**

In `src/http/middleware.ts`:

1. Add a module-level identity context factory (lazy, like the gate caches):

```ts
import { getDb } from "../infra/db.js";
import { SOLO_USER } from "../infra/schema.js";
import { EnvAdapter } from "../auth/env-adapter.js";
import { createGoogleAdapter } from "../auth/google-adapter.js";
import {
  resolveRequestIdentity,
  type IdentityContext,
  type RequestIdentity,
} from "../auth/request-identity.js";

export type { RequestIdentity } from "../auth/request-identity.js";

let identityCtxCache: IdentityContext | null = null;

export function getIdentityContext(): IdentityContext {
  if (identityCtxCache) return identityCtxCache;
  const mode = (process.env.PORTUNI_AUTH_MODE ?? "env") === "google" ? "google" : "env";
  identityCtxCache = {
    db: getDb(),
    mode,
    jwtSecret: process.env.PORTUNI_JWT_SECRET ?? "",
    adapter: mode === "google" ? createGoogleAdapter() : new EnvAdapter(),
    soloUserId: SOLO_USER,
  };
  if (mode === "google" && identityCtxCache.jwtSecret.length < 32) {
    throw new Error("PORTUNI_JWT_SECRET (>=32 chars) is required in google auth mode");
  }
  return identityCtxCache;
}

export function resetIdentityContextForTesting(): void {
  identityCtxCache = null;
}
```

2. Change `applyGates` to return the identity instead of a boolean-only contract. New signature:

```ts
export async function applyGates(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<RequestIdentity | "handled"> {
```

Inside, keep host/origin/CORS/preflight exactly as today (returning `"handled"` where it returned `true`). Replace the static-token block (lines 257-270) with:

```ts
  const ctx = getIdentityContext();

  // env mode keeps the legacy static-token gate (loopback hardening),
  // then resolves the solo identity.
  if (ctx.mode === "env") {
    if (AUTH_ENABLED && !AUTH_PUBLIC_PATHS.has(url.pathname)) {
      const presented = bearer(req);
      if (presented === "" || !timingSafeStringEqual(presented, AUTH_TOKEN)) {
        respondUnauthorized(res);
        return "handled";
      }
    }
    return await resolveRequestIdentity(ctx, req.headers.authorization as string | undefined);
  }

  // google mode: public paths pass with a null identity substitute is NOT
  // allowed — /health and /mcp/info still respond, /auth/login is public
  // by design (it carries the credential in the body).
  if (AUTH_PUBLIC_PATHS.has(url.pathname) || url.pathname === "/auth/login") {
    return {
      userId: "", email: "", name: "", globalScope: "read", groups: [], via: "session_jwt",
    };
  }
  const identity = await resolveRequestIdentity(
    ctx,
    req.headers.authorization as string | undefined,
  );
  if (!identity) {
    respondUnauthorized(res);
    return "handled";
  }
  return identity;
```

Add the two small helpers (`bearer(req)` extracting the Bearer value, `respondUnauthorized(res)` writing the existing 401 JSON + `WWW-Authenticate` header) by extracting the current inline code.

3. In `src/http/server.ts:52`, adapt the call site:

```ts
    const gate = await applyGates(req, res);
    if (gate === "handled") return;
    const identity = gate;
```

and pass `identity` to both `mcp.handle(req, res, identity)` and `routeApiRequest(req, res, url, identity)` — those signatures change in Tasks 10-12; for THIS task, add the parameters to both functions but ignore them in bodies (`_identity`), so the build stays green.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — env mode is the default everywhere, so rest-smoke/mcp-smoke behave identically. Also `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/auth/request-identity.ts src/http/middleware.ts src/http/server.ts src/mcp/transport.ts src/api/router.ts test/auth-request-identity.test.ts
git commit -m "feat(auth): per-request identity resolution (env/google modes)"
```

---

### Task 10: Auth REST endpoints — /auth/login, /me, /device-tokens

**Files:**
- Create: `src/api/auth.ts`
- Modify: `src/api/router.ts` (dispatch the new routes; router signature gains `identity`)
- Test: `test/rest-auth.test.ts`

Endpoints:
- `POST /auth/login` — body `{ id_token }`. Google mode only (env mode → 404). Verifies via adapter (`verifyWithProfile` when the adapter is a GoogleAdapter; otherwise `verify`), `upsertUserFromIdentity`, `resolveAccess`, returns `{ token, user: { id, email, name, avatar_url, global_scope, groups } }` with a 1h session JWT.
- `GET /me` — returns the request identity: `{ id, email, name, global_scope, groups, via }`.
- `POST /device-tokens` — body `{ label }`; mints for the **current** user; returns plaintext once.
- `GET /device-tokens` — list current user's tokens (no hashes).
- `DELETE /device-tokens/:id` — revoke own token; 404 when not found/not owned.

- [ ] **Step 1: Write the failing test**

```ts
// test/rest-auth.test.ts
// In-process REST test following the pattern of test/rest-smoke.test.ts
// (boot startHttpServer on an ephemeral port with registerSigint: false,
// fetch against it, shutdown in after()). Read that file first and reuse
// its setup helper verbatim — env mode, PORTUNI_AUTH_TOKEN unset.
import { test, after } from "node:test";
import assert from "node:assert/strict";
// ... same bootstrapping imports as test/rest-smoke.test.ts ...

test("GET /me returns the env-mode solo identity", async () => {
  const res = await fetch(`${base}/me`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.global_scope, "admin");
  assert.equal(body.via, "env");
});

test("device token lifecycle over REST", async () => {
  const mint = await fetch(`${base}/device-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "test-device" }),
  });
  assert.equal(mint.status, 201);
  const minted = await mint.json();
  assert.ok(minted.token.startsWith("ptk_"));

  const list = await fetch(`${base}/device-tokens`);
  const rows = await list.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "test-device");
  assert.equal(rows[0].token, undefined, "plaintext never returned again");

  const del = await fetch(`${base}/device-tokens/${minted.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const list2 = await (await fetch(`${base}/device-tokens`)).json();
  assert.ok(list2[0].revoked_at);
});

test("POST /auth/login is 404 in env mode", async () => {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: "x" }),
  });
  assert.equal(res.status, 404);
});
```

(Login happy-path with a fake Google adapter is covered at unit level in Task 8 + Task 9; an end-to-end google-mode HTTP test would need env juggling across module caches — defer to the deployment plan's smoke test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/rest-auth.test.ts`
Expected: FAIL — 404 on /me and /device-tokens.

- [ ] **Step 3: Write the handlers**

```ts
// src/api/auth.ts
// Auth/identity REST endpoints: login (google mode), /me, device tokens.

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDb } from "../infra/db.js";
import {
  getIdentityContext,
  parseJsonBody,
  respondError,
  respondJson,
  type RequestIdentity,
} from "../http/middleware.js";
import { GoogleAdapter } from "../auth/google-adapter.js";
import { upsertUserFromIdentity } from "../auth/users.js";
import { signSessionToken } from "../auth/session-token.js";
import {
  listDeviceTokens,
  mintDeviceToken,
  revokeDeviceToken,
} from "../auth/device-tokens.js";
import { logAudit } from "../infra/audit.js";

const LoginBody = z.object({ id_token: z.string().min(1) });

export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const ctx = getIdentityContext();
  if (ctx.mode !== "google") {
    respondJson(res, 404, { error: "Login is not available in env auth mode" });
    return;
  }
  try {
    const body = await parseJsonBody(req, res, LoginBody);
    if (!body) return;
    let identity: Awaited<ReturnType<typeof ctx.adapter.verify>>;
    let avatarUrl: string | null = null;
    if (ctx.adapter instanceof GoogleAdapter) {
      const r = await ctx.adapter.verifyWithProfile(body.id_token);
      identity = r.identity;
      avatarUrl = r.avatarUrl;
    } else {
      identity = await ctx.adapter.verify(body.id_token);
    }
    const userId = await upsertUserFromIdentity(getDb(), identity, avatarUrl);
    const access = await ctx.adapter.resolveAccess(identity.email);
    const token = await signSessionToken(
      {
        userId,
        email: identity.email,
        name: identity.name,
        globalScope: access.globalScope,
        groups: access.groups,
      },
      ctx.jwtSecret,
    );
    await logAudit(userId, "login", "user", userId, { via: "google" });
    respondJson(res, 200, {
      token,
      user: {
        id: userId,
        email: identity.email,
        name: identity.name,
        avatar_url: avatarUrl,
        global_scope: access.globalScope,
        groups: access.groups,
      },
    });
  } catch (err) {
    // Invalid credential -> 401, not 500.
    respondJson(res, 401, {
      error: err instanceof Error ? err.message : "Login failed",
    });
  }
}

export async function handleMe(
  _req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  respondJson(res, 200, {
    id: identity.userId,
    email: identity.email,
    name: identity.name,
    global_scope: identity.globalScope,
    groups: identity.groups,
    via: identity.via,
  });
}

const MintBody = z.object({ label: z.string().min(1).max(200) });

export async function handleMintDeviceToken(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    const body = await parseJsonBody(req, res, MintBody);
    if (!body) return;
    const minted = await mintDeviceToken(getDb(), identity.userId, body.label);
    await logAudit(identity.userId, "mint_device_token", "device_token", minted.id, {
      label: body.label,
    });
    respondJson(res, 201, minted);
  } catch (err) {
    respondError(res, "POST /device-tokens", err);
  }
}

export async function handleListDeviceTokens(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
): Promise<void> {
  try {
    respondJson(res, 200, await listDeviceTokens(getDb(), identity.userId));
  } catch (err) {
    respondError(res, "GET /device-tokens", err);
  }
}

export async function handleRevokeDeviceToken(
  req: IncomingMessage,
  res: ServerResponse,
  identity: RequestIdentity,
  tokenId: string,
): Promise<void> {
  try {
    const ok = await revokeDeviceToken(getDb(), identity.userId, tokenId);
    if (!ok) {
      respondJson(res, 404, { error: "Token not found" });
      return;
    }
    await logAudit(identity.userId, "revoke_device_token", "device_token", tokenId, {});
    respondJson(res, 200, { revoked: true });
  } catch (err) {
    respondError(res, "DELETE /device-tokens/:id", err);
  }
}
```

In `src/api/router.ts`: change `routeApiRequest(req, res, url)` to `routeApiRequest(req, res, url, identity: RequestIdentity)` and add, before the existing dispatch:

```ts
  if (url.pathname === "/auth/login" && req.method === "POST") {
    await handleLogin(req, res);
    return true;
  }
  if (url.pathname === "/me" && req.method === "GET") {
    await handleMe(req, res, identity);
    return true;
  }
  if (url.pathname === "/device-tokens" && req.method === "POST") {
    await handleMintDeviceToken(req, res, identity);
    return true;
  }
  if (url.pathname === "/device-tokens" && req.method === "GET") {
    await handleListDeviceTokens(req, res, identity);
    return true;
  }
  const dtMatch = url.pathname.match(/^\/device-tokens\/([^/]+)$/);
  if (dtMatch && req.method === "DELETE") {
    await handleRevokeDeviceToken(req, res, identity, dtMatch[1]);
    return true;
  }
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test test/rest-auth.test.ts` then `npm test`.
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/api/auth.ts src/api/router.ts test/rest-auth.test.ts
git commit -m "feat(auth): REST endpoints - /auth/login, /me, device tokens"
```

---

### Task 11: Thread identity through MCP sessions (kill SOLO_USER in src/mcp)

**Files:**
- Modify: `src/mcp/server.ts:34` (`createMcpServer` gains an identity parameter)
- Modify: `src/mcp/transport.ts` (identity per session; `handle` gains identity param)
- Modify: `src/mcp/list-scope-gate.ts`, `src/mcp/tools/*.ts` (every `SOLO_USER` call site)
- Test: existing suite + `test/mcp-identity-attribution.test.ts`

Mechanics — no behavior change in env mode, pure plumbing:

1. `createMcpServer(identity: RequestIdentity)` — replace the bare `scope` threading with a session context:

```ts
export interface SessionCtx {
  scope: SessionScope;
  identity: RequestIdentity;
}
```

   Every `registerXxxTools(server, scope)` becomes `registerXxxTools(server, ctx)`; register functions that today take only `server` (edges, mirrors, sync) also gain `ctx` so they can attribute audits.
2. In each tool file, replace `SOLO_USER` with `ctx.identity.userId` and delete the `SOLO_USER` import. Call sites today (verify with grep, the list may have drifted): `src/mcp/transport.ts:118`, `src/mcp/list-scope-gate.ts:34,36,80`, `src/mcp/tools/actors.ts:31,55,125`, `src/mcp/tools/nodes.ts:54,124,190,260,301,314,316`, `src/mcp/tools/scope.ts:55` + any others surfaced by the grep in step 3.
3. `src/mcp/transport.ts`: `handle(req, res)` becomes `handle(req, res, identity: RequestIdentity)`; `createMcpServer(identity)` at session creation; the auto-seed `auditFn` uses `identity.userId`. **Session pinning:** store `identity.userId` in the `SessionEntry`; on subsequent requests for an existing session, verify the resolved identity's `userId` matches the stored one — mismatch → 403 (prevents session hijack across users sharing a server).
4. `src/http/server.ts` passes the identity from Task 9 into `mcp.handle`.

- [ ] **Step 1: Write the failing attribution test**

```ts
// test/mcp-identity-attribution.test.ts
// Boots the MCP server in-process the same way test/mcp-smoke.test.ts
// does (read it first; reuse its initialize/tool-call helpers). Then:
// 1. initialize an MCP session (env mode),
// 2. call portuni_create_node (any minimal valid org-scoped node),
// 3. assert the audit_log row for the create has user_id = SOLO_USER
//    (env identity), not a hardcoded literal elsewhere,
// 4. assert nodes.created_by = SOLO_USER.
// The point: after the refactor the attribution flows from the request
// identity; when google mode lands, the same path stamps real users.
```

(Write it as a real test following mcp-smoke's bootstrapping; the assertion targets are the `audit_log` and `nodes` tables of the in-process DB.)

- [ ] **Step 2: Run it — must pass BEFORE the refactor too**

Run: `node --import tsx --test test/mcp-identity-attribution.test.ts`
Expected: PASS already (SOLO_USER is the env identity). This test is the regression net for the refactor, not a red-first test.

- [ ] **Step 3: Refactor**

Apply the mechanics above. Then verify no orphan call sites:

Run: `grep -rn "SOLO_USER" src/mcp/`
Expected: zero matches.

Run: `grep -rn "SOLO_USER" src/ --include="*.ts" | grep -v "infra/schema.ts" | grep -v "domain/sync"`
Expected: only `src/http/middleware.ts` (identity context) remains. (`src/domain/sync/mirror-create.ts` imports SOLO_USER for the per-device mirror registry — that is plan-4 territory, leave it.)

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS — including `mcp-smoke`, `auto-seed-scope`, `mcp-stdio` (the stdio entry constructs its own identity: give `src/mcp/stdio-entry.ts` the EnvAdapter-derived identity, same values as before).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/ src/http/server.ts test/mcp-identity-attribution.test.ts
git commit -m "refactor(mcp): thread request identity through sessions, drop SOLO_USER literals"
```

---

### Task 12: Thread identity through REST handlers

**Files:**
- Modify: `src/api/*.ts` (handlers that write — nodes, edges, events, actors, responsibilities, data-sources, tools, files)
- Modify: `src/api/router.ts` (pass identity into handlers)
- Test: extend `test/rest-smoke.test.ts` expectations only if it asserts attribution; otherwise existing suite is the net

Mechanics: same as Task 11 for the REST side. Find the user-attribution points:

Run: `grep -rn "SOLO_USER\|created_by" src/api/ | grep -v test`

Every handler that stamps `created_by` or calls `logAudit` gets an `identity: RequestIdentity` parameter from the router and uses `identity.userId`. Read-only handlers can skip the parameter. Keep handler signatures consistent: `(req, res, identity, ...pathParams)`.

- [ ] **Step 1: Refactor with grep-driven checklist** (each match from the grep above → fixed)

- [ ] **Step 2: Verify**

Run: `grep -rn "SOLO_USER" src/api/`
Expected: zero matches.

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/api/
git commit -m "refactor(api): REST handlers attribute writes to request identity"
```

---

### Task 13: Global role enforcement (tool + route min-scope)

**Files:**
- Create: `src/auth/min-scopes.ts`
- Modify: `src/mcp/server.ts` (central tool gate)
- Modify: `src/api/router.ts` (route gate before dispatch)
- Test: `test/auth-enforcement-global.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/auth-enforcement-global.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOL_MIN_SCOPE,
  minScopeForRoute,
} from "../src/auth/min-scopes.js";
import { scopeAtLeast } from "../src/auth/roles.js";

test("every registered MCP tool has an explicit min scope", async () => {
  // createMcpServer registers 46 tools (grep '\.tool(' src/mcp/tools).
  // Rather than duplicating the list here, assert the map is non-trivial
  // and spot-check the spec table (specs.md:177-182).
  assert.ok(Object.keys(TOOL_MIN_SCOPE).length >= 40);
  assert.equal(TOOL_MIN_SCOPE.portuni_get_node, "read");
  assert.equal(TOOL_MIN_SCOPE.portuni_log, "write");
  assert.equal(TOOL_MIN_SCOPE.portuni_create_node, "manage");
  assert.equal(TOOL_MIN_SCOPE.portuni_delete_node, "admin");
});

test("route matcher maps method+path to scope", () => {
  assert.equal(minScopeForRoute("GET", "/graph"), "read");
  assert.equal(minScopeForRoute("POST", "/events"), "write");
  assert.equal(minScopeForRoute("POST", "/nodes"), "manage");
  assert.equal(minScopeForRoute("DELETE", "/nodes/01ABC"), "admin");
  assert.equal(minScopeForRoute("GET", "/me"), "read");
});

test("scope comparison drives allow/deny", () => {
  assert.equal(scopeAtLeast("write", TOOL_MIN_SCOPE.portuni_create_node), false);
  assert.equal(scopeAtLeast("manage", TOOL_MIN_SCOPE.portuni_create_node), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth-enforcement-global.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/auth/min-scopes.ts` — build the complete `TOOL_MIN_SCOPE` map by enumerating every `server.tool(` registration (46 today — grep before writing; the canonical mapping rule from specs.md:177-182):

- `read`: get_context, get_node, list_nodes, list_events, list_files, list_actors, get_actor, list_responsibilities, list_data_sources, list_tools, list_remotes, status, session_init, session_log, resolve, expand_scope
- `write`: log, store, supersede, snapshot, pull, mirror, move_file, adopt_files, rename_folder
- `manage`: create_node, update_node, move_node, connect, disconnect, create_actor, update_actor, create_responsibility, update_responsibility, assign_responsibility, unassign_responsibility, add_data_source, update/remove_data_source, add_tool, remove_tool, set_routing_policy, setup_remote
- `admin`: delete_node, delete_actor, delete_responsibility, delete_file

(The executor must reconcile this list against the actual tool names — `grep -o 'portuni_[a-z_]*' src/mcp/tools/*.ts | sort -u` — and place each in the spec-correct tier; unmapped tools must make the gate throw at registration time, not default-allow.)

`minScopeForRoute(method, pathname)` — ordered prefix/regex table for the REST routes in `src/api/router.ts`; default for unmatched routes is `"admin"` (fail-closed), `GET` routes default `"read"`, mutations default `"manage"` only via explicit entries.

Central MCP gate in `createMcpServer` (all tools register via `server.tool(...)` — 46 call sites, verified):

```ts
function gateToolsByScope(server: McpServer, identity: RequestIdentity): void {
  const original = server.tool.bind(server);
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (
    ...args: unknown[]
  ) => {
    const name = args[0] as string;
    const min = TOOL_MIN_SCOPE[name];
    if (!min) throw new Error(`Tool ${name} missing from TOOL_MIN_SCOPE`);
    const handlerIdx = args.length - 1;
    const handler = args[handlerIdx] as (...h: unknown[]) => Promise<unknown>;
    args[handlerIdx] = async (...h: unknown[]) => {
      if (!scopeAtLeast(identity.globalScope, min)) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "forbidden",
              required_scope: min,
              your_scope: identity.globalScope,
            }),
          }],
          isError: true,
        };
      }
      return handler(...h);
    };
    return original(...(args as Parameters<typeof original>));
  };
}
```

Call `gateToolsByScope(server, identity)` in `createMcpServer` **before** any `registerXxxTools` call. REST: in `routeApiRequest`, before dispatch:

```ts
  const required = minScopeForRoute(req.method ?? "GET", url.pathname);
  if (!scopeAtLeast(identity.globalScope, required)) {
    respondJson(res, 403, { error: "forbidden", required_scope: required });
    return true;
  }
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test test/auth-enforcement-global.test.ts` then `npm test`.
Expected: PASS (env mode identity is admin, so existing tests are unaffected; the registration-time throw catches any tool missing from the map immediately in mcp-smoke).

- [ ] **Step 5: Commit**

```bash
git add src/auth/min-scopes.ts src/mcp/server.ts src/api/router.ts test/auth-enforcement-global.test.ts
git commit -m "feat(auth): global role enforcement for MCP tools and REST routes"
```

---

### Task 14: Node-level group visibility

**Files:**
- Create: `src/auth/node-access.ts`
- Modify: `src/mcp/scope.ts` (`loadNodeScopeMeta`, `decideRead`/`guardNodeRead` callers get group check)
- Modify: `src/mcp/list-scope-gate.ts` + list/search/context tools (filter hidden nodes)
- Test: `test/auth-node-access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/auth-node-access.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import { makeSharedDb } from "./helpers/shared-db.js";
import {
  effectiveAccessGroup,
  canSeeNode,
} from "../src/auth/node-access.js";

const SOLO = "01SOLO0000000000000000000";

async function addNode(db: any, parentId: string, visibility: string, accessGroup?: string) {
  const id = ulid();
  const meta = accessGroup ? JSON.stringify({ access_group: accessGroup }) : null;
  await db.execute({
    sql: `INSERT INTO nodes (id, type, name, status, visibility, meta, sync_key, created_by)
          VALUES (?, 'project', 'n', 'active', ?, ?, ?, ?)`,
    args: [id, visibility, meta, `project:n-${id}`, SOLO],
  });
  await db.execute({
    sql: `INSERT INTO edges (id, source_id, target_id, relation, created_by)
          VALUES (?, ?, ?, 'belongs_to', ?)`,
    args: [ulid(), id, parentId, SOLO],
  });
  return id;
}

test("group node yields its own access group", async () => {
  const { db, orgId } = await makeSharedDb();
  const a = await addNode(db, orgId, "group", "apollo@x.com");
  assert.equal(await effectiveAccessGroup(db, a), "apollo@x.com");
});

test("child inherits nearest restricted ancestor via belongs_to", async () => {
  const { db, orgId } = await makeSharedDb();
  const restricted = await addNode(db, orgId, "group", "apollo@x.com");
  const child = await addNode(db, restricted, "team");
  assert.equal(await effectiveAccessGroup(db, child), "apollo@x.com");
});

test("unrestricted chain yields null", async () => {
  const { db, orgId, nodeId } = await makeSharedDb();
  assert.equal(await effectiveAccessGroup(db, nodeId), null);
  assert.equal(await effectiveAccessGroup(db, orgId), null);
});

test("canSeeNode: members and admins see, others do not", () => {
  const member = { globalScope: "write", groups: ["apollo@x.com"] };
  const outsider = { globalScope: "manage", groups: ["other@x.com"] };
  const admin = { globalScope: "admin", groups: [] };
  assert.equal(canSeeNode(member as any, "apollo@x.com"), true);
  assert.equal(canSeeNode(outsider as any, "apollo@x.com"), false);
  assert.equal(canSeeNode(admin as any, "apollo@x.com"), true);
  assert.equal(canSeeNode(outsider as any, null), true, "unrestricted node");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/auth-node-access.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the access module**

```ts
// src/auth/node-access.ts
// Node-level access via project Google Groups (spec §3). A node with
// visibility='group' carries meta.access_group; descendants inherit the
// nearest restricted ancestor along the belongs_to chain (org invariant
// guarantees a single scoping parent, so the walk is unambiguous).
// Semantics: non-members do not see the node AT ALL (decided in the
// 2026-06-09 design session, superseding the read-only fallback in
// specs.md:203).

import type { Client } from "@libsql/client";
import type { GlobalScope } from "./roles.js";

interface GroupIdentityView {
  globalScope: GlobalScope;
  groups: string[];
}

const MAX_CHAIN = 50; // cycle guard; belongs_to chains are short in practice

export async function effectiveAccessGroup(
  db: Client,
  nodeId: string,
): Promise<string | null> {
  let current: string | null = nodeId;
  for (let i = 0; i < MAX_CHAIN && current; i += 1) {
    const r = await db.execute({
      sql: "SELECT visibility, meta FROM nodes WHERE id = ?",
      args: [current],
    });
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    if (row.visibility === "group") {
      try {
        const meta = JSON.parse(String(row.meta ?? "{}")) as {
          access_group?: unknown;
        };
        if (typeof meta.access_group === "string" && meta.access_group) {
          return meta.access_group.toLowerCase();
        }
      } catch {
        /* malformed meta -> treat as restricted-without-group: deny-safe */
      }
      // visibility='group' without a parseable access_group: fail closed.
      return "__unresolvable__";
    }
    const parent = await db.execute({
      sql: `SELECT target_id FROM edges WHERE source_id = ? AND relation = 'belongs_to' LIMIT 1`,
      args: [current],
    });
    current = parent.rows.length > 0 ? String(parent.rows[0].target_id) : null;
  }
  return null;
}

export function canSeeNode(
  identity: GroupIdentityView,
  accessGroup: string | null,
): boolean {
  if (accessGroup === null) return true;
  if (identity.globalScope === "admin") return true;
  return identity.groups.some((g) => g.toLowerCase() === accessGroup);
}

// Convenience one-shot used by guards and list filters.
export async function nodeVisibleTo(
  db: Client,
  identity: GroupIdentityView,
  nodeId: string,
): Promise<boolean> {
  return canSeeNode(identity, await effectiveAccessGroup(db, nodeId));
}
```

- [ ] **Step 4: Run the unit test**

Run: `node --import tsx --test test/auth-node-access.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Integrate into read/list/write paths**

1. `guardNodeRead` (`src/mcp/scope.ts:278`): add an identity parameter (the `SessionCtx` from Task 11 already reaches every caller); **before** the scope-mode logic, check `await nodeVisibleTo(db, identity, nodeId)` — when false return `{ kind: "not_found" }` (hidden, not "elicit": elicitation would leak existence).
2. List/search/context tools (`src/mcp/tools/nodes.ts` list_nodes, `src/mcp/tools/context.ts`, events/files list tools, `src/mcp/list-scope-gate.ts`): after fetching candidate rows, filter with `nodeVisibleTo` before returning. Per-row checks hit the DB; batch by collecting candidate IDs and resolving each chain once per request (memoize within the request with a `Map<string, string | null>`).
3. Write guards: every mutation that targets a node id (update_node, connect, disconnect, log/events, store/files, move_node) checks `nodeVisibleTo` first and returns the same not-found shape when hidden. Find targets: `grep -rn "node_id" src/mcp/tools/*.ts | grep -v list`.
4. REST equivalents in `src/api/nodes.ts`, `src/api/events.ts`, `src/api/files.ts`, `src/api/graph.ts` (graph view must filter hidden nodes + their edges).
5. Add an integration test inside `test/auth-node-access.test.ts`: build a graph with one group-restricted project, run the list-filter helper used by `list_nodes` with a member vs. non-member identity, assert the row is present vs. absent. (Use the same in-memory db; no HTTP needed.)

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS — env mode is admin, so default behavior is unchanged; new tests cover member/non-member paths.

- [ ] **Step 7: Commit**

```bash
git add src/auth/node-access.ts src/mcp/ src/api/ test/auth-node-access.test.ts
git commit -m "feat(auth): node-level group visibility with belongs_to inheritance"
```

---

### Task 15: Docs + env reference + final QA

**Files:**
- Modify: `docs/specs.md:195-215` (security model: group visibility = hidden, not read-only fallback; mark group visibility as implemented)
- Modify: `docs-site/src/content/docs/getting-started/roadmap.md:38` (multi-user: server-side identity landed, deployment pending)
- Modify: `docs-site/src/content/docs/concepts/scope-enforcement.md:139` (note groups enforcement now exists server-side)
- Modify: `.env.schema` / varlock env declaration (whichever file declares `PORTUNI_AUTH_TOKEN` — find with `grep -rn "PORTUNI_AUTH_TOKEN" .env* env.d.ts` — add: `PORTUNI_AUTH_MODE`, `PORTUNI_JWT_SECRET`, `PORTUNI_GOOGLE_CLIENT_IDS`, `PORTUNI_ALLOWED_DOMAIN`, `PORTUNI_GOOGLE_SA_KEY_JSON`, `PORTUNI_GOOGLE_IMPERSONATE`, `PORTUNI_GROUPS_ADMIN`, `PORTUNI_GROUPS_MANAGE`, `PORTUNI_GROUPS_WRITE`)
- Modify: `CLAUDE.md` (one line in Gotchas: auth mode env vs google, where enforcement lives)

- [ ] **Step 1: Update the docs** per the list above. In specs.md replace the "Planned, not yet implemented" row for `group` visibility (line 201) and the fallback sentence (line 203) with the implemented hidden-semantics, referencing the design spec.

- [ ] **Step 2: Full QA gate**

Run: `npm run qa`
Expected: lint + typecheck + tests + build all green.

- [ ] **Step 3: Commit**

```bash
git add docs/specs.md docs-site/ CLAUDE.md .env.schema
git commit -m "docs: security model reflects implemented Google Groups enforcement"
```

---

## Out of scope for this plan (do not implement here)

- Deployment to the utilities VPS, Caddy/TLS, DNS for api.portuni.com (plan 2)
- Desktop PKCE login flow, settings user info, token management UI (plan 3)
- Sync-agent REST migration, `portuni_mirror` remote MCP regen, shared Turso token revocation (plan 4)
- Rate limiting (plan 2, alongside deployment)
- Google Workspace admin setup (manual checklist in the design spec §6)
