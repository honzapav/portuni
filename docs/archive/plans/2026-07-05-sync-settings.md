# Sync Settings (one-button Drive connect) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User connects Google Drive from Settings with one OAuth click; agents get self-guiding errors and an MCP prompt for the service-account path.

**Architecture:** Desktop Rust runs the existing PKCE loopback flow with a Drive scope and hands the refresh token straight to the sidecar over loopback REST (webview never sees tokens). The sidecar owns credentials via its token store, gains a refresh-token auth mode in the Drive adapter, and exposes five `/sync/drive/*` REST endpoints consumed by a new Settings tab.

**Tech Stack:** Node 24 + TypeScript (ESM, `node:test`), libSQL, React + Vite, Tauri 2 (Rust), Google Drive REST v3.

**Spec:** `docs/superpowers/specs/2026-07-05-sync-settings-design.md`

## Global Constraints

- Security rule 1: no secret ever reaches webview JS. Tokens travel Rust → sidecar loopback only.
- Security rule 2: no secret in plaintext on disk; credentials go through the sidecar token store (`getTokenStore()`).
- UI copy is Czech with diacritics; never use emoji in code; dashes per typography rule (spaced en dash in Czech copy).
- Tests run with `npm test` (`node --import tsx --test test/*.test.ts`); run a single file as `node --import tsx --test test/<file>.test.ts`.
- TypeScript build check: `npm run build` (server) — must stay clean after every task.
- Fixed single UI remote name: `gdrive`. Existing SA-configured remotes must keep working unchanged.
- Existing behavior of MCP tools `portuni_setup_remote` / `portuni_set_routing_policy` / `portuni_list_remotes` must not change.

---

### Task 1: Token model + Drive config relaxation

**Files:**
- Modify: `apps/server/domain/sync/types.ts:44-51` (DeviceToken)
- Modify: `apps/server/domain/sync/drive-config.ts:3-18` (DriveConfig, parseDriveConfig)
- Test: `test/sync-drive-config.test.ts` (extend existing file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `DeviceToken.mode` gains `"refresh_token"`; new optional fields `client_id`, `client_secret`, `account_email`. `DriveConfig` becomes `{ shared_drive_id?: string; root_folder_id?: string }`; `parseDriveConfig(raw)` now only requires *at least one* of the two ids. New export `assertSaDriveConfig(cfg: DriveConfig): void` throws the old "Personal My Drive is not supported" error when `shared_drive_id` is missing (used by the SA path in Task 3).

- [ ] **Step 1: Write the failing tests** — append to `test/sync-drive-config.test.ts`:

```ts
describe("parseDriveConfig (refresh-token era)", () => {
  it("accepts root_folder_id-only config (My Drive)", () => {
    const cfg = parseDriveConfig({ root_folder_id: "F1" });
    assert.equal(cfg.root_folder_id, "F1");
    assert.equal(cfg.shared_drive_id, undefined);
  });

  it("still accepts shared_drive_id-only config", () => {
    const cfg = parseDriveConfig({ shared_drive_id: "D1" });
    assert.equal(cfg.shared_drive_id, "D1");
  });

  it("rejects config with neither id", () => {
    assert.throws(() => parseDriveConfig({}), /shared_drive_id or root_folder_id/);
  });

  it("assertSaDriveConfig rejects My Drive for service accounts", () => {
    assert.throws(
      () => assertSaDriveConfig(parseDriveConfig({ root_folder_id: "F1" })),
      /Personal My Drive is not supported/,
    );
    assertSaDriveConfig(parseDriveConfig({ shared_drive_id: "D1" })); // no throw
  });
});
```

Add `assertSaDriveConfig` to the existing import from `drive-config.js` at the top of the test file.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test test/sync-drive-config.test.ts`
Expected: FAIL — `assertSaDriveConfig` not exported; "neither id" case currently throws a different message.

- [ ] **Step 3: Implement** — in `apps/server/domain/sync/drive-config.ts` replace the interface and `parseDriveConfig`:

```ts
export interface DriveConfig {
  shared_drive_id?: string;
  root_folder_id?: string;
}

export function parseDriveConfig(raw: Record<string, unknown>): DriveConfig {
  const out: DriveConfig = {};
  if (typeof raw.shared_drive_id === "string" && raw.shared_drive_id.length > 0) {
    out.shared_drive_id = raw.shared_drive_id;
  }
  if (typeof raw.root_folder_id === "string" && raw.root_folder_id.length > 0) {
    out.root_folder_id = raw.root_folder_id;
  }
  if (!out.shared_drive_id && !out.root_folder_id) {
    throw new Error("Drive config requires shared_drive_id or root_folder_id.");
  }
  return out;
}

// Service accounts have no My Drive storage quota; they can only write
// into a shared drive. User-OAuth (refresh_token) remotes have no such
// restriction, so this check lives outside parseDriveConfig.
export function assertSaDriveConfig(cfg: DriveConfig): void {
  if (!cfg.shared_drive_id) {
    throw new Error("Drive config requires shared_drive_id. Personal My Drive is not supported.");
  }
}
```

In `apps/server/domain/sync/types.ts` extend `DeviceToken`:

```ts
export interface DeviceToken {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  service_account_json?: string;
  mode?: "oauth" | "service_account" | "refresh_token";
  client_id?: string;
  client_secret?: string;
  account_email?: string;
}
```

- [ ] **Step 4: Run tests + build**

Run: `node --import tsx --test test/sync-drive-config.test.ts && npm run build`
Expected: PASS, clean build. If the build reports other callers of `cfg.shared_drive_id` now possibly-undefined (drive-adapter), leave them for Task 3 ONLY if the compiler is silent; if the compiler complains now, add `!` assertions at the flagged drive-adapter lines with a `// TODO(Task 3)` comment and remove them in Task 3.

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/sync/types.ts apps/server/domain/sync/drive-config.ts test/sync-drive-config.test.ts
git commit -m "feat(sync): relax Drive config for user OAuth, extend DeviceToken"
```

---

### Task 2: Refresh-token auth module (`drive-user-auth.ts`)

**Files:**
- Create: `apps/server/domain/sync/drive-user-auth.ts`
- Test: `test/sync-drive-user-auth.test.ts`

**Interfaces:**
- Consumes: `DeviceToken` from Task 1.
- Produces:
  - `class DriveAuthError extends Error { code: "TOKEN_INVALID" }`
  - `getUserAccessToken(t: DeviceToken): Promise<string>` — requires `t.refresh_token`, `t.client_id`, `t.client_secret`; caches per refresh token until expiry (120 s safety window, same as SA auth); throws `DriveAuthError` on `invalid_grant`.
  - `__setUserTokenFetchForTests(f)` and `resetUserTokenCacheForTests()`.

- [ ] **Step 1: Write the failing test** — `test/sync-drive-user-auth.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getUserAccessToken,
  DriveAuthError,
  __setUserTokenFetchForTests,
  resetUserTokenCacheForTests,
} from "../apps/server/domain/sync/drive-user-auth.js";

const TOKEN = { mode: "refresh_token" as const, refresh_token: "R1", client_id: "C1", client_secret: "S1" };

beforeEach(() => resetUserTokenCacheForTests());

describe("getUserAccessToken", () => {
  it("exchanges the refresh token and caches until expiry", async () => {
    let calls = 0;
    __setUserTokenFetchForTests(async (params) => {
      calls += 1;
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("refresh_token"), "R1");
      assert.equal(params.get("client_id"), "C1");
      return { access_token: "A1", expires_in: 3600 };
    });
    assert.equal(await getUserAccessToken(TOKEN), "A1");
    assert.equal(await getUserAccessToken(TOKEN), "A1");
    assert.equal(calls, 1);
  });

  it("throws DriveAuthError(TOKEN_INVALID) on invalid_grant", async () => {
    __setUserTokenFetchForTests(async () => {
      throw new DriveAuthError("invalid_grant: Token has been revoked");
    });
    await assert.rejects(getUserAccessToken(TOKEN), (e: unknown) => {
      assert.ok(e instanceof DriveAuthError);
      assert.equal(e.code, "TOKEN_INVALID");
      return true;
    });
  });

  it("rejects tokens missing refresh_token/client_id/client_secret", async () => {
    await assert.rejects(getUserAccessToken({ mode: "refresh_token" }), /refresh_token/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-drive-user-auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `apps/server/domain/sync/drive-user-auth.ts`:

```ts
// User-OAuth counterpart of drive-sa-auth: exchanges a stored Google
// refresh token for a short-lived access token. Endpoint is hardcoded to
// Google's OAuth server -- the refresh token grant must never be POSTed
// anywhere else (same reasoning as assertSafeTokenUri for SA).
import type { DeviceToken } from "./types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SAFETY_WINDOW_S = 120;
const cache = new Map<string, { access_token: string; expires_at: number }>();

export function resetUserTokenCacheForTests(): void { cache.clear(); }

export class DriveAuthError extends Error {
  readonly code = "TOKEN_INVALID";
  constructor(message: string) { super(message); this.name = "DriveAuthError"; }
}

type TokenFetch = (params: URLSearchParams) => Promise<{ access_token: string; expires_in: number }>;

let tokenFetch: TokenFetch = async (params) => {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    if (text.includes("invalid_grant")) throw new DriveAuthError(`Google refresh rejected: ${text}`);
    throw new Error(`Google token endpoint: ${res.status} ${text}`);
  }
  const b = JSON.parse(text) as Record<string, unknown>;
  if (typeof b.access_token !== "string") throw new Error("token response missing access_token");
  return { access_token: b.access_token, expires_in: Number(b.expires_in ?? 3600) };
};

export function __setUserTokenFetchForTests(f: TokenFetch): void { tokenFetch = f; }

export async function getUserAccessToken(t: DeviceToken): Promise<string> {
  if (!t.refresh_token || !t.client_id || !t.client_secret) {
    throw new Error("refresh_token mode requires refresh_token, client_id and client_secret");
  }
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(t.refresh_token);
  if (hit && hit.expires_at - now > SAFETY_WINDOW_S) return hit.access_token;
  const { access_token, expires_in } = await tokenFetch(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: t.client_id,
    client_secret: t.client_secret,
  }));
  cache.set(t.refresh_token, { access_token, expires_at: now + expires_in });
  return access_token;
}
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test test/sync-drive-user-auth.test.ts && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/sync/drive-user-auth.ts test/sync-drive-user-auth.test.ts
git commit -m "feat(sync): refresh-token auth module for Drive user OAuth"
```

---

### Task 3: Drive adapter refresh-token mode

**Files:**
- Modify: `apps/server/domain/sync/drive-adapter.ts` (createDriveAdapter head, authHeaders, every list call that sets `driveId`/`corpora`)
- Test: `test/sync-drive-adapter-user.test.ts`

**Interfaces:**
- Consumes: `getUserAccessToken`, `DriveAuthError` (Task 2), `assertSaDriveConfig` (Task 1).
- Produces: `createDriveAdapter(remote, tokens)` accepts a token with `mode: "refresh_token"`; config without `shared_drive_id` queries `corpora: "user"`. Signature unchanged — Tasks 4+ just rely on the behavior.

- [ ] **Step 1: Write the failing test** — `test/sync-drive-adapter-user.test.ts`:

```ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createDriveAdapter, __setDriveFetchForTests } from "../apps/server/domain/sync/drive-adapter.js";
import { __setUserTokenFetchForTests, resetUserTokenCacheForTests } from "../apps/server/domain/sync/drive-user-auth.js";

const REMOTE = { name: "gdrive", type: "gdrive" as const, config: { root_folder_id: "ROOT" } };
const TOKENS = { gdrive: { mode: "refresh_token" as const, refresh_token: "R1", client_id: "C", client_secret: "S" } };

beforeEach(() => resetUserTokenCacheForTests());

describe("drive adapter in refresh-token mode", () => {
  it("lists without driveId/corpora=drive and with the user access token", async () => {
    __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
    const seen: string[] = [];
    __setDriveFetchForTests((async (url: string, init?: RequestInit) => {
      seen.push(url);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer UAT");
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }) as typeof fetch);
    const adapter = createDriveAdapter(REMOTE, TOKENS);
    await adapter.list("");
    assert.ok(seen.length >= 1);
    const q = new URL(seen[0]).searchParams;
    assert.equal(q.get("driveId"), null);
    assert.notEqual(q.get("corpora"), "drive");
  });

  it("still refuses SA tokens without shared_drive_id", () => {
    const saTokens = { gdrive: { mode: "service_account" as const, service_account_json: "{}" } };
    assert.throws(() => createDriveAdapter(REMOTE, saTokens), /Personal My Drive is not supported/);
  });

  it("refuses a remote with no usable credentials", () => {
    assert.throws(() => createDriveAdapter(REMOTE, {}), /no credentials/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-drive-adapter-user.test.ts`
Expected: FAIL — adapter throws "no service account credentials".

- [ ] **Step 3: Implement.** In `createDriveAdapter`, replace the credential head (currently lines ~36-43) with mode dispatch:

```ts
const cfg: DriveConfig = parseDriveConfig(remote.config);
const t = tokens[remote.name];
let getAccessToken: () => Promise<string>;
if (t?.mode === "refresh_token" && t.refresh_token) {
  getAccessToken = () => getUserAccessToken(t);
} else if (t?.service_account_json) {
  assertSaDriveConfig(cfg);
  const sa: ServiceAccountKey = parseServiceAccountJson(t.service_account_json);
  getAccessToken = () => getDriveAccessToken(sa);
} else {
  throw new Error(
    `Drive remote ${remote.name}: no credentials on this device. Connect Google Drive in Nastavení → Synchronizace, or run portuni_setup_remote with service_account_json.`,
  );
}
const driveRoot = cfg.root_folder_id ?? cfg.shared_drive_id!;
```

`authHeaders()` becomes `return { Authorization: \`Bearer ${await getAccessToken()}\` };`.

Then update every URLSearchParams that sets `driveId: cfg.shared_drive_id, corpora: "drive"` (four sites: `resolvePathToFileId`, the two list paths around lines 100 and 205, plus any search in `stat`): extract a helper right after `withSAD`:

```ts
function withCorpora(params: URLSearchParams): URLSearchParams {
  if (cfg.shared_drive_id) {
    params.set("driveId", cfg.shared_drive_id);
    params.set("corpora", "drive");
  } else {
    params.set("corpora", "user");
  }
  return params;
}
```

and replace the literal `driveId/corpora` entries at those call sites with `withCorpora(...)` wrapping. `includeItemsFromAllDrives`/`supportsAllDrives` stay as they are (harmless for My Drive). Import `getUserAccessToken` from `./drive-user-auth.js` and `assertSaDriveConfig` from `./drive-config.js`. Remove any `// TODO(Task 3)` assertions left by Task 1.

- [ ] **Step 4: Run the new test plus the existing Drive suites**

Run: `node --import tsx --test test/sync-drive-adapter-user.test.ts test/sync-drive-config.test.ts test/sync-drive-smoke.test.ts && npm run build`
Expected: all PASS (SA behavior unchanged), clean build.

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/sync/drive-adapter.ts test/sync-drive-adapter-user.test.ts
git commit -m "feat(sync): drive adapter supports user OAuth refresh-token mode"
```

---

### Task 4: Domain service — extract + Drive connect/target/status/test/disconnect

**Files:**
- Create: `apps/server/domain/sync/remote-service.ts`
- Modify: `apps/server/mcp/tools/sync-remotes.ts` (delete the moved functions, import them instead; tool registrations unchanged)
- Test: `test/sync-remote-service.test.ts`

**Interfaces:**
- Consumes: `upsertRemote/getRemote/listRemotes/deleteRemote/addRule/listRules/replaceRules` (`routing.ts`), `getTokenStore`, `getUserAccessToken`/`DriveAuthError` (Task 2), `invalidateAdapter` (`adapter-cache.ts`).
- Produces (all exported from `remote-service.ts`; `GDRIVE_REMOTE = "gdrive"`):
  - moved as-is: `setupRemoteService(db, args)`, `setRoutingPolicyService(db, rules)`, `listRemotesService(db)` (+ `SetupRemoteArgs`, `RemoteListing` types).
  - `connectDrive(db, a: { userId: string; refresh_token: string; client_id: string; client_secret: string; account_email: string }): Promise<{ account_email: string; shared_drives: { id: string; name: string }[] }>`
  - `listDriveTargets(): Promise<{ id: string; name: string }[] | null>` — `null` when no refresh-token entry is stored (REST maps it to 409 `not_connected`)
  - `setDriveTarget(db, a: { userId: string; shared_drive_id?: string; my_drive?: boolean }): Promise<{ target: DriveTargetInfo }>`
  - `driveStatus(db): Promise<DriveStatus>` where `type DriveTargetInfo = { kind: "my_drive" | "shared_drive"; name: string }` and `type DriveStatus = { configured: boolean; connected: boolean; account_email: string | null; target: DriveTargetInfo | null }`
  - `testDrive(db): Promise<{ ok: true } | { ok: false; code: "TOKEN_INVALID" | "TARGET_NOT_FOUND" | "DRIVE_UNREACHABLE"; detail: string }>`
  - `disconnectDrive(db): Promise<void>`
  - `__setDriveRestFetchForTests(f: typeof fetch)` — hook for the module's direct Drive REST calls (drives.list, folder ensure, test list).

Semantics pinned here (implement exactly):
- `connectDrive`: token store `write("gdrive", { mode: "refresh_token", refresh_token, client_id, client_secret, account_email })`, then `invalidateAdapter("gdrive")`, then returns `account_email` + `drives.list` result (`GET https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=drives(id,name)`). A drives.list failure does NOT roll back the token (spec: user resumes at target selection).
- `setDriveTarget` with `my_drive`: find-or-create folder `Portuni` in the My Drive root (`q = name='Portuni' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`; create via `POST /files` with `{name:"Portuni", mimeType:"application/vnd.google-apps.folder"}` when absent), store config `{ root_folder_id }`. With `shared_drive_id`: config `{ shared_drive_id }`. Both: `upsertRemote(db, { name: "gdrive", type: "gdrive", config, created_by: a.userId })`; then `if ((await listRules(db)).length === 0) await addRule(db, { priority: 1, node_type: null, org_slug: null, remote_name: "gdrive" })`; `invalidateAdapter("gdrive")`.
- `driveStatus`: `configured` = gdrive remote row exists AND token store has a `refresh_token`-mode entry; `connected` = token entry exists (even without remote row); `target` derived from the remote config (`shared_drive` name is looked up lazily — store the drive name into the config as `target_name` at `setDriveTarget` time so status needs no Drive API call; for `my_drive` the name is `"Můj disk – složka Portuni"`).
- `testDrive`: `GET /files?q='<root>' in parents and trashed=false&pageSize=1` (plus `driveId`/`corpora=drive`/`supportsAllDrives=true`/`includeItemsFromAllDrives=true` when shared drive) using `getUserAccessToken`; `DriveAuthError → TOKEN_INVALID`; HTTP 404 → `TARGET_NOT_FOUND`; fetch throw / 5xx → `DRIVE_UNREACHABLE`.
- `disconnectDrive`: `replaceRules(db, (await listRules(db)).filter(r => r.remote_name !== "gdrive"))` → `deleteRemote(db, "gdrive")` → `(await getTokenStore()).delete("gdrive")` → `invalidateAdapter("gdrive")` — in that order (routing FK is ON DELETE RESTRICT).

- [ ] **Step 1: Write the failing tests** — `test/sync-remote-service.test.ts`. Use `makeSharedDb` for the db and `PORTUNI_TOKEN_STORE=file` + a temp `PORTUNI_WORKSPACE_ROOT` (mirrors the beforeEach/afterEach pattern at the top of `test/sync-remote-api.test.ts`, plus `resetTokenStoreForTests()` from `token-store.js`):

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSharedDb } from "./helpers/shared-db.js";
import { getTokenStore, resetTokenStoreForTests } from "../apps/server/domain/sync/token-store.js";
import { listRules } from "../apps/server/domain/sync/routing.js";
import { resetUserTokenCacheForTests, __setUserTokenFetchForTests } from "../apps/server/domain/sync/drive-user-auth.js";
import {
  connectDrive, setDriveTarget, driveStatus, testDrive, disconnectDrive,
  __setDriveRestFetchForTests,
} from "../apps/server/domain/sync/remote-service.js";

let workspace: string;
const CONN = { userId: "U1", refresh_token: "R1", client_id: "C", client_secret: "S", account_email: "a@b.cz" };

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "portuni-remotesvc-"));
  process.env.PORTUNI_WORKSPACE_ROOT = workspace;
  process.env.PORTUNI_TOKEN_STORE = "file";
  resetTokenStoreForTests();
  resetUserTokenCacheForTests();
  __setUserTokenFetchForTests(async () => ({ access_token: "UAT", expires_in: 3600 }));
});

afterEach(async () => {
  resetTokenStoreForTests();
  delete process.env.PORTUNI_TOKEN_STORE;
  await rm(workspace, { recursive: true, force: true });
});

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("connectDrive + setDriveTarget", () => {
  it("stores the token, lists drives, sets target and wildcard routing", async () => {
    const { db } = await makeSharedDb();
    __setDriveRestFetchForTests((async (url: string) =>
      url.includes("/drives") ? okJson({ drives: [{ id: "D1", name: "Tým" }] }) : okJson({ files: [] })
    ) as typeof fetch);
    const r = await connectDrive(db, CONN);
    assert.deepEqual(r.shared_drives, [{ id: "D1", name: "Tým" }]);
    const stored = await (await getTokenStore()).read("gdrive");
    assert.equal(stored?.refresh_token, "R1");
    assert.equal(stored?.mode, "refresh_token");

    await setDriveTarget(db, { userId: "U1", shared_drive_id: "D1" });
    // makeSharedDb seeds a routing rule for its test-fs remote, so the
    // wildcard must NOT be added (only-if-empty guard):
    const rules = await listRules(db);
    assert.ok(rules.some((x) => x.remote_name === "test-fs"));
    assert.ok(rules.every((x) => x.remote_name !== "gdrive"));
    const s = await driveStatus(db);
    assert.equal(s.configured, true);
    assert.equal(s.account_email, "a@b.cz");
    assert.equal(s.target?.kind, "shared_drive");
  });

  it("my_drive target creates the Portuni folder when missing", async () => {
    const { db } = await makeSharedDb();
    const posted: string[] = [];
    __setDriveRestFetchForTests((async (url: string, init?: RequestInit) => {
      if (url.includes("/drives")) return okJson({ drives: [] });
      if (init?.method === "POST") { posted.push(String(init.body)); return okJson({ id: "NEW" }); }
      return okJson({ files: [] }); // folder search: not found
    }) as typeof fetch);
    await connectDrive(db, CONN);
    const t = await setDriveTarget(db, { userId: "U1", my_drive: true });
    assert.equal(t.target.kind, "my_drive");
    assert.ok(posted[0]?.includes("Portuni"));
  });
});

describe("testDrive + disconnectDrive", () => {
  it("maps auth failure to TOKEN_INVALID and 404 to TARGET_NOT_FOUND", async () => {
    const { db } = await makeSharedDb();
    __setDriveRestFetchForTests((async (url: string) =>
      url.includes("/drives") ? okJson({ drives: [] }) : okJson({ files: [] })) as typeof fetch);
    await connectDrive(db, CONN);
    await setDriveTarget(db, { userId: "U1", shared_drive_id: "D1" });

    __setDriveRestFetchForTests((async () => new Response("nope", { status: 404 })) as typeof fetch);
    assert.deepEqual((await testDrive(db)) as object, { ok: false, code: "TARGET_NOT_FOUND", detail: "nope" });

    const { DriveAuthError } = await import("../apps/server/domain/sync/drive-user-auth.js");
    __setUserTokenFetchForTests(async () => { throw new DriveAuthError("revoked"); });
    resetUserTokenCacheForTests();
    const t = await testDrive(db);
    assert.equal(t.ok, false);
    assert.equal((t as { code: string }).code, "TOKEN_INVALID");
  });

  it("disconnect removes rules, remote and token in FK-safe order", async () => {
    const { db } = await makeSharedDb();
    __setDriveRestFetchForTests((async (url: string) =>
      url.includes("/drives") ? okJson({ drives: [] }) : okJson({ files: [] })) as typeof fetch);
    await connectDrive(db, CONN);
    await setDriveTarget(db, { userId: "U1", shared_drive_id: "D1" });
    await disconnectDrive(db);
    assert.equal(await (await getTokenStore()).read("gdrive"), null);
    assert.ok((await listRules(db)).every((r) => r.remote_name !== "gdrive"));
    const s = await driveStatus(db);
    assert.equal(s.configured, false);
    assert.equal(s.connected, false);
  });
});
```

Note: before writing assertions that depend on `makeSharedDb` seeding, read `test/helpers/shared-db.ts` and adjust the routing-rule assertion in the first test to the actual seed (assert the exact expected rule set rather than the tautology above).

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-remote-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `remote-service.ts`.** Move `SetupRemoteArgs`, `setupRemoteService`, `setRoutingPolicyService`, `RemoteListing`, `listRemotesService` verbatim from `apps/server/mcp/tools/sync-remotes.ts` (lines 15–80). Then add the Drive functions per the semantics block above. Skeleton for the new parts:

```ts
export const GDRIVE_REMOTE = "gdrive";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

let restFetch: typeof fetch = globalThis.fetch.bind(globalThis);
export function __setDriveRestFetchForTests(f: typeof fetch): void { restFetch = f; }

async function driveGet(path: string, token: string): Promise<Response> {
  return restFetch(`${DRIVE_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function readGdriveToken(): Promise<DeviceToken | null> {
  const t = await (await getTokenStore()).read(GDRIVE_REMOTE);
  return t?.mode === "refresh_token" ? t : null;
}

export async function connectDrive(db: Client, a: ConnectDriveArgs) { /* per semantics */ }
export async function listDriveTargets() { /* drives.list via readGdriveToken + getUserAccessToken */ }
export async function setDriveTarget(db: Client, a: SetDriveTargetArgs) { /* per semantics */ }
export async function driveStatus(db: Client): Promise<DriveStatus> { /* per semantics */ }
export async function testDrive(db: Client) { /* per semantics */ }
export async function disconnectDrive(db: Client): Promise<void> { /* per semantics */ }
```

Every `/* per semantics */` body is fully specified in the Interfaces block — implement exactly that; no other behavior. `setDriveTarget` stores `target_name` in the remote config (`drives.list` lookup for shared drives; the literal `"Můj disk – složka Portuni"` for My Drive) so `driveStatus` never calls the Drive API.

In `apps/server/mcp/tools/sync-remotes.ts` delete the moved code and import from `../../domain/sync/remote-service.js`; the three `server.tool(...)` registrations stay byte-identical.

- [ ] **Step 4: Run the new suite + the MCP remotes suite**

Run: `node --import tsx --test test/sync-remote-service.test.ts test/sync-tool-remotes.test.ts && npm run build`
Expected: all PASS (MCP tools unchanged), clean build.

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/sync/remote-service.ts apps/server/mcp/tools/sync-remotes.ts test/sync-remote-service.test.ts
git commit -m "feat(sync): domain remote-service with Drive connect/target/status/test/disconnect"
```

---

### Task 5: REST endpoints `/sync/drive/*`

**Files:**
- Create: `apps/server/api/sync-drive.ts`
- Modify: `apps/server/api/router.ts` (dispatch before the `/sync/info-batch` line at `router.ts:402`)
- Test: `test/sync-drive-rest.test.ts`

**Interfaces:**
- Consumes: Task 4 service functions; `parseBody`, `respondJson`, `respondError`, `RequestIdentity` from `../http/middleware.js`; `getDb` from `../infra/db.js`.
- Produces: `routeSyncDrive(req, res, url, identity): Promise<boolean>` handling:
  - `POST /sync/drive/connect` — body `{ refresh_token, client_id, client_secret, account_email }` (all non-empty strings, else 400) → 200 `{ account_email, shared_drives }`
  - `GET /sync/drive/targets` → 200 `{ shared_drives }`; 409 `{ error: "not_connected" }` when no token
  - `POST /sync/drive/target` — body `{ shared_drive_id }` xor `{ my_drive: true }` (else 400) → 200 `{ target }`
  - `GET /sync/drive/status` → 200 `DriveStatus`
  - `POST /sync/drive/test` → 200 `{ ok: true }` or `{ ok: false, code, detail }`
  - `POST /sync/drive/disconnect` → 200 `{ ok: true }`

- [ ] **Step 1: Write the failing test** — `test/sync-drive-rest.test.ts`, modeled on `test/file-content-rest.test.ts` (read its server-boot helper first and reuse the same pattern: `startHttpServer({ port: 0, registerSigint: false })` + bearer from `PORTUNI_AUTH_TOKEN`). Cover: 401 without bearer on all six routes; connect happy path (with `__setDriveRestFetchForTests` + `__setUserTokenFetchForTests` stubs); 400 on connect with missing field; 400 on target with both/neither selector; status before and after connect; disconnect resets status.

```ts
// Core shape (adapt boot helper from file-content-rest.test.ts):
const paths: Array<[string, string]> = [
  ["POST", "/sync/drive/connect"], ["GET", "/sync/drive/targets"],
  ["POST", "/sync/drive/target"], ["GET", "/sync/drive/status"],
  ["POST", "/sync/drive/test"], ["POST", "/sync/drive/disconnect"],
];
it("rejects all drive routes without a bearer", async () => {
  for (const [method, p] of paths) {
    const res = await fetch(`${base}${p}`, { method });
    assert.equal(res.status, 401, p);
  }
});
it("connect → status → disconnect happy path", async () => {
  const res = await fetch(`${base}/sync/drive/connect`, {
    method: "POST", headers: authJson,
    body: JSON.stringify({ refresh_token: "R", client_id: "C", client_secret: "S", account_email: "a@b.cz" }),
  });
  assert.equal(res.status, 200);
  const st = await (await fetch(`${base}/sync/drive/status`, { headers: auth })).json();
  assert.equal(st.connected, true);
  await fetch(`${base}/sync/drive/disconnect`, { method: "POST", headers: auth });
  const st2 = await (await fetch(`${base}/sync/drive/status`, { headers: auth })).json();
  assert.equal(st2.connected, false);
});
it("connect validates body", async () => {
  const res = await fetch(`${base}/sync/drive/connect`, {
    method: "POST", headers: authJson, body: JSON.stringify({ refresh_token: "R" }),
  });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-drive-rest.test.ts`
Expected: FAIL — 404s (routes unrouted).

- [ ] **Step 3: Implement `apps/server/api/sync-drive.ts`:**

```ts
// REST surface for Nastavení → Synchronizace. Thin: parse/validate,
// delegate to domain/sync/remote-service, map typed errors to JSON.
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseBody, respondError, respondJson, type RequestIdentity } from "../http/middleware.js";
import { getDb } from "../infra/db.js";
import {
  connectDrive, disconnectDrive, driveStatus, listDriveTargets, setDriveTarget, testDrive,
} from "../domain/sync/remote-service.js";

export async function routeSyncDrive(
  req: IncomingMessage, res: ServerResponse, url: URL, identity: RequestIdentity,
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? "GET";
  if (!pathname.startsWith("/sync/drive/")) return false;
  const db = getDb();
  try {
    if (pathname === "/sync/drive/connect" && method === "POST") {
      const b = (await parseBody(req)) as Record<string, unknown> | undefined;
      const fields = ["refresh_token", "client_id", "client_secret", "account_email"] as const;
      if (!b || fields.some((f) => typeof b[f] !== "string" || (b[f] as string).length === 0)) {
        respondJson(res, 400, { error: "connect requires refresh_token, client_id, client_secret, account_email" });
        return true;
      }
      respondJson(res, 200, await connectDrive(db, {
        userId: identity.userId,
        refresh_token: b.refresh_token as string,
        client_id: b.client_id as string,
        client_secret: b.client_secret as string,
        account_email: b.account_email as string,
      }));
      return true;
    }
    if (pathname === "/sync/drive/targets" && method === "GET") {
      const drives = await listDriveTargets();
      if (drives === null) { respondJson(res, 409, { error: "not_connected" }); return true; }
      respondJson(res, 200, { shared_drives: drives });
      return true;
    }
    if (pathname === "/sync/drive/target" && method === "POST") {
      const b = (await parseBody(req)) as { shared_drive_id?: string; my_drive?: boolean } | undefined;
      const hasDrive = typeof b?.shared_drive_id === "string" && b.shared_drive_id.length > 0;
      if (!b || hasDrive === Boolean(b.my_drive)) {
        respondJson(res, 400, { error: "target requires exactly one of shared_drive_id | my_drive" });
        return true;
      }
      respondJson(res, 200, await setDriveTarget(db, { userId: identity.userId, ...b }));
      return true;
    }
    if (pathname === "/sync/drive/status" && method === "GET") {
      respondJson(res, 200, await driveStatus(db));
      return true;
    }
    if (pathname === "/sync/drive/test" && method === "POST") {
      respondJson(res, 200, await testDrive(db));
      return true;
    }
    if (pathname === "/sync/drive/disconnect" && method === "POST") {
      await disconnectDrive(db);
      respondJson(res, 200, { ok: true });
      return true;
    }
    return false;
  } catch (err) {
    respondError(res, `${method} ${pathname}`, err);
    return true;
  }
}
```

(Adjust `listDriveTargets` in Task 4 to return `null` when no token is stored — update its Produces type to `Promise<{id,name}[] | null>` and keep Task 4's test aligned.) Wire into `apps/server/api/router.ts` immediately before the `/sync/info-batch` dispatch:

```ts
if (pathname.startsWith("/sync/drive/")) {
  return routeSyncDrive(req, res, url, identity);
}
```

with the import added at the top alongside the other `./` route imports.

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test test/sync-drive-rest.test.ts test/http-hardening.test.ts && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add apps/server/api/sync-drive.ts apps/server/api/router.ts test/sync-drive-rest.test.ts
git commit -m "feat(api): /sync/drive/* REST endpoints for Drive connect flow"
```

---

### Task 6: Desktop Rust — `google_drive_connect` + prerequisite probe

**Files:**
- Modify: `apps/desktop/src/auth.rs` (new commands at the end; new `load_google_client` helper beside `load_auth_config` at `auth.rs:59`)
- Modify: `apps/desktop/src/lib.rs` (add `pub(crate) fn sidecar_port_and_token`, register both commands in the `invoke_handler` list at `lib.rs:1836` area)

**Interfaces:**
- Consumes: existing `pkce_verifier`, `pkce_challenge`, `random_state`, `start_loopback`, `percent_encode`, `exchange_code`, `active_workspace`, `BackendPorts`, `AuthTokens`.
- Produces (Tauri commands callable from the webview):
  - `google_client_configured() -> bool` — active workspace has non-empty `google_client_id` AND `google_client_secret` in config.
  - `google_drive_connect() -> Result<Value, String>` — runs OAuth with Drive scope, POSTs tokens to the sidecar, returns the sidecar's JSON body (`{ account_email, shared_drives }`) parsed as `Value`. The webview receives no token material.
- Produces (Rust-internal): `pub(crate) fn sidecar_port_and_token(app: &AppHandle, ws_id: &str) -> Result<(u16, String), String>` in `lib.rs` — extracts the snapshot logic already open-coded in `api_request` (port from `BackendPorts` with the `0` sentinel → Err("sync agent not running"), token from `AuthTokens`); refactor `api_request` to call it.

- [ ] **Step 1: Add `load_google_client` and the commands to `auth.rs`:**

```rust
/// Google client for Drive OAuth: unlike load_auth_config this does NOT
/// require server_url — local-mode workspaces have no central server.
pub fn load_google_client(app: &AppHandle) -> Option<(String, String, String)> {
    let (ws_id, cfg) = crate::active_workspace(app).ok()?;
    let id = cfg.google_client_id.clone().filter(|s| !s.trim().is_empty())?;
    let secret = cfg.google_client_secret.clone().filter(|s| !s.trim().is_empty())?;
    Some((ws_id, id, secret))
}

#[tauri::command]
pub fn google_client_configured(app: AppHandle) -> bool {
    load_google_client(&app).is_some()
}

/// OAuth for Drive sync: PKCE + loopback (same machinery as google_login),
/// scope includes drive. The refresh token goes straight to the sidecar
/// over loopback — it must never transit the webview (security rule 1).
#[tauri::command]
pub async fn google_drive_connect(app: AppHandle) -> Result<Value, String> {
    let (ws_id, client_id, client_secret) = load_google_client(&app)
        .ok_or_else(|| "google_client_id and google_client_secret must be set in config.json".to_string())?;

    let verifier = pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let state_param = random_state();
    let (port, rx) = start_loopback()?;
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth\
        ?response_type=code\
        &client_id={client_id}\
        &redirect_uri={redirect_uri_enc}\
        &scope=openid%20email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive\
        &access_type=offline\
        &prompt=consent\
        &code_challenge={challenge}\
        &code_challenge_method=S256\
        &state={state_param}",
        redirect_uri_enc = percent_encode(&redirect_uri),
    );

    info!("google_drive_connect: opening browser for OAuth");
    open::that(&auth_url).map_err(|e| format!("failed to open browser: {e}"))?;

    let timeout = Duration::from_secs(120);
    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(timeout)
            .unwrap_or_else(|_| Err("login timed out waiting for browser callback (120 s)".to_string()))
    })
    .await
    .map_err(|e| format!("thread join failed: {e}"))?;
    if result.is_err() {
        let _ = TcpStream::connect(format!("127.0.0.1:{port}").as_str());
    }
    let (code, returned_state) = result?;
    if returned_state != state_param {
        return Err("CSRF: state parameter mismatch".to_string());
    }

    let client = Client::new();
    let tokens = exchange_code(&client, &client_id, &client_secret, &redirect_uri, &code, &verifier).await?;
    let refresh = tokens.refresh_token
        .ok_or_else(|| "Google did not return a refresh token — remove the app's prior consent and retry".to_string())?;
    let id_token = tokens.id_token
        .ok_or_else(|| "Google token exchange did not return id_token".to_string())?;
    let email = decode_jwt_payload(&id_token)
        .and_then(|v| v.get("email").and_then(|e| e.as_str()).map(String::from))
        .ok_or_else(|| "id_token has no email claim".to_string())?;

    let (sidecar_port, bearer) = crate::sidecar_port_and_token(&app, &ws_id)?;
    let body = serde_json::json!({
        "refresh_token": refresh,
        "client_id": client_id,
        "client_secret": client_secret,
        "account_email": email,
    });
    let res = client
        .post(format!("http://127.0.0.1:{sidecar_port}/sync/drive/connect"))
        .header("Authorization", format!("Bearer {bearer}"))
        .header("Origin", "tauri://localhost")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("sidecar connect failed: {e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("sidecar connect returned {status}: {text}"));
    }
    serde_json::from_str::<Value>(&text).map_err(|e| format!("sidecar response parse failed: {e}"))
}
```

`decode_jwt_payload` already exists in `auth.rs` (used at `auth.rs:381`). Add `sidecar_port_and_token` to `lib.rs` by extracting the two snapshot blocks from `api_request` (the `let port = { ... }` and `let token = ...` blocks around `lib.rs:1015-1038`) into:

```rust
pub(crate) fn sidecar_port_and_token(app: &AppHandle, ws_id: &str) -> Result<(u16, String), String> {
    let port = {
        let state = app.state::<BackendPorts>();
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.get(ws_id).copied().ok_or_else(|| "backend not ready".to_string())?
    };
    if port == 0 {
        return Err("sync agent not running".to_string());
    }
    let token = app
        .state::<AuthTokens>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(ws_id)
        .cloned()
        .ok_or_else(|| "backend not ready (no token)".to_string())?;
    Ok((port, token))
}
```

and make `api_request` call it (keeping the 501 `local_only` JSON response there: `api_request` maps the `port == 0` case itself before calling, or match on the error string — prefer keeping the `port == 0` check in `api_request` by having it read the port map first exactly as today and only replacing the happy path; choose whichever keeps `api_request`'s behavior byte-identical). Register `google_drive_connect` and `google_client_configured` in the `invoke_handler![...]` list in `lib.rs` next to `google_login`.

- [ ] **Step 2: Compile check**

Run: `cd apps/desktop && cargo check 2>&1 | tail -20`
Expected: no errors (warnings acceptable if pre-existing).

- [ ] **Step 3: Run existing Rust tests**

Run: `cd apps/desktop && cargo test 2>&1 | tail -10`
Expected: PASS (workspace.rs suite).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/auth.rs apps/desktop/src/lib.rs
git commit -m "feat(desktop): google_drive_connect command — OAuth with Drive scope, token straight to sidecar"
```

---

### Task 7: Web — Settings → Synchronizace

**Files:**
- Create: `apps/web/src/lib/sync-drive.ts`
- Create: `apps/web/src/components/SyncSection.tsx`
- Modify: `apps/web/src/components/SettingsPage.tsx` (SubTab union `SettingsPage.tsx:23`, tab buttons block `:140-199`, panel dispatch `:201-207`)

**Interfaces:**
- Consumes: `apiFetch`, `isTauri` from `../lib/backend-url`; Tauri `invoke` for `google_drive_connect` / `google_client_configured`; `listWorkspaces` from `../lib/workspaces` (active workspace `data_mode`); REST shapes from Task 5.
- Produces: `lib/sync-drive.ts` exports:
  - `type DriveStatus = { configured: boolean; connected: boolean; account_email: string | null; target: { kind: "my_drive" | "shared_drive"; name: string } | null }`
  - `fetchDriveStatus(): Promise<DriveStatus>`; `fetchDriveTargets(): Promise<{ id: string; name: string }[]>`; `setDriveTarget(sel: { shared_drive_id: string } | { my_drive: true }): Promise<void>`; `testDrive(): Promise<{ ok: boolean; code?: string }>`; `disconnectDrive(): Promise<void>`; `connectDrive(): Promise<{ account_email: string }>` (invokes the Tauri command); `googleClientConfigured(): Promise<boolean>`; `invalidateSyncStatusCache(): void` and `getCachedDriveStatus(): Promise<DriveStatus | null>` (module-level once-per-session cache — Task 8 reuses it).

- [ ] **Step 1: Implement `lib/sync-drive.ts`** — thin `apiFetch` wrappers throwing on non-2xx, the two Tauri invokes guarded by `isTauri()` (return `false`/throw outside Tauri), and the status cache:

```ts
let statusPromise: Promise<DriveStatus> | null = null;
export function invalidateSyncStatusCache(): void { statusPromise = null; }
export function getCachedDriveStatus(): Promise<DriveStatus | null> {
  if (!statusPromise) statusPromise = fetchDriveStatus().catch((e) => { statusPromise = null; throw e; });
  return statusPromise.catch(() => null);
}
```

- [ ] **Step 2: Implement `SyncSection.tsx`** with the five spec states driven by one `useEffect` load (`googleClientConfigured()` + `fetchDriveStatus()`; workspace `data_mode` via `listWorkspaces()` → active entry). Czech copy exactly:
  - central: `Synchronizaci souborů spravuje server {serverUrl}.`
  - prerequisite: `Propojení s Google Drive vyžaduje google_client_id a google_client_secret v konfiguraci workspace.` + docs link
  - not connected: button `Propojit Google Drive`
  - no target: select `Můj disk (složka Portuni)` + shared drives from `fetchDriveTargets()`, confirm `Uložit cíl`
  - active: `Propojeno jako {email} → {targetName}`, buttons `Otestovat připojení`, `Odpojit` (window.confirm: `Opravdu odpojit Google Drive? Lokální soubory zůstanou.`)
  - test result inline: ok `Připojení funguje.`; TOKEN_INVALID `Propojení vypršelo – přihlas se znovu.` (plus re-render as not-connected); TARGET_NOT_FOUND `Cílová složka nebyla nalezena.`; DRIVE_UNREACHABLE `Google Drive je nedostupný.`
  Every mutation calls `invalidateSyncStatusCache()` then reloads. Follow the visual conventions of `WorkspacesSection.tsx` (same button/list classes).

- [ ] **Step 3: Wire the tab in `SettingsPage.tsx`** — extend the union: `type SubTab = "general" | "actors" | "account" | "workspaces" | "sync" | "users";`, add a button `Synchronizace` after `Workspaces` (copy an existing button block, `onClick={() => setTab("sync")}`), add `{tab === "sync" && <SyncSection />}` to the panel dispatch, and import the component.

- [ ] **Step 4: Typecheck + visual check**

Run: `npm run typecheck && npm --prefix apps/web run build`
Expected: clean. Then with backend (tmux `portuni-mcp`) and `varlock run -- npm --prefix apps/web run dev` running, open `http://portuni.test/?settingsTab=sync` — outside Tauri the section must render the prerequisite/browser fallback state without crashing (the invoke guards).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/sync-drive.ts apps/web/src/components/SyncSection.tsx apps/web/src/components/SettingsPage.tsx
git commit -m "feat(web): Nastavení → Synchronizace — Drive connect UI"
```

---

### Task 8: Node-detail banner when sync is unconfigured

**Files:**
- Modify: `apps/web/src/components/DetailPane.files.tsx` (banner near the existing pending-sync banner; imports at `:29-32`)

**Interfaces:**
- Consumes: `getCachedDriveStatus` from `../lib/sync-drive` (Task 7); `listWorkspaces` for `data_mode`.
- Produces: UI only.

- [ ] **Step 1: Implement.** In `DetailPane.files.tsx` add state + effect:

```tsx
const [syncUnconfigured, setSyncUnconfigured] = useState(false);
useEffect(() => {
  let alive = true;
  (async () => {
    const ws = (await listWorkspaces()).find((w) => w.active);
    if (!ws || ws.data_mode === "central") return;
    const s = await getCachedDriveStatus();
    if (alive && s && !s.configured) setSyncUnconfigured(true);
  })().catch(() => {});
  return () => { alive = false; };
}, []);
```

and render above the file list, styled like the existing pending-sync banner in this file:

```tsx
{syncUnconfigured && (
  <div className="...same classes as the existing banner...">
    Soubory se ukládají jen lokálně – propoj Google Drive v{" "}
    <a href="/?settingsTab=sync">Nastavení → Synchronizace</a>.
  </div>
)}
```

(`listWorkspaces` returns `[]` outside Tauri, so the banner never renders in plain-browser dev — acceptable per spec: the hint targets desktop users.)

- [ ] **Step 2: Typecheck + visual check**

Run: `npm run typecheck`
Expected: clean. In the running app, a local workspace without a configured remote shows the banner in a node's Soubory tab; after completing the connect flow and reopening the pane (cache invalidated by the settings flow), it is gone.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/DetailPane.files.tsx
git commit -m "feat(web): local-only banner in node files pane when Drive is not connected"
```

---

### Task 9: Agent guidance — self-guiding errors + MCP prompt

**Files:**
- Modify: `apps/server/domain/sync/engine.ts:72` and `:281` (the two "No remote routing configured" throws)
- Modify: `apps/server/domain/sync/mirror-create.ts:74-97` (`scaffoldRemoteStructure` null result gains a hint)
- Modify: `apps/server/mcp/server.ts` (register prompt after the tool registrations)
- Test: `test/sync-remote-service.test.ts` (append), `test/mcp-smoke.test.ts` (append prompt listing if the existing smoke harness lists capabilities; otherwise new assertions in `test/mcp-info.test.ts` are NOT needed — verify via the smoke pattern)

**Interfaces:**
- Consumes: nothing new.
- Produces: enriched error strings; MCP prompt named `setup-drive-remote`.

- [ ] **Step 1: Write the failing test** — append to `test/sync-remote-service.test.ts`:

```ts
describe("routing error guidance", () => {
  it("store failure without routing tells the agent and the user what to do", async () => {
    const { ROUTING_GUIDANCE } = await import("../apps/server/domain/sync/engine.js");
    assert.match(ROUTING_GUIDANCE, /Nastavení → Synchronizace/);
    assert.match(ROUTING_GUIDANCE, /portuni_setup_remote/);
    assert.match(ROUTING_GUIDANCE, /portuni_list_remotes/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test test/sync-remote-service.test.ts`
Expected: FAIL — `ROUTING_GUIDANCE` not exported.

- [ ] **Step 3: Implement.** In `engine.ts` add near the top:

```ts
export const ROUTING_GUIDANCE =
  "File sync is not configured. Desktop user: Nastavení → Synchronizace → Propojit Google Drive. " +
  "Agent/admin (service account): call portuni_list_remotes to inspect state, then portuni_setup_remote " +
  "(type gdrive, config {shared_drive_id}, service_account_json) and portuni_set_routing_policy with a " +
  "wildcard rule, or run the setup-drive-remote MCP prompt.";
```

and append `\n${ROUTING_GUIDANCE}` to both `No remote routing configured...` error messages (`engine.ts:72`, `engine.ts:281`). In `mirror-create.ts` import `ROUTING_GUIDANCE` from `./engine.js`, extend the scaffold result type at `mirror-create.ts:66` with `hint?: string`, and in `scaffoldRemoteStructure` change the no-remote early return (`mirror-create.ts:81`) to `return { scaffolded: [], remote_name: null, hint: ROUTING_GUIDANCE };` so `portuni_mirror` responses carry the guidance too. In `apps/server/mcp/server.ts` register the prompt next to `registerSyncRemoteTools`:

```ts
server.prompt(
  "setup-drive-remote",
  "Guide the user through configuring Google Drive file sync (service-account path for servers/admins).",
  () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
          "Help me configure Portuni file sync to Google Drive using a service account. " +
          "Walk me through: (1) Google Cloud Console — create/select a project, enable the Drive API, " +
          "create a service account, download its JSON key; (2) share the target shared drive with the " +
          "service account e-mail as Content manager; (3) call portuni_setup_remote with type gdrive, " +
          "config {shared_drive_id}, and the JSON key as service_account_json; (4) call " +
          "portuni_set_routing_policy with [{priority: 1, node_type: null, org_slug: null, remote_name: <name>}] " +
          "unless a policy already exists (check portuni_list_remotes first); (5) verify with a test " +
          "portuni_store and confirm the file appears on the shared drive. Note: desktop users should " +
          "prefer Nastavení → Synchronizace (user OAuth) — the service account is for headless servers.",
      },
    }],
  }),
);
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test test/sync-remote-service.test.ts test/mcp-smoke.test.ts && npm run build`
Expected: PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add apps/server/domain/sync/engine.ts apps/server/mcp/server.ts test/sync-remote-service.test.ts
git commit -m "feat(mcp): self-guiding routing errors + setup-drive-remote prompt"
```

---

### Task 10: Full-suite gate + manual E2E

**Files:** none new.

- [ ] **Step 1: Full QA**

Run: `npm run qa`
Expected: lint + typecheck + full test suite + build all green.

- [ ] **Step 2: Manual E2E (desktop)** — build and install the app per CLAUDE.md (`cd apps/desktop && cargo tauri build`, copy to /Applications), then on a local workspace with `google_client_id`/`google_client_secret` in config.json:
  1. Nastavení → Synchronizace → Propojit Google Drive → browser consent → returns connected.
  2. Choose target (Můj disk) → Uložit cíl → status Active.
  3. Otestovat připojení → `Připojení funguje.`
  4. Mirror a node, drop a file into `wip/`, run Synchronizovat → file appears in Drive under `Portuni/...`.
  5. Odpojit → status Not connected; node files pane shows the local-only banner again.

- [ ] **Step 3: Commit any fixes discovered, then hand off** per superpowers:finishing-a-development-branch.

## Out of scope (tracked elsewhere)

- Marketplace skill `portuni-remote-setup` — separate deliverable in the tempo-skills repo (`plugins/portuni/skills/`).
- SA UI, central-server admin UI, embedded public OAuth client, multi-remote UI (spec Out of scope).
