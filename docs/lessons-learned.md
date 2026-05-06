# Portuni – Lessons Learned

Kompletni institucionalni znalost nasbirana behem vyvoje. Koncepty, rozhodnuti, chyby a pouceni.

---

## 1. Koncepty

### POPP framework

Pet kategorii pokryvajicich veskere organizacni prace:

| Typ | Popis | Priklad |
|-----|-------|---------|
| **Organization** | Nejvyssi entita | Acme, Globex, Initech, Stark |
| **Project** | Konkretni usili s zacatkem a koncem | Beacon Launch |
| **Process** | Opakovatelny zpusob prace | Partner Account Management, Navrhy a cenotvorba |
| **Area** | Oblast prubezne odpovednosti | Lidi |
| **Principle** | Pravidlo nebo presvedceni | (zatim bez realnych dat) |

**Graf, ne strom.** Uzly jsou propojeny hranami (edges), ne hierarchii. Projekt muze souviset s vice procesy a oblastmi zaroven. `belongs_to` neznamena stromovou strukturu – entita muze patrit vice rodicovskym uzlum.

### Typy uzlu (node types)

Petice POPP, striktne vymahana na trech vrstvach (Zod enum v tools, CHECK constraint v DB, jediny zdroj pravdy v `src/popp.ts` sdileny napric backendem a app frontendem pres relativni import):

- `organization`
- `project`
- `process`
- `area`
- `principle`

Zadne jine typy. Zadny `methodology`, zadny `process_instance`, zadny `artifact`. Rozhodnuti z dubna 2026 – dvojita zkusenost s driftem seed dat (principy "Start with Assessment", methodology "AI Competency Assessment") ukazala, ze otevreny string nebude fungovat. Pridani noveho typu vyzaduje explicitni schema zmenu.

### Typy hran (edges)

Ctyri ploche relace, striktne vymahane stejne jako node types:

| Relation | Vyznam |
|----------|--------|
| `related_to` | Lateralni, semanticky lehka vazba. Temer default – kdyz nic jineho presneji nesedi |
| `belongs_to` | Entita je scoped do vetsiho celku. Multi-parent povoleno – neni to strom |
| `applies` | Konkretni prace pouziva opakovany vzor (napr. projekt pouziva proces) |
| `informed_by` | Prenos znalosti – ucili jsme se z, cerpali jsme z, odkazovali jsme na |

Vyhozene (nevracet!):
- `depends_on` – hierarchie v prestrojeni. Operacni poradi patri do eventu (blockery) nebo task systemu, ne do grafu.
- `instance_of` – slouzilo methodology/process_instance konstrukci, ktera padla. Roli prebira `applies`.
- `guided_by` – principy jsou kultura, ne pointery. Neni potreba explicitni edge na kazdy princip ze vseho, co jim podleha.

Zadny edge typ neni privilegovany s jednou vyjimkou: `belongs_to` ma topologicky invariant -- viz dalsi sekce.

### Organization invariant

Kazdy non-organization node ma presne jeden `belongs_to` edge smerujici na `organization`. Zadne orphany, zadny multi-parent. Ownership musi byt jednoznacne -- node nemuze existovat mimo organizacni scope.

Vynuceno na trech vrstvach:

1. **`portuni_create_node`** pro non-org typy vyzaduje povinny parameter `organization_id`. Tool provede atomicky `db.batch()` -- INSERT node + INSERT belongs_to edge v jedne transakci. Node nikdy neexistuje v orphan stavu.
2. **`portuni_connect` a `portuni_disconnect`** maji runtime check: druhy `belongs_to → org` pro non-org source je odmitnut, a smazani posledniho `belongs_to → org` non-org nodu je taky odmitnuto. Oba pripady vraci jasny actionable error.
3. **Trigery v DB** (`prevent_multi_parent_org` na INSERT, `prevent_orphan_on_edge_delete` na DELETE) chytaji kazdy primy SQL, ktery obesel tool layer. Defense in depth -- seed scripty, migrace, budouci REST endpointy.

**Startup integrity sweep.** `ensureSchema` pri kazdem startu spousti kontrolu invariantu na vsech non-org nodech (vcetne archived). Prvni violation aborti start s vypisem offender nodu. Portuni neslouzi pozadavky nad nekonzistentnim grafem. Zadny silent warning -- silent warningy byly presne to, jak orphany driv vznikly a zustavaly.

**Poznamka k SQLite omezenim.** BEFORE/AFTER INSERT trigger na `nodes` by nemohl invariant vynutit: SQLite nema deferred constraints, trigger by vystrelil pred vlozenim companion `belongs_to` edge a vzdy by failnul. Proto je vynuceni pri create v tool layer (atomic batch), ne v DB trigger. DB trigger pokryvaji jen INSERT/DELETE na edges, kde deferred check nepotrebujeme.

**Historie rozhodnuti.** Puvodni spec explicitne povolovala multi-parent (proces mohl `belongs_to` vic organizacim). Provoz ukazal, ze multi-parent vedl k nejednoznacnym mirror cestam a cross-organization rusu. Rozhodnuti: jediny topologicky invariant na grafu. Jedna organizace, jedna cesta, jednoznacne ownership.

---

### Symbioticka prace (Human + AI)

Stredni cesta mezi extremy:
- Kopirovat z chatu (delam sam, AI radi) – prilis pomale
- **Symbioza (rozhoduji ja, AI vykonava)** – aktualni rezim
- Plna automatizace (system funguje beze me) – zatim ne

Kazdy kus znalosti vstupuje do systemu, protoze to clovek rozhodl. Zadny auto-sync, zadny background capture.

### Tri exekutori

Kazdy ukol muze byt proveden:
1. **Clovek** – primo
2. **AI agent** – v symbioze s clovekem
3. **Automatizace** – n8n, Make, skript (bez cloveka)

Stejny proces, ruzne rezimy provadeni.

---

## 2. Architektonicka rozhodnuti

### Transport: Streamable HTTP, nikdy SSE

**Problem:** SSE transport (`type: "sse"`) je Claude Code ignorovan v globalni konfiguraci. Server s SSE se neobjevil v `/mcp list`.

**Reseni:** `StreamableHTTPServerTransport` z `@modelcontextprotocol/sdk`. Config: `{ type: "http", url: "http://localhost:3001/mcp" }`.

**Pouceni:** Vzdy testovat MCP server end-to-end v Claude Code ihned po implementaci. Tichy failure je horsi nez hlasity.

### Databaze: Turso (SQLite cloud)

**Proc:** Prenositelnost mezi zarizenimy, stejna SQL semantika jako SQLite, lehci nez PostgreSQL. Schema auto-migrace (`CREATE TABLE IF NOT EXISTS`) funguje dobre.

**Spojeni:** libsql klient pres HTTP, credentials pres Varlock.

### ID: ULID

Pouzivame ULID (Universally Unique Lexicographically Sortable Identifiers) – seraditelne podle casu, kratsi nez UUID, lidsky citelne.

### Jeden uzivatel (Phase 1)

SOLO_USER = `01SOLO0000000000000000000`. Vsechny operace prirazeny tomuto uzivateli. Phase 2 prinese Google OAuth.

**Riziko:** Audit trail z Phase 1 bude ukazovat jednoho uzivatele. Backfill neni plan.

### MCP instrukce jsou povinne

**Problem:** Server bez `instructions` fieldu zpusobil, ze Claude nevedel, k cemu server slouzi, a nepouzival nastroje proaktivne.

**Reseni:** Instrukce (cca 2KB) v McpServer konstruktoru – popisuji co server dela, kdy ho pouzit, a shrnuji nastroje.

**Pouceni:** Nikdy neship MCP server bez instrukci. Nejsou dokumentace pro lidi – jsou discovery context pro Claude.

### Lokalni mirroring

Kazdy uzel muze mit lokalni slozku. Mapovani ulozeno v `local_mirrors` tabulce (per-user).

**Struktura mirror slozky:**
```
{PORTUNI_WORKSPACE_ROOT}/{slug}/
  outputs/    (finalni soubory)
  wip/        (rozpracovane)
  resources/  (zdroje)
```

**Dulezite:** MCP instrukce rikaji ze organizace maji podslozkky `projects/`, `processes/`, `areas/`, `principles/` – ale to vytvari seed skript, ne `portuni_mirror` tool. Tool vytvari jen `outputs/wip/resources/`.

### File management: intentional, ne automatic

`portuni_store` = git commit (vedome rozhodnuti ulozit). `portuni_pull` = git pull (na pozadani). Zadny auto-sync.

### Audit logging

Kazda mutace (create, update, connect, disconnect, store) logovana do `audit_log` s uzivatekem, akci, cilem a detailem (JSON before/after). Write-only, nemenitelny.

---

## 3. Chyby a opravy

### Chyba: SSE transport ignorovan

**Co se stalo:** Server pouzival SSE. Claude Code ho nenacetl.
**Fix:** Prechod na StreamableHTTPServerTransport (commit `2deaab5`).
**Jak zabranit:** Testovat kazdy MCP server v realu okamzite.

### Chyba: Chybejici instrukce

**Co se stalo:** Server bez `instructions` – Claude nenasel duvod nastroje pouzivat.
**Fix:** Pridani instrukci do McpServer konstruktoru.
**Jak zabranit:** Instrukce jsou povinny field pri vytvareni jakehokoliv MCP serveru.

### Chyba: nodes tabulka chybi v DDL

**Stav:** `src/schema.ts` neobsahoval `CREATE TABLE IF NOT EXISTS nodes`. Tabulka existovala v Turso (byla vytvorena driv), ale cista instalace by selhala.
**Fix:** Pridani DDL.

### Chyba: summary field v get-node.ts

**Stav:** `get-node.ts` vracel `row.summary`, ale sloupec neexistoval v DDL a nikdy se nenastavoval.
**Fix:** Odebrani z response. Zavedeni Zod row schemas pro runtime validaci DB vysledku.

### Chyba: mime_type v files nikdy neni nastaven

**Stav:** Sloupec `mime_type` v tabulce `files` existoval, ale `portuni_store` ho neplnil.
**Fix:** Detekce MIME typu z pripony souboru.

---

## 4. Integracni vzory

### SessionStart hook

Kdyz Claude Code session startuje v Portuni workspace slozce, hook automaticky injektuje graf context.

**Jak funguje:**
1. Hook skript: `scripts/portuni-context.sh`
2. Vola `/health` (200ms timeout) – kdyz server nebezi, tichy exit
3. Vola `/context?path={cwd}` (1s timeout)
4. Parsuje JSON, vypisuje formatovany kontext (uzel, hrany, sousedni uzly, posledni eventy)
5. Konfigurace: `~/.claude/settings.json` pod `hooks.SessionStart`

### /context REST endpoint

Resolves filesystem cestu na uzel v grafu:
1. Hleda v `local_mirrors` – nejdelsi matchujici cesta vyhrava
2. Vraci uzel + jeho hrany (depth 1) + mirror cesty sousednich uzlu + posledni eventy
3. Pokud match neni: `{ match: false, path: "..." }`

### Globalni MCP config

```json
// ~/.claude.json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

### Spusteni serveru

Server bezi v tmux session `portuni` na portu 3001. Spousteni pres Varlock:
```bash
tmux new-session -d -s portuni 'cd ~/Dev/projekty/portuni && npx varlock run -- npm run dev'
```

---

## 5. Vyvojove vzory

### Registrace toolu

Kazdy modul exportuje jednu `register*Tools(server: McpServer)` funkci. Volana v `createMcpServer()` v server.ts.

| Modul | Funkce | Nastroje |
|-------|--------|----------|
| nodes.ts | registerNodeTools | create, update, list |
| get-node.ts | registerGetNodeTool | get (s edges, files, events, mirror) |
| edges.ts | registerEdgeTools | connect, disconnect |
| context.ts | registerContextTools | get_context (rekurzivni CTE) |
| mirrors.ts | registerMirrorTools | mirror |
| files.ts | registerFileTools | store, pull, list_files |
| events.ts | registerEventTools | log, resolve, supersede, list_events |

### Zod row schemas pro typovou bezpecnost

`src/types.ts` definuje Zod schema pro kazdy DB radek. Tool moduly pouzivaji `.parse()` na vysledky queries. Integracni test (`test/schema-types.test.ts`) validuje soulad DDL a Zod schemas.

### Rekurzivni CTE pro grafovy traversal

`portuni_get_context` pouziva `WITH RECURSIVE` pro efektivni prochazeni grafu v jedinem DB round-tripu. Zadne N+1 queries.

### Schema auto-migrace

DDL pole v `schema.ts` – spousti se na startu pres `ensureSchema()`. `CREATE TABLE IF NOT EXISTS` zajistuje idempotenci.

**Omezeni:** Zadny ALTER TABLE – zmena existujicich sloupcu vyzaduje rucni migraci v Turso.

---

## 6. Rizika a otevrene otazky

### Rizika
- **Schema drift:** Zadny migracni framework. S rustem teamu bude potreba Turso CLI migrace.
- **Zadne backupy:** Turso ma backupy, ale DR proces neni zdokumentovany.
- **Zadny rate limiting:** Nutne pridat pred multi-user.
- **Testy:** Pokryti je nedostatecne a v praxi nas to uz zranilo (2026-04-26: PATCH /actors/:id 400 na `notes: null` se dostal do produkce, protoze testy zkousi jen happy path se stringy). Konkretne chybi:
  - HTTP/integracni testy MCP endpointu — Zod schemata se nikdy nevolala s realnym tvarem requestu z frontendu.
  - Pokryti "null" vetvi — frontend posila `null` pro vycisteni poli (notes, user_id), backend to v testech nikdy nedostal.
  - Sdilene typy mezi backendem a `app/` — `z.infer<typeof UpdateActorInput>` se neexportuje, frontend ma ruzne psane `string | null`. tsc to nema sanci chytit.
  - Testy nejsou soucasti CI (existuji test/schema-types.test.ts, test/events.test.ts a dalsi, ale nikdo je nehlida pred mergem).

### Otevrene otazky pro Later
- Permission model: node-level groups vs global scope – doplnuji se, nebo prepisuji?
- Event supersede: originalni event zustava, nebo se skryva?
- Sdilene procesy: ktera org "vlastni" sdileny proces?
- Search ranking: keyword vs semantic, nebo merged mode?
