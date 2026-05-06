# Portuni – Implementacni plan

Posledni aktualizace: 2026-04-09. Overeno vuci aktualnimu kodu a DB.

---

## Phase 1: Pouzitelny graf + lokalni soubory – HOTOVO

### Nastroje (11 MCP tools)

| Nastroj | Stav | Poznamky |
|---------|------|----------|
| portuni_create_node | hotovo | |
| portuni_update_node | hotovo | |
| portuni_list_nodes | hotovo | |
| portuni_get_node | hotovo | Vraci edges, files, mirror. |
| portuni_connect | hotovo | Duplicity osetreny (app-level check + unique index). |
| portuni_disconnect | hotovo | |
| portuni_get_context | hotovo | Rekurzivni CTE, depth 0-5. |
| portuni_mirror | hotovo | Vytvari outputs/wip/resources/ podslozkky. |
| portuni_store | hotovo | Kopiruje soubor do mirror slozky. |
| portuni_pull | hotovo | Seznamuje soubory uzlu. |
| portuni_list_files | hotovo | Globalni listing s filtry. |

### DB schema

| Tabulka | Stav | Poznamky |
|---------|------|----------|
| users | hotovo | SOLO_USER seedovan |
| nodes | hotovo | |
| edges | hotovo | Unique index na (source_id, target_id, relation). |
| audit_log | hotovo | |
| local_mirrors | hotovo | Composite PK (user_id, node_id) |
| files | hotovo | Index na node_id |

### Integrace

| Polozka | Stav |
|---------|------|
| Streamable HTTP transport (port 3001) | hotovo |
| MCP instrukce (~2KB) | hotovo |
| Auto-seed read scope na MCP connect (`?home_node_id=`) | hotovo (nahradilo SessionStart hook + /context endpoint) |
| /health endpoint | hotovo |
| Globalni config (~/.claude.json, type: http) | hotovo |

### Opravene bugy (2026-04-04)

| # | Problem | Stav |
|---|---------|------|
| 1 | nodes tabulka chybi v DDL | opraveno |
| 2 | Unique index na edges necommitnuty | opraveno |
| 3 | summary field v get-node | opraveno (odebran) |
| 4 | mime_type v files se neplni | opraveno (detekce z pripony) |
| 5 | MCP instrukce zavadejici | opraveno (upresneno) |
| 6 | Zod row schemas + integracni test | pridano (src/types.ts, test/schema-types.test.ts) |

---

## Schema enforcement (2026-04-09) – HOTOVO

Striktni validace POPP typu a edge relaci na trech vrstvach. Driv byl `type` volny string ("not enforced" v tool description), coz vedlo k driftu – seed skripty pridavaly `methodology` a `process_instance` uzly mimo POPP petici, a nikdo je nezastavil.

| Vrstva | Implementace | Soubor |
|--------|--------------|--------|
| Zdroj pravdy | `NODE_TYPES` + `EDGE_RELATIONS` jako `as const` tuple + TypeScript types, bez runtime dependenci, sdileny napric backendem a app frontendem pres relativni import | `src/popp.ts` |
| Backend re-export | `src/schema.ts` re-exportuje z `./popp.js`, aby existujici importy `from "../schema.js"` nadale fungovaly | `src/schema.ts` |
| MCP tool layer | `z.enum(NODE_TYPES)` v `portuni_create_node`, `portuni_list_nodes`; `z.enum(EDGE_RELATIONS)` v `portuni_connect`, `portuni_disconnect` | `src/tools/nodes.ts`, `src/tools/edges.ts` |
| DB layer | `CHECK(type IN (...))` a `CHECK(relation IN (...))` v DDL, obe sestavene z `NODE_TYPES` a `EDGE_RELATIONS` v runtime | `src/schema.ts` |
| Migrace | `migrateEnforceTypes()` – idempotentni, rekonstrukce existujicich tabulek s CHECK, spousti se z `ensureSchema()` | `src/schema.ts` |
| Frontend | `app/src/types.ts` re-exportuje `NODE_TYPES` a `RELATION_TYPES` (alias pro `EDGE_RELATIONS`) z `../../src/popp` – zadna kopie, zadna synchronizace, drift je nemozny | `app/src/types.ts` |
| Frontend cleanup | `methodology` pryc z palety, temat, CSS, komponent | `app/src/lib/colors.ts`, `app/src/lib/theme.ts`, `app/src/index.css`, `app/src/components/{DetailPane,Sidebar,GraphView}.tsx` |
| Dokumentace | Aktualizovane `popp.md`, `specs.md`, `lessons-learned.md`, `artifacts-hosting.md`, reference/nodes.md, reference/edges.md | viz docs-site + docs |

### Kanonicka sada

**Node types (5):** `organization`, `project`, `process`, `area`, `principle`. Zadne `methodology`, `process_instance`, ani `artifact`.

**Edge relations (4):** `related_to` (temer default), `belongs_to` (scope, multi-parent), `applies` (projekt pouziva proces apod.), `informed_by` (prenos znalosti). Zadne `guided_by`, `depends_on`, `instance_of`.

### Rozhodnuti

- **`guided_by` vyhozen:** principy jsou kultura, ne pointery. Explicitni edge z kazde entity na kazdy princip by bylo low-signal spaghetti. Agent ma hledat principy v relevantni organizaci jako ambientni default.
- **`depends_on` vyhozen:** hierarchie v prestrojeni. DAG je strom se sipkami, POPP je rhizome. Operacni prerequisites patri do eventu (blockery) nebo externich task systemu.
- **`instance_of` vyhozen:** byl urceny pro `methodology → process_instance`, oba typy padly. `applies` pokryva stejnou semantiku bez nove abstrakce.
- **`related_to` neni fallback, ale temer default:** rhizomaticky graf nema privilegovane hrany. Vetsina vazeb je lateralni, `related_to` je fer vyjadreni teto vetsiny.

### Data cleanup v Turso

- 3 seed principles smazane (`Start with Assessment`, `Document Decisions`, `Flat Structure`) – generickezzz placeholdery z puvodniho `seed-popp.ts`.
- 1 methodology uzel smazany (`AI Competency Assessment`) – tez seed.
- 1 methodology uzel zkonvertovan na `process` (`GWS Implementation`) – realna business data.
- Vysledek: 36 uzlu, 33 hran, 4 realne typy v uzivani (`area`, `organization`, `process`, `project`). `principle` je aktualne prazdne – realne principy se budou doplnovat rucne podle potreby.

### Overeno

- Build zeleny (`tsc` backend + frontend)
- 11/11 testu zelenych (`npm test`)
- CHECK constraint odmitl primy INSERT s `type='methodology'`
- CHECK constraint odmitl primy INSERT s `relation='depends_on'`
- MCP server restartovan, migrace aplikovana na Turso, data preservovana

---

## Organization invariant (2026-04-09) – HOTOVO

Pridani jedineho topologickeho invariantu na grafu: kazdy non-organization node ma presne jeden `belongs_to` edge smerujici na `organization`. Zadne orphany, zadny multi-parent.

| Vrstva | Implementace | Soubor |
|--------|--------------|--------|
| Tool layer create | `portuni_create_node` pro non-org typy vyzaduje `organization_id` parameter. Provede atomicky `db.batch()` s INSERT node + INSERT belongs_to edge. Pre-validace ze org_id existuje a ma type='organization'. | `src/tools/nodes.ts` |
| Tool layer connect | `portuni_connect` odmita druhy `belongs_to → org` pro non-org source. Runtime check s clear error. | `src/tools/edges.ts` |
| Tool layer disconnect | `portuni_disconnect` odmita smazani posledniho `belongs_to → org` non-org nodu. Runtime check s clear error. | `src/tools/edges.ts` |
| DB trigger multi-parent | `prevent_multi_parent_org` BEFORE INSERT on edges -- blokuje druhy belongs_to → org. | `src/schema.ts` |
| DB trigger orphan | `prevent_orphan_on_edge_delete` BEFORE DELETE on edges -- blokuje smazani posledniho belongs_to → org. | `src/schema.ts` |
| Startup sweep | `migrateOrgInvariant` v `ensureSchema` spousti integrity check pri kazdem startu. Violation aborti start s vypisem offender nodu. Kontroluje vsechny non-org nody vcetne archived. | `src/schema.ts` |

### Proc ne BEFORE INSERT trigger na nodes

SQLite nema deferred constraints. Trigger BEFORE/AFTER INSERT na nodes by vystrelil pred vlozenim companion `belongs_to` edge (edge se vklada jako druhy statement v batchi) a vzdy by failnul. Proto vynuceni pri create musi byt v tool layer, ne v DB trigger.

### Data cleanup v Turso pred zapnutim

- Merged 2 duplicitni "Beacon Launch" nody do jednoho canonical (mladsi, ktera mela belongs_to → Acme, event o Alice Smith, a local mirror).
- Fixnut multi-parent na "Navrhy a cenotvorba" -- nechan jen belongs_to → Globex, smazan belongs_to → Acme.
- Smazana organizace "Globex Dev" (duplicita/chyba, spravna je "Engineering") vcetne mirror slozky.
- Smazan archived orphan "CRUD Test 2" (test leftover, nula dependents).

### Overeni

- 34 nodu (5 org + 5 area + 6 process + 18 project active + 0 archived), 31 hran, 0 orphans, 0 multi-parents.
- DB triggery overeny: multi-parent INSERT odmitnut, last-org DELETE odmitnut, related_to passthrough funguje.
- Build zeleny, 11/11 testu zelenych, server startuje s integrity sweep success.

---

## Phase 2: Events – HOTOVO

Casova osa udalosti v grafu. Co se stalo, kdy, na kterem uzlu.

| Polozka | Stav | Poznamky |
|---------|------|----------|
| events tabulka + EventRow Zod schema | hotovo | DDL + index na node_id a status |
| portuni_log | hotovo | type, content, meta, refs, task_ref |
| portuni_list_events | hotovo | Filtry: node_id, type, status, since |
| portuni_resolve | hotovo | Merge resolution do meta |
| portuni_supersede | hotovo | Archivuje stary, vytvori novy s refs |
| Rozsireni get_node o eventy | hotovo | Poslednich 50 eventu |
| Rozsireni get_context o eventy | hotovo | Depth 0: plne (50), depth 1: posledni (5), depth 2+: zadne |
| /context endpoint + SessionStart hook | hotovo | Poslednich 5 aktivnich eventu |
| MCP instrukce aktualizovany | hotovo | Popis event toolu + EVENTS sekce |

---

## Phase 3: File sync (pluggable adapter + Google Drive) – HOTOVO (2026-04)

Files attached to nodes ted putuji s grafem. Pluggable adapter pattern (`FileAdapter`), Drive Service Account jako prvni konkretni backend, per-device sync.db, hash identity, two-layer state. Design rozepsany v `docs/architecture/file-sync.md`, user-facing summary v `src/sync/README.md`.

| Polozka | Stav | Poznamky |
|---------|------|----------|
| Pluggable `FileAdapter` interface | hotovo | `src/sync/types.ts`; podporuje gdrive/dropbox/s3/fs/webdav/sftp |
| Google Drive (Service Account) adapter | hotovo | `drive-adapter.ts` + `drive-sa-auth.ts`; Shared Drives only, `supportsAllDrives=true` |
| OpenDAL adapter (FS + memory) | hotovo | `opendal-adapter.ts` pro testy a lokalni FS backend |
| `sync_key` immutable node identifier | hotovo | migrace 013, NOT NULL UNIQUE, slugified, vsechny cesty z neho |
| Two-layer state (Turso shared + local sync.db) | hotovo | `files.current_remote_hash` shared, `~/.portuni/sync.db` per-device |
| `remotes` + `remote_routing` tabulky | hotovo | priority-ordered routing, `NULL` wildcards |
| TokenStore (file/keychain/varlock) | hotovo | per-device kredencialy, SA JSON nikdy v Turso |
| `portuni_store` / `portuni_pull` | hotovo | adapter-aware, hash diff, conflict detection |
| `portuni_status` (real discovery) | hotovo | tracked + new_local + new_remote, stale-mirror tolerance |
| `portuni_snapshot` | hotovo | export native Drive formatu (Docs/Sheets/Slides) |
| `portuni_setup_remote` / `portuni_set_routing_policy` / `portuni_list_remotes` | hotovo | konfigurace remotu |
| `portuni_move_file` / `portuni_rename_folder` / `portuni_delete_file` | hotovo | confirm-first, `repair_needed` semantics |
| `portuni_adopt_files` | hotovo | adopce existujicich souboru z remote do grafu |
| `portuni_mirror` auto-scaffold | hotovo | `ensureFolder` adapter method vytvori remote slozku pri prvnim mirror callu |
| Migrace 011/012 | hotovo | drop legacy Turso `local_mirrors`, drop `files.local_path` |
| Bulk skripty | hotovo | `scripts/bulk-promote.ts`, `cleanup-ignored-files.ts`, `move-rogue-files.ts` |
| Two-device regresni testy | hotovo | `test/sync-*.test.ts`, real per-device sync.db |

**Mimo scope Phase 1 (roadmap):**

- OAuth user flow (per-user auth, ne jen SA)
- Domain-wide delegation pro Workspace deployments s external-member restriction na Shared Drives
- Konkretni adaptery pro Dropbox, S3, WebDAV, SFTP (interface je pripraveny)
- Background sync daemon (zatim vse explicit, on-demand pres MCP tools)

---

## Later

### Search

| Polozka | Popis |
|---------|-------|
| FTS5 full-text search | SQLite FTS5 nad uzly a eventy |
| portuni_search (keyword mode) | Hledani v grafu |
| Embedding model | CZ/EN podpora, text-embedding-3-small nebo alternativa |
| node_embeddings + event_embeddings | sqlite-vec |
| portuni_search semantic + auto mode | Rozsireni keyword searche |

### Sumarizace

| Polozka | Popis |
|---------|-------|
| LLM sumarizace uzlu | Automaticke shrnuti na zaklade eventu |
| Dirty flag + lazy regenerace | 30s debounce po poslednim eventu |
| Embedding cascade | event -> summary -> node embedding |
| max_tokens na get_context | Omezeni velikosti odpovedi |

### Multi-user + auth

| Polozka | Popis |
|---------|-------|
| Google OAuth login | Nahrada SOLO_USER |
| Permission model (Google Groups) | Global scopes + node-level groups |
| Web UI pro graf (read-mostly) | |
| VPS deployment | |
| Rate limiting | |

### Artifacts hosting

| Polozka | Popis |
|---------|-------|
| GitHub repo workflow-pages | Centralni repo pro artefakty |
| Cloudflare Pages (pages.example.com) | Hosting |
| Portuni artifact nodes | Uzly typu artifact s hranami |
| publish_artifact workflow | gh commit + create_node + connect |

### Testing & quality (TODO – soucasny stav je nedostatecny)

Trigger: 2026-04-26 unik bugu `PATCH /actors/:id` 400 na `notes: null`. Unit testy validuji jen happy path se stringy, takze "vycisti pole = posli null" se nikdy netestovalo. Frontend ma `notes?: string | null`, backend Zod mel `z.string().optional()`, tsc nema sanci to chytit.

| Polozka | Popis |
|---------|-------|
| HTTP/integracni testy MCP endpointu | Volat `PATCH /actors/:id`, `POST /nodes`, atd. tvarem, jaky posila frontend (`app/src/api.ts`). Pokryt "null" vetve pro vsechna nullable pole. |
| Sdilene typy backend ↔ app | Vyexportovat `z.infer<typeof Update*Input>` z `src/tools/*.ts` a importovat ve `app/src/api.ts` misto rucne psanych typu. Ruseni driftu, ktery `tsc` nedetekuje. |
| CI gate | `npm test` + `npm run lint:strict` jako blokujici check pred mergem (GitHub Action). |
| Coverage focus | Ne 100 %, ale kazdy MCP nastroj musi mit aspon jeden integracni test ktery posle realny request shape, vcetne null/undefined variant. |
| Frontend smoke | Nejaky lehky e2e (Playwright nebo just hand-cranked fetch) pro klicove flowy: vytvor/uprav/maz actor, node, responsibility. |

---

## Tech stack

| Komponenta | Hodnota |
|------------|---------|
| Jazyk | TypeScript (ESM, strict) |
| Runtime | Node.js >= 20 |
| DB | Turso (libsql cloud) |
| MCP SDK | @modelcontextprotocol/sdk ^1.29.0 |
| ID | ULID (ulid ^3.0.2) |
| Secrets | Varlock ^0.7.1 |
| Transport | Streamable HTTP (port 3001) |

### Zdrojove soubory

```
src/
  server.ts       – HTTP server, MCP setup, /context, /health
  schema.ts       – DDL, SOLO_USER, ensureSchema()
  db.ts           – Turso klient
  audit.ts        – logAudit() helper
  types.ts        – Zod row schemas pro vsechny DB tabulky
  tools/
    nodes.ts      – create, update, list
    get-node.ts   – get (s edges, files, events, mirror)
    edges.ts      – connect, disconnect
    context.ts    – get_context (rekurzivni CTE)
    mirrors.ts    – mirror
    files.ts      – store, pull, list_files
    events.ts     – log, resolve, supersede, list_events
```
