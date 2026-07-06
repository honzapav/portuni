# Node Sharing wave 2 – access_mode (private/request) + follow-upy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Asanovský režim omezení (Soukromé = skryté úplně, Na vyžádání = název viditelný jako zamčený chip v Propojení a MCP edges) + splacení všech neblokujících follow-upů z wave 1.

**Architecture:** Nový sloupec `nodes.access_mode`; `resolveAccessChain` vrací i mode autoritativního nodu; edge filtr v node-detail a MCP context místo zahazování klasifikuje (visible / request → `peer_restricted` / hidden). UI: přepínač režimu v Sdílení, zamčené chips v Propojení. Follow-upy: hardening PUT access, migrace, testy, web polish, gating konzistence.

**Tech Stack:** beze změny (Node + TS + libSQL, React/Vite, node:test/tsx).

**Spec:** `docs/superpowers/specs/2026-07-04-node-sharing-design.md` (sekce „Režim omezení" a „Zamčené položky v Propojení").

## Global Constraints

- Testy `npx tsx --test test/<file>.test.ts` (nvm node v24: `~/.nvm/versions/node/v24.0.2/bin/npx`), plná suita `npm test`; `npm run build`; web `npm --prefix apps/web run build`; `npx biome check apps/ test/`.
- Žádné emoji v kódu; české UI texty i komentáře s diakritikou.
- min-scopes fail-closed; enforcement sémantika: `private` restricted = nevidí nic; `request` restricted = jen název/typ přes hrany z viditelných sousedů (detail + MCP edges), NIC jiného (graf/list/search/GET dál skryté).
- Default režim při omezení = `private` (dnešní chování se nesmí změnit bez explicitního přepnutí).
- TDD; commit po tasku.

---

### Task 11: Schéma access_mode + resolver mode

**Files:**
- Modify: `apps/server/infra/schema-triggers.ts` (DDL nodes: sloupec `access_mode TEXT NOT NULL DEFAULT 'private' CHECK(access_mode IN ('private','request'))`), `apps/server/infra/schema-migrations.ts` (migrace `020_nodes_access_mode`: `ALTER TABLE nodes ADD COLUMN ...` — ověř, že SQLite ADD COLUMN s CHECK+DEFAULT projde na existující tabulce; pattern migrace 018)
- Modify: `apps/server/auth/node-access.ts`
- Test: `test/auth-node-access.test.ts`, `test/migration-019-node-access.test.ts` (nebo nový migration-020 test)

**Interfaces (Produces):**
```ts
export type AccessMode = "private" | "request";
// resolveAccessChain nově vrací mode autoritativního nodu (null když neomezeno)
export async function resolveAccessChain(db, nodeId): Promise<{ sourceNodeId: string | null; entries: AccessEntry[] | null; mode: AccessMode | null }>;
// Klasifikace pro edge filtry: pro každé id 'visible' | 'request' | 'hidden'
export async function classifyNodeVisibility(db: Client, identity: GroupIdentityView, nodeIds: string[]): Promise<Map<string, "visible" | "request" | "hidden">>;
```
- `classifyNodeVisibility`: memoizace per call jako `filterVisibleNodeIds`; admin → vše visible; visible = canSeeNode true; jinak request/hidden podle mode autoritativního nodu (fail-closed entries `[]` → mode se čte z téhož nodu, default private). `filterVisibleNodeIds` beze změny chování (visible only).
- CTE dotaz rozšířit o `n.access_mode` (SELECT sloupec navíc, žádný druhý round-trip).
- Testy: mode default private; request na org dědí na child; child s vlastním ACL má vlastní mode; classifyNodeVisibility všechny tři třídy + admin.

Kroky: failing testy → migrace+DDL → resolver → focused + `npm test` → commit `feat(auth): access_mode private/request on restricted nodes`.

---

### Task 12: REST + MCP – peer_restricted hrany + mode v access API

**Files:**
- Modify: `apps/server/domain/queries/node-detail.ts` (edge filtr: místo drop → classifyNodeVisibility; hidden drop, request ponechat s `peer_restricted: true`; visible bez příznaku), `apps/server/mcp/tools/context.ts` (stejná klasifikace v prune větvi), `apps/server/api/access.ts` (GET/PUT `mode`), `apps/server/shared/api-types.ts` (NodeDetail edge typ + NodeAccessResponse.mode)
- Test: `test/node-sharing-scenario.test.ts` (rozšířit), `test/api-access.test.ts`

**Interfaces (Produces):**
- Edge objekt v node detailu a MCP get_node/context: volitelné `peer_restricted?: true`.
- `GET /nodes/:id/access` → navíc `mode: "private" | "request"` (u neomezeného `null`); `PUT` body navíc volitelné `mode` (default `"private"` při nastavování entries; ignorováno/`null` při prázdných entries). PUT zapisuje `nodes.access_mode` v témže batchi. Audit detail obsahuje mode.
- Sémantika: request-restricted node se v detailu souseda ukáže; ve VŠEM ostatním (graph, list, search, GET /nodes/:id, files, sync-info) zůstává skrytý — testy to musí přibít (GET na request node ne-členem = 404).

Kroky: failing testy (scénář: org visible, child restricted request → org member vidí chip edge s peer_restricted a jménem; child private → edge zmizí; GET child 404 v obou režimech; PUT mode roundtrip) → implementace → suita → commit `feat(api): request mode surfaces locked edges in detail and MCP`.

---

### Task 13: Web – přepínač režimu + zamčené chips + copy-to-draft

**Files:**
- Modify: `apps/web/src/components/DetailPane.access.tsx` (přepínač „Soukromé"/„Na vyžádání" u vlastního ACL, posílá mode v PUT; tlačítko „Upravit kopii" u zděděného ACL — zkopíruje zděděné entries+mode do draftu jako vlastní override), `apps/web/src/components/DetailPane.tsx` (Propojení: edge s `peer_restricted` → zamčený chip: název + zámek-SVG/CSS bez emoji, nekliknutelné, title „Přístup na vyžádání"), `apps/web/src/api.ts` + `apps/web/src/types.ts` (mode + peer_restricted typy)
- Verifikační laťka: web build + biome (žádný render harness).

UI texty (diakritika): „Soukromé", „Na vyžádání", „Přístup na vyžádání", „Upravit kopii". Zámek NENÍ emoji — inline SVG (jednoduchý padlock path) nebo existující ikonový vzor v kódu, pokud nějaký je.

Kroky: implementace → web build + biome → commit `feat(web): access mode toggle, locked connection chips, inherited copy-to-draft`.

---

### Task 14: Server follow-upy (hardening + testy)

**Files:** `apps/server/api/access.ts`, `apps/server/api/nodes.ts`, `apps/server/mcp/tools/nodes.ts`, `apps/server/domain/nodes.ts`, `apps/server/infra/schema-migrations.ts`, `apps/server/domain/sync/pending.ts` (najdi přesné místo výpočtu /sync/pending na centrálu), `apps/server/api/graph.ts` (+ domain query), `apps/server/api/users.ts`, testy dle bodů.

Body (každý s testem, kde dává smysl):
1. **PUT /nodes/:id/access dedup**: duplicitní `(kind, principal)` v payloadu → 400 (zod refine nebo ruční Set check), test.
2. **Test private-preservation**: PUT entries na node s visibility='private' → zůstává 'private'?? — POZOR: rozhodnutí: entries non-empty nastavuje 'group' vždy (dnešní chování). Test přibije přechod 'private'+entries→'group' a 'private'+empty→zůstane 'private'. (Chování nechat, jen přibít testem.)
3. **Redundantní existence query** v access.ts odstranit (nodeVisibleTo + následný SELECT name stačí).
4. **api-access.test.ts order-coupling**: rozvázat testy 1/3/4/5 (vlastní nody per test nebo explicitní reset ACL v setupu).
5. **Migrace 019**: `json_valid(meta)` do WHERE + mixed-case backfill test (Partners@Tempo.ooo → lowercased) + test „node s meta bez access_group se nedotkne".
6. **Zákaz ručního visibility='group'**: `PATCH /nodes/:id` i MCP `portuni_update_node` odmítnou `visibility: 'group'` s 400/tool error „visibility 'group' is managed via the sharing ACL" (centrálně v `apps/server/domain/nodes.ts` update validaci, ať to platí pro obě cesty). Test REST i MCP.
7. **/sync/pending po revokaci**: centrální výpočet pending filtrovat přes filterVisibleNodeIds (identity je k dispozici v handleru) — revokovaný node se nesmí jmenovat v odpovědi. Test.
8. **Graph restricted flag**: graph payload doplnit `restricted: true` u viditelných nodes, jejichž efektivní ACL ≠ null (využij memoizaci/`classifyNodeVisibility`); zachovat dnešní pole. (Web část v Tasku 15.)
9. **GET /users vs /auth/users**: prozkoumej použití `GET /users` ve webu (`grep -rn "fetchUsers\|\"/users\"" apps/web/src`); pokud ho používají jen manage-gated flows (owner picker apod. dostupné manage rolím), zvedni min-scope na manage; pokud ho potřebují read uživatelé, nech read a přidej komentář do min-scopes.ts s odůvodněním (workspace-interní adresář). Rozhodnutí zapiš do reportu.
10. **Picker testy**: TTL boundary (přesně == TTL → refetch) a dva souběžné dotazy s růzností query sdílejí jeden fetch, každý svůj filtr.

Kroky: TDD po bodech, průběžně focused testy, na konci `npm test` + build + biome → commit `fix(auth): wave-1 follow-ups — dedup, visibility guard, pending filter, migration hardening` (klidně 2–3 commity po logických celcích).

---

### Task 15: Web + docs follow-upy

**Files:** `apps/web/src/components/SettingsPage.users.tsx`, `apps/web/src/components/SettingsPage.tsx`, `apps/web/src/components/GraphView.tsx`, `apps/web/src/api.ts`, `docs/env-vars.md`, `docs/superpowers/specs/2026-07-04-node-sharing-design.md`, `docs/architecture/` (nebo AGENTS.md gotcha)

Body:
1. **Invite validace**: klientská kontrola formátu e-mailu před POST (jednoduchý regex), chybová hláška česky „Zadej platný e-mail." místo raw 400 textu; server 400 → česká hláška taky.
2. **Unmount guardy** v `SettingsUsersPanel` (`load`, `handleInvite`) — cancelled flag pattern.
3. **Blank state** `?settingsTab=users` během fetchMe → zobraz „Načítám…" místo prázdna (v SettingsPage při adminState unknown).
4. **Dashed border z restricted flagu**: GraphView selector přepnout z `visibility = "group"` na nový `restricted` datový atribut z graph payloadu (Task 14 bod 8) → čárkovaný okraj i pro nody dědící omezení. Org compound výjimku zachovat.
5. **Revocation SLA dokumentace**: do spec (sekce Identita a propagace) doplnit odstavec: členství cache 15 min (GROUP_CACHE_TTL_MS), session JWT 1 h, MCP session až 30 min idle → revokace se projeví do ~1 h; a totéž stručně do docs/env-vars.md poznámek.
6. Zkontroluj `docs/env-vars.md` konzistenci po wave 2 (access_mode nepotřebuje env; nic nepřibylo).

Kroky: implementace → web build + biome + (server build, pokud se sahá na shared typy) → commit `fix(web): users tab polish, inherited restriction styling, revocation SLA docs`.

---

## Po implementaci

Deploy + ruční E2E s druhým účtem — nezměněno, čeká na souhlas uživatele.
