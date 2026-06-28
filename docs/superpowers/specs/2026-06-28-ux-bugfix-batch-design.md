# UX bugfix dávka "Chyby a drobné úpravy" – design

> Status: design spec, ready for implementation plan. Authored 2026-06-28.
> Zdroj: Asana sekce "Chyby a drobné úpravy" projektu Portuni #todo
> (`https://app.asana.com/1/14933110711900/project/1213984083659233`).
> Pokrývá 10 nedokončených úkolů z té sekce. File:line reference platí
> ke stavu repa při psaní specu.

## Rozhodnutí (vstup od Honzy, 2026-06-28)

1. **Cluster D (agent: zdroje + složky, úkoly 4+5) = soft hint.** Jen obohatit
   materializované instrukce agenta. Žádná změna write-scope enforcementu teď.
   Tvrdé vynucení (zúžení allow-globů na podsložky, subfolder-aware guard) je
   vědomě odložené jako pozdější měřený follow-up (vize měří "write leak
   incidents" – data, ne dojmy).
2. **Cluster C (události, úkol 3) = seskupit podle data.** Akceptovat stávající
   editovatelné `created_at` jako "termín", seskupit pod hlavičky dat. Žádná
   schema migrace, žádné nové pole.
3. **Pořadí = hodnota napřed.** Nejdřív agent-correctness (D), pak terminál
   polish + editor, drag-drop (úkol 7) poslední kvůli Tauri buildu, události
   průběžně.

## Proč to vůbec řešit (fit s vizí)

Vize (`docs/vision/portuni-as-workspace.md`): Portuni = *"agent-native control
plane pro znalostní práci"*, Obsidian s agentem jako primárním kanálem. Soutěží
o **správnost a kontrolu**, ne o rychlost. Graf je shell; vše orbituje kolem
aktivního node (terminál cwd, agent context, editor scope).

Dvě z těchto "drobných úprav" nejsou kosmetika, ale leží přímo na value
propu:

- **Úkol 4 (agent nekouká na zdroje)** popírá *"agent už ví, kde jsem, co se
  rozdělaného povaluje"*.
- **Úkol 5 (agent ukládá mimo složky)** popírá *"přestane se stávat, že agent
  zapisuje špatně"* – self-test to dokonce měří jako "write leak incidents".

Proto jdou tyto dva první (hodnota napřed), i když jsou v Asaně schované pod
"drobné úpravy". Zbytek je polish terminálu (Phase 3) a editoru (Phase 4),
který drží denní použitelnost daily-driveru.

## Non-goals

- **Žádný realtime filesystem watcher.** Markdown editor spec
  (`2026-06-07-markdown-editor-design.md`) ho vědomě zamítl. Úkol 2 řešíme
  pollem `version` (sha256), konzistentně s existujícím 5s pollem detailu.
- **Žádná změna write-scope enforcementu** (allow-globy, guard tiery) v této
  dávce. Cluster D je instructions-only (rozhodnutí 1).
- **Žádné nové pole `termín`** v `events`. Cluster C je frontend grouping nad
  existujícím `created_at` (rozhodnutí 2).
- **Žádný WYSIWYG**, žádná editace ne-textových souborů. Beze změny oproti
  editor specu.

## Clustery a přístup

Deset úkolů = čtyři clustery podle subsystému. Klíčové cross-cutting insighty:

- **4 + 5 sdílí jedno místo opravy** (`buildSoftHint`) – jeden coordinated
  change, ne dva bugy. Root cause: materializované instrukce agenta jsou tenké.
- **1 + 6a sdílí node-list** (`WorkspaceNodeList.tsx` + `sessions.ts`).
- **Loop-aware:** vše kromě úkolu 7 a 6b (Rust signál) běží na rychlém loopu
  (Vite HMR / tmux `tsc` ~2 s). Úkol 7 a 6b nutí Tauri build → batch na konec.
- **2 a 10 mají většinu dílů už hotovou, jen nezapojenou** (`version`/
  `reloadTheirs`/poll precedent existují; `adapter.url()` existuje, ale je
  mrtvý kód bez endpointu).

---

### Cluster D – Chování agenta (úkoly 4, 5) · backend, tmux loop · PRVNÍ

**Root cause (společný):** `buildSoftHint()` (`src/domain/write-scope.ts:444-465`)
je jediné tělo persistentních instrukcí agenta – zapisuje se do
`PORTUNI_SCOPE.md`, `.cursor/rules` a marker bloku v `CLAUDE.md`/`AGENTS.md`
(`src/domain/scope-materialize.ts:115-127`). Dnes pokrývá **jen** write-tiery a
`portuni_store` registraci. Neříká nic o (4) datových zdrojích node ani (5) kam
ukládat soubory.

**Úkol 4 – agent nekouká na zdroje.** Data sources existují a JSOU dostupné přes
`portuni_get_context` (depth 0, `context.ts:308-313`), `portuni_get_node`
(`get-node.ts:192-193`) a `portuni_list_data_sources` (`entity-attributes.ts:83-107`).
Auto-seed (`src/mcp/auto-seed.ts:67-90`) ale injektuje jen scope IDs, žádný
obsah, a žádná instrukce agentovi neřekne, že node nějaké zdroje *má*.

- **Fix:** vypsat zdroje node (název + URL/typ) přímo do `buildSoftHint`, plus
  větu "než začneš, podívej se na tyto zdroje / zavolej `portuni_list_data_sources`".
- **Plumbing:** `materializeScopeConfig` (`scope-materialize.ts:152-298`) i
  `buildSoftHint` dnes dostávají **jen cesty + nodeId, žádný DB handle**.
  Surfacing reálných řádků zdrojů znamená protáhnout fetch `data_sources` do
  `materializeScopeConfig` a rozšířit signaturu `buildSoftHint`. (Alternativa:
  posílit `server.ts:31-35` INSTRUCTIONS – ale to je generické, ne per-node;
  preferujeme per-node hint.)

**Úkol 5 – agent ukládá soubory mimo složky.** In-node složky
`wip/outputs/resources` se scaffoldí při vzniku mirroru
(`src/domain/sync/mirror-create.ts:267-270`); sémantiku popisuje
`src/mcp/resources/sync-model.md:12-22`. Jediná zmínka složek v hintu je dnes v
*registračním* kontextu (`write-scope.ts:456-462`), nikdy ne "ukládej SEM".

- **Fix:** doplnit do `buildSoftHint` jasnou save-location guidance: nové
  soubory patří do `wip/` (rozdělaná práce), `outputs/` (finální), `resources/`
  (referenční); kořen mirroru je vyhrazen pro Portuni-managed soubory.
- **Bez enforcementu** (rozhodnutí 1): `buildClaudeSettings` allow-globy
  (`write-scope.ts:355-406`) zůstávají `<mirror>/**`. **Důležité proč:** root
  soubory (`CLAUDE.md`, `.mcp.json`, `PORTUNI_SCOPE.md`, `.claude/…`) MUSÍ
  zůstat zapisovatelné – zúžení na podsložky by je rozbilo. To je přesně důvod,
  proč tvrdé vynucení potřebuje vlastní design a měření, ne tuhle dávku.

**Materializace se musí přegenerovat** po změně `buildSoftHint`:
`materializeAllRegisteredMirrors()` (`scope-materialize.ts:307-343`) běží při
boot sidecaru, takže nové instrukce se rozšíří do všech mirrorů automaticky po
restartu. Ověřit, že re-run je idempotentní vůči marker bloku.

---

### Cluster A – Terminál (úkoly 1, 6, 8, 7) · frontend + (7,6b) Tauri

**Úkol 1 – aktivní terminál není označený.** Active session je dnes
`activeSessionIdByNode[nodeId]` (`App.tsx:285`), ale jediný vizuální marker je
jemné podbarvení `#N` sub-řádku (`WorkspaceNodeList.tsx:117-128`), které
prohrává se zelenou tečkou vedle. V canvasu terminálu (`TerminalTabs.tsx:58-78`)
není žádný header/title.

- **Fix:** posílit "selected" treatment sub-řádku (jasný akcent/levý border +
  label) a/nebo přidat lehký header aktivní session do `TerminalTabs.tsx:61-77`.
  Frontend-only, HMR.

**Úkol 6 – indikátor aktivity je zelený, i když agent nepracuje.** Root cause:
`isSessionActive` = `now - lastOutputAt <= 1500ms` (`sessions.ts:78-84`),
krmený z App listeneru na **každý** `pty-data` chunk pro **každou** session
(`App.tsx:527-531`). Spustí ho kurzor, spinner, echo kláves, `ls`. Label "Agent
píše" je tedy nepravdivý. Rozpad opravy podle loopu:

- **6a (frontend, teď):** zazelenat jen sessions, jejichž `command` je agent
  (claude/codex/vibe) – frontend tu informaci má (`TerminalSession.command`,
  data model v multi-session specu). Bare-shell sessions přestanou falešně
  svítit. Plus opravit label / sémantiku (zelená = agent produkuje výstup,
  oranžová = idle). Render: `WorkspaceNodeList.tsx:100-105,123-127`.
- **6b (Rust, Tauri batch, později):** skutečná detekce "počítá vs. čeká na
  promptu" přes foreground process group PTY v `src-tauri/src/pty.rs`. Odložit
  do Tauri batche s úkolem 7 (stejný pomalý loop). 6a sám o sobě odstraní
  většinu falešných pozitiv.

**Úkol 8 – diffy/kód v light mode neviditelné.** `buildXtermTheme()`
(`TerminalPane.tsx:59-71`) nastavuje jen bg/fg/cursor/selection, **žádnou ze 16
ANSI barev**. xterm padá na default paletu laděnou pro tmavé pozadí; v light
mode (`--color-bg: #f8fafc`) světlé foreground barvy zmizí.

- **Fix:** rozšířit `buildXtermTheme()` o plnou 16-barevnou ANSI paletu per mode
  (light/dark). Zdroj palet přidat do `THEMES` (`theme.ts:17-55`) a protáhnout
  `theme` do funkce. Re-apply cesta (`TerminalPane.tsx:434-438`) už existuje.
  Frontend-only, HMR.

**Úkol 7 – nejde přetáhnout soubor z Finderu do terminálu.** Žádné drag-drop
handling nikde; `tauri.conf.json:12-24` nenastavuje `dragDropEnabled` (v Tauri 2
default `true` → OS file-drop pohltí drop a potlačí HTML5 DOM eventy webview).

- **Fix (preferovaná cesta):** Tauri native listener
  `getCurrentWebview().onDragDropEvent(...)` v `TerminalPane.tsx`; na drop zapsat
  cestu(y) do aktivní session přes existující `pty_write` (`pty.rs:439-451`).
  Resolvovat drop na viditelnou session. Capabilities už povolují
  `core:event:default`. **Tauri loop** (`cargo tauri dev` / build).
  - Pozn.: na macOS HTML5 drop neexpozuje skutečnou filesystem cestu, proto
    native-event cesta, ne `dragDropEnabled:false` + onDrop.

---

### Cluster B – File/editor viewer (úkoly 9, 10, 2) · frontend + (10) backend

**Úkol 9 – po zavření souboru spadnu na úvod node místo na kartu Soubory.**
Root cause: otevření editoru **odmountuje** `DetailPane` (ternary
`EditorPane` vs `DetailPane` ve stejném slotu: `App.tsx:811-843` graph,
`WorkspaceView.tsx:96-101,123-154` workspace), takže lokální `tab` state
(`DetailPane.tsx:246-248`) zanikne a po zavření (`App.tsx:399-405`) se
reinicializuje na "overview". Není to špatný reset, je to unmount.

- **Fix:** zvednout `tab` state do `App.tsx` (vedle `editorFile`), předávat
  controlled `tab`/`onTabChange` do `DetailPane` (nahradit `useState` na
  `:246`) a protáhnout přes `WorkspaceView` (Props `:18-55`). Protože soubory se
  vždy otevírají z karty Soubory, tab bude při zavření pořád "files". Frontend.

**Úkol 10 – zkopírovat odkaz na soubor (local + Google Disk).**

- **Local (triviální):** `DetailFile.local_path` (`api-types.ts:64-80`) už je na
  frontendu. Přidat akci "Kopírovat cestu" do hover clusteru `FileRow`
  (`DetailPane.files.tsx:509-547`), reuse copy pattern z `PathCopy`/`IdCopy`
  (`DetailPane.tsx:3391-3416,3507-3533`). Pozor: `toTreeFiles`
  (`DetailPane.files.tsx:86-108`) dnes `local_path` zahazuje – doplnit do
  `TreeFile`.
- **Google Disk (potřebuje backend):** `adapter.url(path)` už vrací
  `drive.google.com/file/d/<id>/view` (`drive-adapter.ts:257-261`), ale je to
  **mrtvý kód bez callera**. Přidat endpoint `GET /nodes/:id/file-url?path=…`
  (klon `handleFolderUrl` `nodes.ts:331-399`, ale `adapter.url` místo
  `folderUrl`), route `router.ts:400-403`, scope `auth/min-scopes.ts:115`,
  klient vedle `fetchNodeFolderUrl` (`api.ts:72`). `remote_path` souboru je v DB
  `files` (queryovatelné podle `file_id`). Backend tmux loop + frontend.
  - "Odkaz na google drive" dnes (node-folder-level `FolderLink`,
    `DetailPane.tsx:3454-3488`) vrací null/skrytý, dokud složka není synced –
    pravděpodobně to "rozbité" chování, které Honza viděl. Per-file endpoint je
    nezávislý.

**Úkol 2 – otevřený soubor se externě změní, nedozvím se to.** Žádný watcher
nikde (vědomě, viz editor spec). Save-time 409 conflict
(`file-content.ts:105-121` → `EditorPane.tsx:94-104`) chytí změnu jen při
ukládání; při pouhém *náhledu* nevidíš nic.

- **Fix:** přidat do `use-file-editor.ts` lehký poll (reuse 5s precedent
  `App.tsx:492-509`), který re-fetchne `version` a porovná s drženým `version`
  (`:16`); při neshodě nastavit `externalChange` flag (odlišný od save-time
  `conflict` `:19`). Surface v banneru `EditorPane.tsx:94-104` i když není dirty,
  s akcí "Načíst aktuální verzi" = `reloadTheirs` (`:80`). Backend `GET
  /nodes/:id/file` (`src/api/files.ts:44`) vrací full content+sha – pro markdown
  velikosti OK; volitelně později version-only endpoint. Převážně frontend.

---

### Cluster C – Události (úkol 3) · frontend only

**Úkol 3 – události se musí řadit pod termín.** Backend už řadí `created_at
DESC` (`node-detail.ts:109-114`); frontend jen passthrough bez seskupení
(`DetailPane.tsx:869-892`). `created_at` dělá dvojí službu – čas logu i
editovatelný "termín" (DatePicker mění jen datum, čas zachová:
`DetailPane.events.tsx:38-40,98,145-146`).

- **Fix (rozhodnutí 2, frontend-only):** seskupit `node.events` pod hlavičky
  dat (`evt.created_at.slice(0,10)`) v `DetailPane.tsx:869-892`. Volitelně
  normalizovat edit tak, aby stejný den seskupoval čistě. Žádná migrace, žádná
  backend změna.

---

## Pořadí implementace (hodnota napřed, loop-aware)

1. **Cluster D – agent (4+5).** Backend `buildSoftHint` + protažení
   `data_sources` do `materializeScopeConfig`. Rebuild + restart sidecaru,
   ověřit přegenerování mirrorů. *Nejvyšší hodnota.*
2. **Cluster A frontend – 1 + 6a + 8.** Node-list active marker + agent-gated
   indikátor + ANSI palety. Jeden HMR sweep, sdílené komponenty.
3. **Cluster B – 9 + 10(local) + 2.** Lift tab state, copy local path, external-
   change poll. Frontend (+ drobný backend pro 10 local není potřeba).
4. **Cluster C – 3.** Date grouping událostí. Frontend.
5. **Cluster B backend – 10 (Google Disk).** Per-file URL endpoint + wiring.
   Backend tmux loop.
6. **Tauri batch – 7 + 6b.** Drag-drop z Finderu + foreground-process signál.
   Jeden `cargo tauri dev`/build cyklus na konec, ať pomalý loop nebrzdí zbytek.

Kroky 1–4 jsou rychlý loop a dají se prokládat. Krok 6 je jediný, který nutí
Tauri rebuild.

## Testing

- **Backend (node --test, `test/*.test.ts`):**
  - Cluster D: `buildSoftHint` s/bez data_sources – snapshot, že hint obsahuje
    názvy zdrojů a save-location větu; `materializeScopeConfig` zapíše
    obohacený `PORTUNI_SCOPE.md` a idempotentní marker blok (re-run nezdvojí).
  - Úkol 10: nový `GET /nodes/:id/file-url` – vrací Drive URL pro tracked
    soubor, 404/null pro nesynced, path-safety (`?path=../`). Vzor existujících
    sync testů (`:memory:` + fs remote).
- **Frontend (smoke přes Vite `portuni.test`, ruční):**
  - 1: víc sessions, jasně vidět aktivní. 6a: bare-shell session nesvítí
    zeleně, agent session ano. 8: diff v light i dark mode čitelný. 9: otevřít
    soubor z karty Soubory → zavřít → zůstat na Soubory. 10: copy local path +
    copy Drive link do schránky. 2: upravit soubor zvenčí (agent v terminálu) →
    do ~5 s banner "změněno na disku" + reload. 3: události seskupené pod daty.
- **Tauri (po buildu):** 7: drag soubor z Finderu → cesta se vloží do aktivní
  session. 6b: indikátor zelený jen když agent reálně počítá.

## Rizika a poznámky

- **Cluster D plumbing:** `materializeScopeConfig`/`buildSoftHint` nemají DB
  handle. Protažení fetch `data_sources` je hlavní strukturální dotyk dávky –
  držet ho čistý (jeden fetch, předaný dolů), ať `buildSoftHint` zůstane
  testovatelná pure funkce nad daty.
- **Hint bloat:** instrukce mají budget (`server.ts:31` zmiňuje ~2KB
  truncatable). Zdroje vypisovat stručně (název + URL), ne celé objekty.
- **Úkol 6a není dokonalý:** rozliší agenta od shellu, ne "počítá vs. čeká".
  Plnou poctivost dodá 6b. Vědomý interim.
- **Úkol 2 poll cost:** +1 lehký fetch/5s na otevřený soubor; pro single-user
  desktop OK, konzistentní s existujícím detail pollem.
- **Přegenerování mirrorů (D):** po změně hintu se nové instrukce projeví až po
  restartu sidecaru (boot `materializeAllRegisteredMirrors`). Zmínit v release
  poznámce, ať je jasné, proč staré session ještě vidí starý hint.
