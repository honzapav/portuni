# Node Sharing (skupiny + uživatelé) – implementační plán

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sdílení nodes přes ACL (Google skupiny + uživatelé Portuni) s přepisovou dědičností, UI pro správu sdílení a uživatelů, a doménová brána jako seznam.

**Architecture:** Nová tabulka `node_access` nahrazuje `meta.access_group`; resolver v `apps/server/auth/node-access.ts` zůstává jedna rekurzivní CTE (LEFT JOIN na node_access). Identita nese nově `groupIds` (Directory group IDs) vedle e-mailů skupin. REST routy pro ACL, našeptávač skupin a správu uživatelů; UI sekce Sdílení v DetailPane a záložka Uživatelé v Settings.

**Tech Stack:** Node + TypeScript, libSQL (Turso), zod, node:test přes tsx, React + Vite, cytoscape.

**Spec:** `docs/superpowers/specs/2026-07-04-node-sharing-design.md`

## Global Constraints

- Testy: `npx tsx --test test/<file>.test.ts` (node v24 z nvm; v tmux/worktree shellech použij `~/.nvm/versions/node/v24.0.2/bin/npx`). Celá suita: `npm test`.
- Build: `npm run build` (tsc → dist/). Lint: `npx biome check apps/ test/`.
- Žádné emoji v kódu. České UI texty s diakritikou, pomlčka jako spojovník `-` jen ve složeninách.
- min-scopes je fail-closed (default admin) – každá nová routa MUSÍ dostat řádek v `apps/server/auth/min-scopes.ts`, jinak ji smí volat jen admin.
- Enforcement sémantika: ne-člen node NEVIDÍ (not-found ekvivalent), admin vidí vše. `visibility='group'` bez ACL řádků = vidí jen admin (fail-closed).
- Nikde nevolat Directory API v migracích ani při bootu.
- Commit po každém tasku; formát `feat(auth): …` / `feat(web): …` podle zvyku repa.

**Odchylka od spec §2 (schválit implementací, spec už aktualizován v Tasku 3):** group položka ACL se při vyhodnocení matchuje proti `identity.groupIds` **i** `identity.groups` (e-maily). Důvod: migrace starých `meta.access_group` (e-mail) pak nepotřebuje Directory API a e-mailové principaly zůstanou funkční; nové položky z UI se ukládají s group ID.

---

### Task 1: Schéma – tabulka node_access + migrace 019

**Files:**
- Modify: `apps/server/infra/schema-triggers.ts` (DDL array)
- Modify: `apps/server/infra/schema-migrations.ts` (migrace `019_node_access`)
- Test: `test/migration-019-node-access.test.ts`

**Interfaces:**
- Produces: tabulka `node_access(node_id, kind, principal, display_email, added_by, added_at)`, PK `(node_id, kind, principal)`, index `idx_node_access_node`. Migrace přenese `meta.access_group` → řádek `kind='group', principal=<email>, display_email=<email>` a klíč z meta odstraní.

- [ ] **Step 1: Napiš failing test**

Vzor: `test/migration-011-drop-turso-mirrors.test.ts` (in-memory klient, `runMigrations`). Test:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { runMigrations, DDL } from "../apps/server/infra/schema-triggers.js"; // pozn.: ověř skutečný export runMigrations (je v schema-migrations.ts)

describe("migration 019 node_access", () => {
  it("creates node_access on fresh install (DDL)", async () => {
    const db = createClient({ url: ":memory:" });
    for (const stmt of DDL) await db.execute(stmt);
    const t = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='node_access'",
    );
    assert.equal(t.rows.length, 1);
  });

  it("backfills meta.access_group into node_access and strips the key", async () => {
    // Postav DB stavem PŘED migrací (DDL + insert node s meta.access_group),
    // pusť runMigrations, ověř: 1 řádek kind='group' principal=e-mail,
    // display_email=e-mail, meta bez access_group, visibility zůstala 'group'.
    // added_by u backfillu: 'migration'.
  });
});
```

Druhý it() rozepiš plně – node vlož přes přímé INSERT (id 26 znaků, type 'project', sync_key, created_by), `meta = '{"access_group":"partners@tempo.ooo","other":1}'`, `visibility='group'`. Po migraci assertni i to, že `meta.other` přežilo.

- [ ] **Step 2: Ověř, že test padá**

Run: `npx tsx --test test/migration-019-node-access.test.ts`
Expected: FAIL (tabulka neexistuje / migrace není).

- [ ] **Step 3: Implementuj DDL + migraci**

Do `DDL` pole v `schema-triggers.ts` (za users/device_tokens):

```ts
`CREATE TABLE IF NOT EXISTS node_access (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('group','user')),
    principal TEXT NOT NULL,
    display_email TEXT,
    added_by TEXT NOT NULL,
    added_at DATETIME NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (node_id, kind, principal)
  )`,
`CREATE INDEX IF NOT EXISTS idx_node_access_node ON node_access(node_id)`,
```

Migrace v `schema-migrations.ts` podle vzoru 015–018 (id `019_node_access`):

```ts
{
  id: "019_node_access",
  async run(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS node_access ( /* stejné DDL */ )`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_node_access_node ON node_access(node_id)`);
    const rows = await db.execute(
      `SELECT id, meta FROM nodes
        WHERE meta IS NOT NULL AND json_extract(meta, '$.access_group') IS NOT NULL`,
    );
    for (const r of rows.rows) {
      const email = String(
        JSON.parse(String(r.meta)).access_group ?? "",
      ).toLowerCase();
      if (!email) continue;
      await db.execute({
        sql: `INSERT OR IGNORE INTO node_access (node_id, kind, principal, display_email, added_by)
              VALUES (?, 'group', ?, ?, 'migration')`,
        args: [String(r.id), email, email],
      });
      await db.execute({
        sql: `UPDATE nodes SET meta = json_remove(meta, '$.access_group') WHERE id = ?`,
        args: [String(r.id)],
      });
    }
  },
},
```

- [ ] **Step 4: Testy zelené**

Run: `npx tsx --test test/migration-019-node-access.test.ts` → PASS. Pak celé migrace: `npx tsx --test test/migration-011-drop-turso-mirrors.test.ts` (regres).

- [ ] **Step 5: Commit** – `feat(auth): node_access table + migration 019 (backfill meta.access_group)`

---

### Task 2: Identita – groupIds skrz adapter, session JWT a request identity

**Files:**
- Modify: `apps/server/auth/adapter.ts` (AccessResolution)
- Modify: `apps/server/auth/google-adapter.ts` (listGroups vrací id+email)
- Modify: `apps/server/auth/env-adapter.ts` (groupIds: [])
- Modify: `apps/server/auth/session-token.ts` (claims + sign/verify)
- Modify: `apps/server/auth/request-identity.ts` (RequestIdentity.groupIds)
- Test: `test/google-adapter.test.ts`, `test/session-token.test.ts` (existující – rozšířit; pokud neexistují, ekvivalentní auth testy najdi přes `ls test/ | grep -i auth`)

**Interfaces:**
- Produces: `AccessResolution = { globalScope, groups: string[], groupIds: string[] }`; `RequestIdentity.groupIds: string[]`; `SessionClaims.groupIds: string[]`. `listGroups(email)` interně vrací `Array<{ id: string; email: string }>`.
- Consumes: nic z Tasku 1.

- [ ] **Step 1: Rozšiř testy** – v adapter/session testech přidej asserty na `groupIds` (Directory mock ať vrací `groups: [{ id: "01abc", email: "team@tempo.ooo" }]`; session token roundtrip ať zachová `groupIds`). Ověř FAIL.

- [ ] **Step 2: Implementace**

`adapter.ts`:
```ts
export interface AccessResolution {
  globalScope: GlobalScope;
  groups: string[];   // e-maily (role mapping, zpětná kompatibilita ACL)
  groupIds: string[]; // Directory group IDs (ACL matching)
}
```

`google-adapter.ts` – `listGroups` sbírá `{ id, email }`:
```ts
const groups: Array<{ id: string; email: string }> = [];
// ... v pageLoop:
for (const g of res.data.groups ?? []) groups.push({ id: g.id, email: g.email });
```
(rozšiř i request type o `id: string`). `resolveAccess` pak:
```ts
const list = await this.deps.listGroups(email);
const emails = list.map((g) => g.email.toLowerCase());
return {
  globalScope: roleFromGroups(emails, this.deps.roleConfig),
  groups: emails,
  groupIds: list.map((g) => g.id),
};
```
(přesná jména interních funkcí ověř v souboru; zachovej stávající logiku rolí beze změny).

`env-adapter.ts`: doplň `groupIds: []` do návratu resolveAccess.

`session-token.ts`: `SessionClaims` + payload + verify doplnit `groupIds: string[]` (verify: `Array.isArray(payload.groupIds) ? payload.groupIds.filter((g): g is string => typeof g === "string") : []` – starý token bez claimu → prázdné pole, uživatel se do hodiny přihlásí znovu).

`request-identity.ts`: `RequestIdentity.groupIds: string[]`; env větev `groupIds: []` → ne, správně `access.groupIds` (env adapter vrací []); device-token větev `access.groupIds`; JWT větev z claims.

Zkontroluj místa, kde se session token PODEPISUJE (login handler v `apps/server/api/auth.ts` – hledej `signSessionToken`) a předej `groupIds` z resolveAccess.

- [ ] **Step 3: Build + testy** – `npm run build` a `npm test` (typové chyby z nových povinných polí oprav doplněním polí, ne zeslabením typů).

- [ ] **Step 4: Commit** – `feat(auth): carry Directory group IDs through identity (adapter, JWT, request)`

---

### Task 3: Resolver – effectiveAccessEntries nad node_access

**Files:**
- Modify: `apps/server/auth/node-access.ts` (přepis)
- Modify: `docs/superpowers/specs/2026-07-04-node-sharing-design.md` (§2 – doplnit větu o matchi na e-mail i ID)
- Test: `test/node-access.test.ts` (existující testy přepsat na tabulku)

**Interfaces:**
- Consumes: tabulka `node_access` (Task 1), `GroupIdentityView` s `userId`, `groups`, `groupIds` (Task 2 – RequestIdentity strukturálně sedí).
- Produces:
```ts
export interface AccessEntry { kind: "group" | "user"; principal: string; }
export interface GroupIdentityView {
  globalScope: GlobalScope;
  groups: string[];
  groupIds: string[];
  userId: string;
}
// null = bez omezení; [] = omezeno bez použitelných položek (fail-closed, jen admin)
export async function effectiveAccessEntries(db: Client, nodeId: string): Promise<AccessEntry[] | null>;
// zdroj dědění pro GET /nodes/:id/access
export async function resolveAccessChain(db: Client, nodeId: string):
  Promise<{ sourceNodeId: string | null; entries: AccessEntry[] | null }>;
export function canSeeNode(identity: GroupIdentityView, entries: AccessEntry[] | null): boolean;
export async function nodeVisibleTo(db, identity, nodeId): Promise<boolean>;   // beze změny signatury
export async function filterVisibleNodeIds(db, identity, nodeIds): Promise<Set<string>>; // beze změny signatury
```
`effectiveAccessGroup` SMAZAT (jediný konzument je node-access sám + testy).

- [ ] **Step 1: Přepiš testy** (`test/node-access.test.ts`): scénáře –
  1. node bez ACL v celém řetězu → vidí každý (`canSeeNode` s ne-admin identitou = true);
  2. org s group řádkem (principal = group ID) → člen podle `groupIds` vidí, ne-člen ne, admin vidí;
  3. e-mailový principal (pozůstatek migrace) → match přes `identity.groups`;
  4. user řádek (principal = users.id) → dotyčný vidí, jiný user ne;
  5. override: org má skupinu A, child má vlastní řádek skupiny B → člen A (ne B) child NEVIDÍ, člen B (ne A) child VIDÍ;
  6. `visibility='group'` bez řádků → entries `[]`, vidí jen admin;
  7. neexistující node → `effectiveAccessEntries` vrací null a `nodeVisibleTo` true (starý kontrakt – guardy existenci řeší zvlášť);
  8. cycle guard: A belongs_to B belongs_to A → skončí, nevrátí nekonečno.
  Ověř FAIL.

- [ ] **Step 2: Implementace** – jádro SQL (jeden round-trip zůstává):

```ts
const r = await db.execute({
  sql: `WITH RECURSIVE chain(id, depth) AS (
          SELECT ?, 0
          UNION ALL
          SELECT (SELECT e.target_id FROM edges e
                  WHERE e.source_id = c.id AND e.relation = 'belongs_to' LIMIT 1),
                 c.depth + 1
          FROM chain c
          WHERE c.depth < ${MAX_CHAIN}
            AND (SELECT e.target_id FROM edges e
                 WHERE e.source_id = c.id AND e.relation = 'belongs_to' LIMIT 1) IS NOT NULL
        )
        SELECT c.id AS node_id, c.depth, n.visibility, na.kind, na.principal
        FROM chain c
        JOIN nodes n ON n.id = c.id
        LEFT JOIN node_access na ON na.node_id = c.id
        ORDER BY c.depth`,
  args: [nodeId],
});
```

JS vyhodnocení v `resolveAccessChain`: řádky seskup podle depth vzestupně; pro první depth, kde existuje řádek s `kind IS NOT NULL` → `{ sourceNodeId: node_id, entries: [...] }`; jinak pokud na té depth `visibility === 'group'` (a žádné položky) → `{ sourceNodeId: node_id, entries: [] }` (fail-closed); jinak pokračuj; konec → `{ sourceNodeId: null, entries: null }`. Chybějící node (0 řádků nebo depth[0] !== 0) → `{ sourceNodeId: null, entries: null }`.

```ts
export function canSeeNode(identity: GroupIdentityView, entries: AccessEntry[] | null): boolean {
  if (entries === null) return true;
  if (identity.globalScope === "admin") return true;
  return entries.some((e) =>
    e.kind === "user"
      ? e.principal === identity.userId
      : identity.groupIds.includes(e.principal) ||
        identity.groups.some((g) => g.toLowerCase() === e.principal.toLowerCase()),
  );
}
```

`filterVisibleNodeIds`: stejná memoizace, jen memo typu `Map<string, AccessEntry[] | null>`.

Do spec §2 přidej větu: „Group položka se matchuje proti group ID i e-mailům identity – e-mailové principaly z migrace zůstávají funkční; nové položky z UI ukládají ID."

- [ ] **Step 3: Testy + celá suita** – `npx tsx --test test/node-access.test.ts` PASS, pak `npm test` (≈723 testů; spadne-li něco na GroupIdentityView tvaru v test fixtures, doplň `groupIds: []`/`userId` do fixtures).

- [ ] **Step 4: Commit** – `feat(auth): ACL resolver over node_access (groups by ID, users, override inheritance)`

---

### Task 4: REST – GET/PUT /nodes/:id/access

**Files:**
- Create: `apps/server/api/access.ts`
- Modify: `apps/server/api/router.ts` (routing), `apps/server/auth/min-scopes.ts`
- Test: `test/api-access.test.ts` (vzor: jiné testy v `test/` co startují `startHttpServer` s celým routerem – viz `test/agent-router.test.ts` pro server harness; pro plný router najdi existující api test, např. `ls test/ | grep api`)

**Interfaces:**
- Consumes: `resolveAccessChain`, `canSeeNode`, `nodeVisibleTo` (Task 3); `logAudit(userId, action, targetType, targetId, detail)` z `apps/server/infra/audit.ts`.
- Produces:
  - `GET /nodes/:id/access` → `{ restricted: boolean, inherited: boolean, source_node_id: string | null, source_node_name: string | null, entries: Array<{ kind: "group" | "user", principal: string, display_email: string | null, display_name: string | null, avatar_url: string | null }> }`
  - `PUT /nodes/:id/access` body `{ entries: Array<{ kind: "group", principal: string, display_email: string } | { kind: "user", principal: string }> }` → 200 se stejným tvarem jako GET. Prázdné `entries` = zrušení omezení.

- [ ] **Step 1: Failing testy** – scénáře:
  1. PUT s group+user položkou (manage identita) → 200; nodes.visibility = 'group'; audit řádek `node.access.set`;
  2. GET vrací vlastní seznam (`inherited: false`, display_name z users JOIN);
  3. GET na childu bez vlastního ACL vrací zděděné (`inherited: true`, `source_node_id` = org);
  4. PUT `entries: []` → visibility zpět 'team', GET `restricted: false`;
  5. PUT s user principalem, který v users neexistuje → 400;
  6. ne-člen (read identita mimo skupinu) → GET 404 (visibility guard), PUT 403 (min-scope manage);
  7. PUT na node, který volající nevidí → 404.

- [ ] **Step 2: Implementace `api/access.ts`**

```ts
const AccessEntryBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), principal: z.string().min(1), display_email: z.string().email() }),
  z.object({ kind: z.literal("user"), principal: z.string().min(1) }),
]);
const PutAccessBody = z.object({ entries: z.array(AccessEntryBody).max(100) });
```

GET handler: `nodeVisibleTo` guard (404 při false) → `resolveAccessChain` → pokud entries null: `{ restricted: false, inherited: false, source_node_id: null, source_node_name: null, entries: [] }`; jinak dotáhni display data jedním dotazem:
```sql
SELECT na.kind, na.principal, na.display_email, u.name AS user_name, u.email AS user_email, u.avatar_url
FROM node_access na LEFT JOIN users u ON na.kind = 'user' AND u.id = na.principal
WHERE na.node_id = ?
```
(`source_node_name` z `SELECT name FROM nodes WHERE id = ?`; `inherited = sourceNodeId !== nodeId`).

PUT handler: guard `nodeVisibleTo` (404) → validace body → pro user položky ověř existenci (`SELECT id FROM users WHERE id IN (...)`, chybějící → 400 s výčtem) → `db.batch` [`DELETE FROM node_access WHERE node_id = ?`, inserty, `UPDATE nodes SET visibility = ?, updated_at = datetime('now') WHERE id = ?` s `'group'`/`'team'` podle `entries.length`] → `logAudit(identity.userId, "node.access.set", "node", nodeId, { entries: body.entries })` → odpověz tvarem GET. Pozor: visibility přepínej na 'team' JEN pokud byla 'group' (neshoď 'private').

Router (`router.ts`) – za stávající nodes routy:
```ts
const accessMatch = url.pathname.match(/^\/nodes\/([^/]+)\/access$/);
if (accessMatch && req.method === "GET") { await handleGetNodeAccess(req, res, identity, accessMatch[1]); return true; }
if (accessMatch && req.method === "PUT") { await handlePutNodeAccess(req, res, identity, accessMatch[1]); return true; }
```

min-scopes:
```ts
if (/^\/nodes\/[^/]+\/access$/.test(pathname) && m === "GET") return "read";
if (/^\/nodes\/[^/]+\/access$/.test(pathname) && m === "PUT") return "manage";
```

- [ ] **Step 3: Testy PASS + commit** – `feat(api): node access endpoints (GET/PUT /nodes/:id/access)`

---

### Task 5: Našeptávač skupin – GET /auth/groups

**Files:**
- Modify: `apps/server/auth/adapter.ts` (volitelná metoda), `apps/server/auth/google-adapter.ts`
- Create: handler v `apps/server/api/access.ts` (přidej `handleListGroups`)
- Modify: `apps/server/api/router.ts`, `apps/server/auth/min-scopes.ts`
- Test: rozšíření `test/api-access.test.ts` + unit v adapter testu

**Interfaces:**
- Produces: `IdentityAdapter.listDomainGroups?: (query: string) => Promise<Array<{ id: string; email: string; name: string }>>`; `GET /auth/groups?query=par` → `{ groups: [{ id, email, name }] }` (max 20, filtr case-insensitive na email+name). Env adapter metodu nemá → handler vrací `501 { error: "google_mode_only" }`.

- [ ] **Step 1: Failing test** – handler test s fake adapterem (metoda vrací 3 skupiny, query filtruje na 1); env adapter (bez metody) → 501; min-scope: read identita → 403.

- [ ] **Step 2: Implementace**

google-adapter – nová metoda na GoogleAdapter (deps rozšíř o `listAllGroups: () => Promise<Array<{id,email,name}>>`), v `createGoogleAdapterFromEnv`:
```ts
listAllGroups: async () => {
  const groups: Array<{ id: string; email: string; name: string }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://admin.googleapis.com/admin/directory/v1/groups");
    url.searchParams.set("customer", "my_customer");
    url.searchParams.set("maxResults", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await directoryClient.request<{
      groups?: Array<{ id: string; email: string; name?: string }>;
      nextPageToken?: string;
    }>({ url: url.toString() });
    for (const g of res.data.groups ?? [])
      groups.push({ id: g.id, email: g.email, name: g.name ?? g.email });
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return groups;
},
```
Na GoogleAdapter implementuj `listDomainGroups(query)` s modulovou cache (`{ fetchedAt: number; groups: [...] }`, TTL 5 min = 300_000 ms, `Date.now()`), filtr `email.includes(q) || name.toLowerCase().includes(q)`, slice(0, 20).

Handler + routa `GET /auth/groups` (min-scope **manage** – nabízí se jen editorům sdílení), query param `query` (default "").

- [ ] **Step 3: Testy PASS + commit** – `feat(auth): domain groups picker endpoint with 5min cache`

---

### Task 6: Uživatelé – seznam, admin seznam, pozvání

**Files:**
- Modify: `apps/server/auth/users.ts` (`listUsers`, `listUsersAdmin`, `inviteUser`)
- Create: handlery v `apps/server/api/auth.ts` (`handleListAccountUsers`, `handleListUsersAdmin`, `handleInviteUser`)
- Modify: `apps/server/api/router.ts`, `apps/server/auth/min-scopes.ts`
- Test: `test/api-users-admin.test.ts`

**Interfaces:**
- Produces:
  - `GET /auth/users` (manage) → `{ users: [{ id, name, email, avatar_url }] }` – zdroj pro ACL picker.
  - `GET /auth/users/admin` (admin) → `{ users: [{ id, name, email, avatar_url, last_login_at, invited: boolean, global_scope: GlobalScope }] }` (`invited` = `google_sub IS NULL`; `global_scope` přes `adapter.resolveAccess(email)` v `Promise.all`).
  - `POST /auth/users/invite` (admin) body `{ email }` → 201 `{ id, email, name }`; name = část e-mailu před `@`; duplicitní e-mail → 409.
- Consumes: `upsertUserFromIdentity` v users.ts už umí spárovat pozvaný řádek podle e-mailu při prvním loginu (větev byEmail doplní google_sub) – NEMĚNIT, jen ověřit testem.

- [ ] **Step 1: Failing testy** – invite → 201 + řádek s `google_sub IS NULL`; duplicitní invite → 409; login identity se stejným e-mailem (zavolej `upsertUserFromIdentity` přímo) → doplní sub, id se nemění; `GET /auth/users/admin` s manage identitou → 403; s admin → obsahuje invited=true u pozvaného.

- [ ] **Step 2: Implementace** – users.ts:
```ts
export async function inviteUser(db: Client, email: string): Promise<{ id: string; email: string; name: string }> {
  const normalized = email.trim().toLowerCase();
  const existing = await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [normalized] });
  if (existing.rows.length > 0) throw new UserExistsError(normalized); // vlastní Error class, handler mapuje na 409
  const id = ulid();
  const name = normalized.split("@")[0];
  await db.execute({
    sql: "INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, datetime('now'))",
    args: [id, normalized, name],
  });
  return { id, email: normalized, name };
}
```
`listUsers`/`listUsersAdmin` jsou přímočaré SELECTy (admin varianta + resolveAccess). Handler invite: zod `{ email: z.string().email() }`, audit `logAudit(identity.userId, "user.invite", "user", id, { email })`.

min-scopes:
```ts
if (pathname === "/auth/groups" && m === "GET") return "manage";   // z Tasku 5
if (pathname === "/auth/users" && m === "GET") return "manage";
if (pathname === "/auth/users/admin" && m === "GET") return "admin";
if (pathname === "/auth/users/invite" && m === "POST") return "admin";
```
POZOR na pořadí v routeru: `/auth/users/admin` a `/auth/users/invite` matchuj PŘED `/auth/users`.

- [ ] **Step 3: Testy PASS + commit** – `feat(auth): user listing and invites for ACL picker`

---

### Task 7: Web – sekce Sdílení v DetailPane + lock v grafu

**Files:**
- Create: `apps/web/src/components/DetailPane.access.tsx`
- Modify: `apps/web/src/components/DetailPane.tsx` (vlož sekci), `apps/web/src/api.ts`, `apps/web/src/types.ts`
- Modify: `apps/web/src/components/GraphView.tsx` (styl omezeného nodu) + ověř, že graph payload nese `visibility` (pokud ne, doplň do SELECT v `apps/server/domain/queries/` grafu a do `apps/server/api/graph.ts` mapování)

**Interfaces:**
- Consumes: endpoints z Tasků 4–6; `GET /me` vrací `{ global_scope }` (existuje).
- Produces (api.ts):
```ts
export async function fetchNodeAccess(id: string): Promise<NodeAccessResponse>;
export function putNodeAccess(id: string, entries: NodeAccessEntryInput[]): Promise<NodeAccessResponse>;
export async function searchGroups(query: string): Promise<DirectoryGroup[]>;
export async function fetchAccountUsers(): Promise<AccountUser[]>;
export async function fetchMe(): Promise<{ global_scope: string }>;
```
(typy `NodeAccessResponse`, `NodeAccessEntryInput`, `DirectoryGroup`, `AccountUser` do types.ts přesně podle tvarů z Tasků 4–6; follow stávající fetch wrapper vzor z okolních funkcí v api.ts).

- [ ] **Step 1: Implementuj `DetailPane.access.tsx`** (vzor struktury: `DetailPane.files.tsx`):
  - Stavové zobrazení: `restricted=false` → řádek „Vidí všichni přihlášení"; `inherited=true` → „Dědí z ‹source_node_name›" + chips read-only; vlastní seznam → chips s křížkem (jen canManage).
  - Chip: skupina = `display_email`; uživatel = `display_name ?? display_email`.
  - Editace (canManage = global_scope 'manage' | 'admin', z `fetchMe()` cachnutého v useState v DetailPane a předaného props): input s našeptávačem – debounce 300 ms, výsledky ze `searchGroups(q)` + lokální filtr `fetchAccountUsers()`; enter/klik přidá položku do draftu; „Uložit" → `putNodeAccess`; „Zrušit omezení" → `putNodeAccess(id, [])`.
  - Chybové stavy: 501 z `/auth/groups` (env mode) → našeptávač jen uživatelé; síťová chyba → inline hláška „Nepodařilo se načíst sdílení".
  - Texty česky s diakritikou: „Sdílení", „Vidí všichni přihlášení", „Dědí z", „Přidat skupinu nebo uživatele…", „Zrušit omezení", „Uložit".
  - Po uložení refreshni node detail (DetailPane už má reload callback pro files – použij stejný vzor), aby se propsala visibility.
- [ ] **Step 2: DetailPane.tsx** – sekci vlož mezi metadata a soubory; u headeru nodu zobraz štítek „Omezené" pokud `node.visibility === 'group'` (NodeDetail typ – ověř, že visibility v payloadu je; pokud ne, doplň v `apps/server/domain/queries/node-detail.ts` a types.ts).
- [ ] **Step 3: GraphView** – cytoscape style selector `node[visibility = "group"]` s `border-style: "dashed"` (+ zachovej stávající border barvy); pokud graph payload visibility nenese, doplň (server: graph query SELECT + mapování; web: GraphPayload typ + element data).
- [ ] **Step 4: Ruční ověření** – `varlock run -- npm --prefix apps/web run dev`, otevři `http://portuni.test`, na testovacím nodu nastav skupinu (env mode: 501 větev – ověř aspoň user picker a PUT přes REST curl v env módu), zkontroluj chips, dědění na childu, dashed border v grafu. (Plné google-mode ověření je v Tasku 9.)
- [ ] **Step 5: Lint + commit** – `npx biome check apps/web` → `feat(web): sharing section in detail pane + restricted node styling`

---

### Task 8: Web – Nastavení → Uživatelé

**Files:**
- Create: `apps/web/src/components/SettingsPage.users.tsx`
- Modify: `apps/web/src/components/SettingsPage.tsx` (SubTab `"users"`), `apps/web/src/api.ts` (`fetchUsersAdmin`, `inviteUser`)

**Interfaces:**
- Consumes: `GET /auth/users/admin`, `POST /auth/users/invite` (Task 6), `fetchMe` (Task 7).

- [ ] **Step 1: Implementace** – vzor `SettingsPage.actors.tsx`. Tabulka: avatar+jméno, e-mail, role (global_scope), poslední přihlášení (`last_login_at` lokalizovaně, `—` pokud null), badge „Pozvaný" při `invited`. Nad tabulkou input + tlačítko „Pozvat" (email validace, 409 → „Uživatel už existuje"). Záložka viditelná jen adminovi (`fetchMe().global_scope === "admin"`); SubTab typ rozšířit o `"users"` a přidat tlačítko do tab listu.
- [ ] **Step 2: Ruční ověření + lint + commit** – v env módu je solo admin → tab viditelný; invite → řádek s badge. `feat(web): users admin tab with invites`

---

### Task 9: PORTUNI_ALLOWED_DOMAINS + docs

**Files:**
- Modify: `apps/server/auth/google-adapter.ts` (allowedDomain → allowedDomains)
- Modify: `docs/env-vars.md`, `docs/superpowers/specs/2026-06-09-google-groups-auth-design.md` (poznámka o nahrazení §3 node-level části novým spec)
- Test: rozšíření google-adapter testu

**Interfaces:**
- Produces: env `PORTUNI_ALLOWED_DOMAINS` (čárkou oddělený seznam, trim + lowercase). `PORTUNI_ALLOWED_DOMAIN` (singulár) zůstává funkční jako fallback, když plurál není nastaven.

- [ ] **Step 1: Failing test** – adapter s `allowedDomains: ["workflow.ooo", "tempo.ooo"]`: e-mail z tempo.ooo projde, z gmail.com spadne; env parsing: `PORTUNI_ALLOWED_DOMAINS="workflow.ooo, tempo.ooo"` → oba; jen singulár nastaven → jednoprvkový seznam.
- [ ] **Step 2: Implementace** – deps `allowedDomains: string[]`; verify: `if (!this.deps.allowedDomains.includes(domain)) throw ...`; factory:
```ts
const domainsRaw = env.PORTUNI_ALLOWED_DOMAINS ?? env.PORTUNI_ALLOWED_DOMAIN ?? "";
const allowedDomains = domainsRaw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
if (allowedDomains.length === 0) throw new Error("PORTUNI_ALLOWED_DOMAINS is required in google auth mode");
```
- [ ] **Step 3: docs** – env-vars.md: řádek PORTUNI_ALLOWED_DOMAIN nahraď PORTUNI_ALLOWED_DOMAINS (+ zmínka o singulárním fallbacku); přidej poznámku, že node-level přístup řídí node_access (odkaz na nový spec).
- [ ] **Step 4: Testy + commit** – `feat(auth): allowed domains list (tempo.ooo + workflow.ooo)`

---

### Task 10: Integrační scénář „business partners" + celková QA

**Files:**
- Create: `test/node-sharing-scenario.test.ts`

**Interfaces:** Consumes vše výše.

- [ ] **Step 1: Scénářový test** – in-memory DB + plný router (HTTP), tři identity (admin; člen org skupiny s manage; člen partners skupiny s read – identity fake přes session token nebo přímo handler vrstvou podle toho, jak to dělají stávající api testy):
  1. admin založí org + child „Business partners" + child „Projekt A";
  2. PUT access na org: `[{kind:'group', principal:'GID_ORG', display_email:'org@tempo.ooo'}]`; na Business partners: `[{kind:'group', principal:'GID_PART', ...}]`;
  3. org člen: GET /graph obsahuje org + Projekt A, ne Business partners; GET /nodes/:partners → 404;
  4. partners člen: vidí Business partners, nevidí Projekt A ani org detail;
  5. admin vidí vše;
  6. PUT `entries: []` na partners → org člen ho zase vidí (dědění).
- [ ] **Step 2: Celá QA** – `npm run build` + `npm test` + `npx biome check apps/ test/` – vše zelené.
- [ ] **Step 3: Commit** – `test(auth): business-partners sharing scenario`

---

## Po implementaci (mimo plán, vyžaduje souhlas uživatele)

- Deploy na VPS (deploy skript `scripts/deploy-vps.sh`) + nastavit `PORTUNI_ALLOWED_DOMAINS=workflow.ooo,tempo.ooo` v `/opt/portuni/portuni.env`.
- Ruční E2E: druhý účet na tempo.ooo jako ne-člen; založit testovací Google skupinu, přiřadit v UI, ověřit zmizení/objevení nodes.
- Nový build `Portuni.app` (perf pravidlo: jen na release checkpoint).
