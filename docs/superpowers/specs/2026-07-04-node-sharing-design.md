# Sdílení nodes přes skupiny a uživatele (design)

> Status: design spec, schváleno v brainstormu 2026-07-04, připraveno pro
> implementační plán. Navazuje na
> `2026-06-09-google-groups-auth-design.md` (enforcement vrstva, role,
> `visibility='group'` + `meta.access_group`) – tuto část nahrazuje
> obecnějším modelem. Enforcement infrastruktura (guardy, filtry,
> rekurzivní CTE v `apps/server/auth/node-access.ts`) zůstává, mění se
> reprezentace „kdo smí vidět".

## Cíl

Umožnit sdílení částí grafu tak, aby ne každý viděl vše: velká část
grafu zůstane viditelná všem přihlášeným, organizace může mít tým,
který vidí celou její strukturu, a vybrané podstromy (např. „business
partners") vidí jen užší okruh. K tomu chybějící správa: přiřazování
skupin/uživatelů na node v UI, výběr existujících Google skupin
a základní správa uživatelských účtů.

## Rozhodnutí z brainstormu

| Otázka | Rozhodnutí |
|---|---|
| Jednotka sdílení | Stabilní Google skupiny + ad hoc jednotliví uživatelé Portuni. Default: node bez omezení vidí každý přihlášený. |
| Sémantika seznamu | **Explicitní seznam = přepis.** Node s vlastním ACL ignoruje zděděné; node bez ACL dědí od nejbližšího předka s ACL po `belongs_to` řetězu (dnešní walk beze změny). „Rozšíření" = přepis, který rodičovskou skupinu zopakuje. |
| Správa skupin | Skupiny se zakládají a členství spravuje v Google Admin. Portuni je jen páruje – našeptávač přes Directory API (read-only scope `admin.directory.group.readonly` už udělen). Žádný zápisový scope. |
| Ad hoc lidé | Přímo v ACL nodu jako uživatelé Portuni – žádné jednorázové skupiny. |
| Práva v ACL | ACL řídí **jen viditelnost**. Zápis dál určuje globální role (admin/manage/write z env skupin); týká se jen nodes, které uživatel vidí. |
| Uložení | Nová tabulka `node_access` (ne meta JSON). |
| Identifikátory | Uživatel: `users.id` (ukotven na `google_sub` – rename-proof, už implementováno). Skupina: Directory group **ID** (stabilní), e-mail jen cache pro zobrazení. Mapování globálních rolí v env zůstává na e-mailech skupin (čitelná ruční konfigurace). |
| Domény | `PORTUNI_ALLOWED_DOMAINS` – seznam (primární doména Workspace je tempo.ooo, uživatelé mají i workflow.ooo; obě musí projít). Rename-proof brána přes Workspace customer ID (`C039k2u20`) odložena do fáze externistů. |
| Externí účty | **Odloženo.** Design nesmí bránit: skupiny externí členy umí a Directory API je vrací; později se přidá vstupní brána (login mimo domény pro členy párovaných skupin / pozvané) a OAuth consent screen External. Model se nezmění. |

## 1. Datový model

```sql
CREATE TABLE node_access (
  node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK(kind IN ('group','user')),
  -- group: Directory group ID; user: users.id
  principal  TEXT NOT NULL,
  -- cache pro UI (e-mail skupiny); u kind='user' NULL, e-mail se joinuje z users
  display_email TEXT,
  added_by   TEXT NOT NULL,          -- users.id
  added_at   DATETIME NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (node_id, kind, principal)
);
CREATE INDEX idx_node_access_node ON node_access(node_id);
```

- Node je omezený ⇔ má aspoň jeden řádek v `node_access`.
- **Režim omezení (rozhodnuto 2026-07-04, inspirace Asana):** omezený node
  má `nodes.access_mode` ∈ `'private'` (default) | `'request'`.
  - `private` = dnešní sémantika: ne-člen nevidí vůbec nic, ani název.
  - `request` = „membership by request": ne-člen node dál nevidí v grafu,
    listech, vyhledávání ani detailu, ALE hrany z viditelných sousedů ho
    ukážou jako zamčenou položku (název + typ + `peer_restricted: true`)
    v Propojení detailu a v MCP get_node/context edges. Slouží k tomu, aby
    člověk věděl, že něco existuje, a mohl si (později) vyžádat přístup —
    request flow je mimo rozsah, v1 jen zamčený chip.
  - Režim dědí s ACL: autoritativní předek určuje entries i mode.
  - Sloupec má význam jen u omezených nodes; u neomezených se ignoruje.
- `nodes.visibility='group'` zůstává jako rychlý indikátor a udržuje se
  **automaticky** při editaci ACL (nastaví se s prvním řádkem, vrátí na
  `team` se smazáním posledního). Ruční přepínání visibility na `group`
  bez ACL zůstává fail-closed („restricted bez skupiny" = nikdo kromě
  admina, dnešní `__unresolvable__` sémantika).
- Migrace: existující `meta.access_group` (e-mail) → jeden řádek
  `kind='group'` s doplněným group ID přes Directory API; pokud skupina
  neexistuje, řádek se založí s e-mailem jako principal a zaloguje se
  warning – e-mail se nikdy neprotne s group ID v identitě, takže node
  zůstane viditelný jen adminovi (fail-closed, ekvivalent dnešního
  `__unresolvable__`). `meta.access_group` se poté z meta odstraní.

## 2. Vyhodnocení viditelnosti

`effectiveAccessGroup` v `apps/server/auth/node-access.ts` se zobecní na
`effectiveAccessEntries(db, nodeId)`:

- Stejná rekurzivní CTE po `belongs_to` (jeden round-trip, cycle guard
  `MAX_CHAIN`), nově s JOIN/agregací na `node_access` místo parsování
  `meta`. První node v řetězu (od nodu nahoru), který má řádky, je
  autoritativní; jeho množina řádků je efektivní ACL. Žádné řádky
  v celém řetězu → node je veřejný (pro přihlášené).
- `canSeeNode(identity, entries)`:
  `admin` → true; jinak
  `identity.userId ∈ entries[user]` ∨ `identity.groupIds ∩ entries[group] ≠ ∅`.
  Skupinová položka se matchuje proti group ID i e-mailům identity –
  e-mailové principaly z migrace zůstávají funkční, nové položky z UI
  ukládají ID.
- `filterVisibleNodeIds` (memoizace per request) a všechny vynucovací
  body (guardNodeRead, list/search/context filtry, write guardy, files,
  sync-info) zůstávají – mění se jen vnitřek resolveru a tvar
  `GroupIdentityView` (přibude `userId` a `groupIds`).

### Identita a propagace

- `listGroups` v `google-adapter.ts` nově vrací `{id, email}[]`
  (Directory API obojí posílá už dnes; jen se zahazuje ID).
- Session JWT ponese vedle e-mailů skupin i jejich ID (claims rostou
  o pole stringů; TTL 1 h beze změny). Změna členství ve skupině se
  projeví do hodiny nebo re-loginem – stejné jako dnes u rolí.
- Globální role se dál mapují z e-mailů skupin
  (`PORTUNI_GROUPS_ADMIN/MANAGE/WRITE`).

**SLA revokace přístupu.** Tři nezávislé cache vrstvy zpožďují, kdy se
odebrání ze skupiny/ACL reálně projeví: `GoogleAdapter` cachuje členství
ve skupinách 15 minut (`GROUP_CACHE_TTL_MS` v `google-adapter.ts`),
session JWT nese skupiny/role po dobu 1 h (viz výše), a MCP relace
(`apps/server/mcp/transport.ts`, `SESSION_TTL_MS`) zůstává živá až 30 min
nečinnosti. V nejhorším případě (čerstvě obnovená group cache + čerstvě
vydaný JWT + aktivní MCP session) se odebrání přístupu projeví reálně až
za ~1 h. Pro okamžitou revokaci (kompromitovaný účet, urgentní offboarding)
nespoléhat na TTL vypršení: smazat všechny device tokeny daného uživatele
(dnes jen self-service přes `DELETE /device-tokens/:id`, `handleRevokeDeviceToken`
v `apps/server/api/auth.ts` – pro cizí účet zatím jen přímý zásah v tabulce
`device_tokens`, admin endpoint chybí – v1 mimo rozsah) a počkat na expiraci
session JWT – bez platného device tokenu se nový JWT nevydá, takže i běžící
MCP session skončí nejpozději s idle timeoutem.

## 3. Uživatelé

- `users` tabulka existuje (id = ulid, `google_sub`, email, name,
  avatar, last_login_at); účty vznikají prvním loginem a jsou ukotvené
  na `google_sub` (rename-proof).
- Nové: **pozvání předem** – admin založí účet e-mailem (řádek v users
  bez `google_sub`; login ho pak podle e-mailu spáruje a sub doplní –
  tato větev v `upsertUser` už existuje). Účel: uživatel jde vybrat do
  ACL dřív, než se poprvé přihlásí.
- Nastavení → **Uživatelé** (jen admin): seznam účtů (jméno, e-mail,
  globální role odvozená ze skupin, poslední login), tlačítko „Pozvat"
  (e-mail). Mazání účtů ve v1 není (audit trail, FK z node_access);
  případné odebrání přístupu = vyndat z ACL/skupin.

## 4. UX

### Zamčené položky v Propojení (režim `request`)

- Hrany na omezené sousedy v režimu `request` se v detailu vykreslují jako
  zamčený chip: název + ikona zámku, nekliknutelné (tooltip „Přístup na
  vyžádání"). Režim `private` sousedy z hran odfiltruje úplně.
- MCP get_node/context vrací tytéž hrany s `peer_restricted: true`
  (konzistence UI ↔ agenti, rozhodnuto 2026-07-04).
- Graf, listy a vyhledávání zůstávají beze změny (skrývají oba režimy).
- Id se u zamčených hran nevrací (`id` i `peer_id` jsou `""`) – chip je
  nekliknutelný, takže je nepotřebuje, a vrácení ULID by umožnilo cílené
  zkoušení skrytého uzlu.

### Detail nodu – sekce „Sdílení"

- Zobrazuje efektivní stav: „Vidí všichni" / „Dědí z ‹předek›: ‹chips›"
  / vlastní seznam chips (skupiny s ikonou skupiny, lidé s avatarem).
- Pro globální roli **manage a výš**: editace – přidat skupinu
  (našeptávač přes `GET /auth/groups`), přidat uživatele (výběr
  z účtů), odebrat položku, „Zrušit omezení" (smaže ACL → zpět
  dědění/veřejné), přepínač režimu „Soukromé" / „Na vyžádání"
  (jen u vlastního ACL; default Soukromé).
- Omezený node má ikonu zámku v detailu i na uzlu v grafu.
- Read-only pro ostatní: sekce ukazuje jen stav, bez editace.

### Nastavení – záložka „Uživatelé"

Viz §3. Jen pro admin roli; ostatním se záložka nezobrazuje.

## 5. API

| Route | Min. role | Popis |
|---|---|---|
| `GET /nodes/:id/access` | read* | Efektivní ACL: vlastní/zděděné, z jakého předka, položky s display údaji. *Podléhá node-visibility guardu jako ostatní čtení. |
| `PUT /nodes/:id/access` | manage | Nahradí ACL nodu předaným seznamem (prázdný seznam = zrušit omezení). Server doplní group ID ↔ e-mail přes Directory API a synchronizuje `visibility`. Audit event. |
| `GET /auth/groups?query=` | manage | Našeptávač skupin v doméně (Directory API `groups.list(domain/customer)`, server-side cache ~5 min). |
| `GET /auth/users` | manage | Seznam účtů pro ACL picker (id, jméno, e-mail, avatar). |
| `POST /auth/users/invite` | admin | Založí účet e-mailem (pozvání předem). |
| `GET /auth/users/admin` | admin | Rozšířený seznam pro správu (role, last_login_at). |

- Všechny routy dostanou položku v `auth/min-scopes.ts` (fail-closed
  default admin zůstává).
- MCP tooly pro sdílení ve v1 **nejsou** – sdílení je lidská akce v UI;
  agenti podléhají ACL automaticky, protože enforcement je pod všemi
  cestami (REST i MCP).

## 6. Konfigurace

- `PORTUNI_ALLOWED_DOMAIN` → `PORTUNI_ALLOWED_DOMAINS`
  (čárkou oddělený seznam; stará proměnná zůstane jako alias pro
  jednoprvkový seznam). Produkce: `workflow.ooo,tempo.ooo`.
- Directory API: stávající DWD service account + scope
  `admin.directory.group.readonly` stačí na vše výše (listování skupin
  v doméně i členství). Žádný nový scope.
- `docs/env-vars.md` aktualizovat.

## 7. Testy

- Unit: `node-access` s tabulkou – override sémantika (vlastní ACL
  vs. dědění), user i group položky, fail-closed větve (visibility
  group bez řádků), migrace meta.access_group.
- API: access routy včetně min-scopes, invite flow, groups picker
  (Directory mock).
- Integrační scénář „business partners": org viditelná org skupině,
  podřízený node užší skupině; ověřit list/search/get/context/files
  a sync-info pro člena i ne-člena.
- Ruční E2E po nasazení: druhý účet na tempo.ooo doméně (po
  `PORTUNI_ALLOWED_DOMAINS` se konečně přihlásí) jako ne-člen.

## 8. Mimo rozsah v1

- Externí účty (vstupní brána, OAuth consent External, customer-ID
  kontrola) – viz tabulka rozhodnutí.
- Zakládání skupin a správa členství z Portuni (Directory write scope).
- Per-položka read/write v ACL (Asana-style úrovně).
- MCP tooly pro čtení/změnu sdílení.

## Otevřené body pro implementační plán

- Přesný tvar CTE s agregací řádků node_access (jeden dotaz vs. dva:
  chain → autoritativní node → řádky; druhá varianta je jednodušší
  a pořád O(1) round-trips navíc).
- Kde přesně v DetailPane sekci Sdílení ukotvit (vedle sync sekce)
  a tvar chips komponent.
- Server-side cache pro `GET /auth/groups` (TTL, invalidace není
  potřeba – picker snese 5 min staré jméno skupiny).
- Pořadí landingu: (1) schéma + resolver + migrace + testy,
  (2) API routy, (3) UI Sdílení, (4) UI Uživatelé + invite,
  (5) `PORTUNI_ALLOWED_DOMAINS` + deploy + ruční E2E.
