# Markdown editor + deterministic file registration – design

> Status: design spec, ready for implementation plan. Authored 2026-06-07.
> Captures the brainstorm so a fresh executor can proceed without
> re-deriving the conversation. All file:line references reflect the repo at
> commit `3023e83`.

## Cíl (goal)

Umožnit čtení a editaci lokálních markdown souborů registrovaných k Portuni
uzlu přímo v aplikaci. Po kliknutí na `.md` soubor v detailu uzlu se otevře
editor v pravém panelu (místo detailu, s návratem zpět) a lze ho rozšířit na
celookenní distraction-free režim.

Zároveň opravit kořenovou příčinu toho, že "soubory zaregistrované přes MCP
nejsou vidět v UI": (a) frontend nikdy automaticky neobnovuje detail uzlu, a
(b) AI agent v terminálu často zapomene soubor zaregistrovat (`portuni_store`),
takže soubor zůstane neevidovaný a neviditelný. Registrace souborů se proto
přesouvá z "musí si vzpomenout AI" na **deterministický kód**.

## Non-goals

- Žádný WYSIWYG / rich-text editor. Editor je **zdrojový** (markdown source)
  se zvýrazněním syntaxe. Žádný live HTML preview (uživatel ho explicitně
  nechtěl v žádné z variant).
- Žádná editace ne-textových souborů (obrázky, PDF). Ty zůstávají v stromu
  needitovatelné.
- Žádný real-time filesystem watcher pro auto-registraci (zváženo, zamítnuto
  jako příliš mnoho pohyblivých částí). Auto-registrace běží na deterministické
  triggery: editor "Nový soubor" a sync běh.
- Tauri `fs` plugin se **nepřidává**. Veškeré file I/O jde přes Node backend
  (stejně jako všechno ostatní).

## Klíčová zjištění o současném stavu (grounding)

| Fakt | Důkaz |
|---|---|
| Workspace = 2 sloupce: terminál (vlevo) + `DetailPane` embedded (vpravo). Globální `Sidebar` vlevo. | `app/src/components/WorkspaceView.tsx:79-108`, `app/src/App.tsx:415-544` |
| `DetailPane` má 4 taby; Files tab renderuje `FileTree`. Řádky souborů **nemají** click handler. | `DetailPane.tsx:768-792`, `DetailPane.files.tsx:209-236` |
| `view` stav (`graph`/`workspace`/`settings`) žije v `App.tsx`; workspace má vlastní `selectedWorkspaceNodeId` oddělený od graph `selectedId`. | `App.tsx:40-46, 237` |
| Tabulka `files` ukládá **jen metadata**, žádné bajty. `local_path` je odvozený za běhu (mirrorRoot + nodeRoot + remote_path). Bajty žijí v lokálním mirroru na disku + na remote (Drive/fs/OpenDAL). | `src/infra/schema-triggers.ts:95-111`, `src/domain/queries/node-detail.ts:74-107` |
| `storeFile()` = čte lokální soubor → `adapter.put()` na remote → UPDATE `files` (registrace + push v jednom). Vyžaduje existující mirror. | `src/domain/sync/engine.ts:66-236` |
| `moveFile()` přesouvá sekci/subpath/uzel, ale **zachovává jméno souboru** – přejmenování (změna filename) chybí. `deleteFile()` je dvoufázové (preview → confirmed). `createMirrorForNode()` je idempotentní. | `engine-mutations.ts:79,602`, `mirror-create.ts` |
| `statusScan()` už prochází filesystem (`walkMirror` nad `wip`/`outputs`/`resources`) a vrací `new_local` neevidované soubory `{node_id, local_path, section, subpath, filename, hash}`. | `engine.ts:587-812` |
| `handleSyncStatus` volá `statusScan({ includeDiscovery:false, fast:true })` → discovery (new_local) je pro UI **vypnuté**. Vrací `SyncStatusResponse = { files: SyncStatusFile[] }`. | `src/api/nodes.ts` handleSyncStatus, `src/shared/api-types.ts:106-107` |
| `handleSyncRun` běží `includeDiscovery:false` a `storeFile`-uje jen tracked `push_candidates`; **neadoptuje** nové lokální soubory. | `src/api/nodes.ts` handleSyncRun |
| Frontend nemá žádný polling/SSE/websocket. Detail se načte při výběru uzlu, při mutaci (`onMutate`), nebo při `window focus` (`refetchAll`). Focus refetch ale obnovuje jen **graph** `selectedId`, ne workspace uzel. | `App.tsx:135-176` |
| DB klient (`getDb`) je čistý `createClient({ url, authToken })` – **žádný `syncUrl`**. MCP zápis i UI čtení jdou přes stejný backend → stejná DB. "Není vidět" je tedy refresh problém, ne dvě databáze. | `src/infra/db.ts:5-16` |
| Žádná markdown/editor knihovna není nainstalovaná. Veškeré editace = `<textarea>`. I/O přes `apiFetch` → Tauri `api_request` (Bearer token). `isTauri()` přes `window.__TAURI_INTERNALS__`. | `app/package.json`, `app/src/lib/backend-url.ts:27-131`, `src-tauri/src/lib.rs:409-458` |
| REST router: pattern-match v `src/api/router.ts`; compound `/nodes/:id/...` cesty se matchují **před** holým `/nodes/:id`. Handlery používají `getDb()` + `SOLO_USER` + `parseBody`/`respondJson`. | `src/api/router.ts:260-317`, `src/api/nodes.ts:27-46` |

## Architektura – rozhodnutí

1. **File I/O přes nové Node backend REST endpointy** (přes existující
   `apiFetch`), ne přes Tauri fs plugin. Funguje stejně v desktopu i v
   browser-dev, využívá sync engine + audit, žádný fs plugin dnes není.
2. **Editor: CodeMirror 6** (`@uiw/react-codemirror` + `@codemirror/lang-markdown`
   + téma). Vhodný pro distraction-free zdrojový editor; kompatibilní s React 19.
3. **Strom souborů = pravda na disku** (registered + untracked), ne jen řádky
   `files`. Registrace je **status (badge)**, ne podmínka viditelnosti.
4. **Content I/O je path-based** (relativní k mirroru), aby jednotně fungovalo
   pro tracked i untracked soubory (untracked nemají `file_id`).
5. **Registrace je deterministická** – nikdy nezávisí na AI:
   - Editor "Nový soubor" registruje hned (`storeFile`).
   - Sync běh auto-adoptuje nové lokální soubory (`storeFile`).
   - **Save je vždy local-only** (žádný push) – předvídatelné, žádné
     překvapivé uploady. Untracked soubor zůstává untracked dokud ho
     nezaregistruje create nebo nejbližší sync.

## Layout & UX (vybráno přes mockupy)

```
WORKSPACE (Option C – editor nahrazuje detail):
┌───────────┬───────────────────────┬──────────────────────┐
│ Sidebar   │ Terminal              │ Detail  ──klik .md──▶ │
│ (uzly)    │ $ claude              │  NEBO                 │
│           │                       │ ┌ ← zpět na detail ⤢┐ │
│           │                       │ │ Editor (source)  │ │
│           │                       │ │ # plan.md        │ │
│           │                       │ └──────────────────┘ │
└───────────┴───────────────────────┴──────────────────────┘

FULL APP (Option A – distraction-free), overlay přes celé okno:
┌──────────────────────────────────────────────────────────┐
│ ←  plan.md                              ● Uložit    ⤢ exit │
├──────────────────────────────────────────────────────────┤
│ # Heading                                                  │
│ - body text …                                              │
└──────────────────────────────────────────────────────────┘
```

- Pane mode: kliknutí na `.md`/textový soubor přepne pravý panel z detailu na
  kompaktní editor s drobečkem "← zpět na detail" a tlačítkem ⤢ rozšířit.
- Full app: ⤢ otevře celookenní editor (skryje sidebar + terminál); horní lišta
  jméno · Uložit · zavřít. Stejné jádro editoru, jiný chrome.

## Komponenty

### Backend

Nový soubor `src/api/files.ts` + nová routovací skupina `routeFiles` v
`src/api/router.ts`, zařazená **před** `routeNodes` (aby `/nodes/:id/file…`
nepohltil holý `/nodes/:id`). Všechny handlery: `getDb()` + `SOLO_USER` +
`parseBody`/`respondJson`/`respondError`, idempotentní `createMirrorForNode`
před čtením/zápisem.

| Metoda | Cesta | Chování |
|---|---|---|
| `GET` | `/nodes/:nodeId/file?path=<rel>` | Ensure mirror, přečti soubor z mirroru (fallback `adapter.get` pokud lokálně chybí). Vrať `{content, version, filename, mime_type}`. `version` = sha256 obsahu. Odmítni binární (mime ne-text) → 415 s `{editable:false}`. Funguje pro tracked i untracked. |
| `PUT` | `/nodes/:nodeId/file?path=<rel>` | Body `{content, baseVersion, force?}`. Spočítej aktuální hash na disku; pokud `!= baseVersion` a `!force` → **409** `{currentVersion}` (warn-on-external-change). Jinak zapiš soubor. **Žádný push** (save-local-only). Vrať `{version}`. |
| `POST` | `/nodes/:nodeId/files` | Create: `{filename, section?, subpath?, content?}`. Zapiš do mirroru + `storeFile` (registrace + push). Vrať `DetailFile`. |
| `POST` | `/nodes/:nodeId/files/:fileId/rename` | `{newFilename}`. Tracked: rozšířit `moveFile`/přidat `renameFile` o `newFilename` (přesun remote objektu + lokálního souboru + UPDATE řádku). |
| `DELETE` | `/nodes/:nodeId/files/:fileId` | Tracked: `deleteFile` dvoufázově (preview → `?confirmed=true`). |

Pro v1 jsou rename/delete **jen na tracked souborech** (mají `file_id` →
registry-aware přes `renameFile`/`deleteFile`). Untracked soubor (badge
"neregistrováno") se nejdřív zaregistruje (nejbližší sync nebo uložení jako
nový soubor), teprve pak lze přejmenovat/smazat. Tím se vyhneme
poloviční path-based mutate cestě, která by mohla nechat orphan řádek.

### Sync engine změny (`src/domain/sync/engine.ts`, `engine-mutations.ts`)

1. **Local-only, name-only discovery mód** v `statusScan` (nebo nová odlehčená
   funkce): projdi `wip`/`outputs`/`resources`, vrať soubory na disku, které
   nejsou v `files`, **bez sha256** (hash se počítá až při adopci). Slouží
   levnému pollování UI.
2. **`renameFile`** (nebo `moveFile` + `newFilename` v `MoveFileArgs`): přesune
   remote objekt (`adapter.rename`/copy+delete) + lokální soubor + UPDATE
   `files.filename`/`remote_path`.

### REST handler změny (`src/api/nodes.ts`)

1. **`handleSyncStatus`**: zapnout local-only discovery; přidat do odpovědi
   `untracked` pole.
2. **`handleSyncRun`**: po pushnutí tracked změn spustit discovery a
   `storeFile` každý `new_local` (auto-adopt). Přidat `adopted: SyncRunFile[]`
   do `SyncRunResponse`.

### Sdílené typy (`src/shared/api-types.ts`)

```ts
export type UntrackedFile = {
  relative_path: string;   // "wip/docs/x.md" – stejný tvar jako DetailFile.relative_path
  section: string;         // wip | outputs | resources
  subpath: string | null;
  filename: string;
  local_path: string;
  mime_type: string | null;
};
export type SyncStatusResponse = {
  files: SyncStatusFile[];
  untracked: UntrackedFile[];   // NOVÉ
};
// SyncRunResponse: + adopted: SyncRunFile[]
// FileContentResponse = { content: string; version: string; filename: string; mime_type: string | null }
```

### Frontend

- **`app/src/api.ts`**: `fetchFileContent(nodeId, relPath)`, `saveFileContent(nodeId, relPath, {content, baseVersion, force?})` (rozlišuje 409), `createFile(...)`, `renameFile(...)`, `deleteFile(...)`.
- **`DetailPane.files.tsx`**: `FileTree`/`FileTreeNode` dostanou `onOpenFile(relPath)` a renderování untracked řádků (badge "neregistrováno"). Per-row hover akce (přejmenovat, smazat) a tlačítko "+ Nový soubor". Strom se staví z merge `node.files` + `syncStatus.untracked`.
- **`MarkdownEditor`** (nové): jádro nad CodeMirror 6. Props `{nodeId, relPath, onClose, onExpand?, onSaved}`. Stav: načítání (GET), dirty indikátor, ⌘S = save (PUT, local-only), konflikt dialog (409 → "ponechat moje" = resend `force:true` / "načíst jejich" = re-GET).
- **`EditorPane`** (kompaktní, v pravém sloupci) a **`EditorFullscreen`** (overlay) – tenké shelly nad `MarkdownEditor`.
- **`WorkspaceView.tsx`**: pravý panel renderuje `EditorPane` když `openFile && !fullscreen`, jinak `DetailPane`. Drobeček "← zpět na detail".
- **`App.tsx`**: editor stav `{ openFile: {nodeId, relPath} | null, fullscreen: boolean }`. Top-level overlay renderuje `EditorFullscreen` když `fullscreen`. Threading `onOpenFile` dolů.

### Live refresh (oprava "MCP soubor není vidět")

V `App.tsx`:
- Rozšířit focus handler + přidat `visibilitychange` tak, aby refetchoval i
  **workspace** detail (dnes jen graph `selectedId`).
- Přidat **interval poll ~5 s** aktivního uzlu (detail **+** sync-status),
  pozastavený když `document.hidden`. Platí pro graph i workspace výběr.
- Tím se zobrazí jak MCP-registrované soubory (detail), tak agentem zapsané
  untracked soubory (sync-status discovery) do pár sekund.

## Datový tok

**Otevření a editace:**
1. Klik na řádek souboru → `onOpenFile(relPath)` → `App` nastaví `openFile`.
2. `EditorPane` zavolá `GET /nodes/:id/file?path=` → obsah + `version`.
3. Editace v CodeMirror; ⌘S → `PUT …` s `baseVersion = version`.
4. 409? → dialog ponechat/načíst. Jinak nový `version`, dirty se vyčistí.
5. Soubor se na disku změnil → `statusScan` ho klasifikuje jako `push` →
   badge svítí → uživatel klikne "Synchronizovat" (push na remote).

**Deterministická registrace agentova souboru:**
1. Agent v terminálu zapíše `wip/notes.md`, nezavolá `portuni_store`.
2. Poll (~5 s) přinese `sync-status.untracked` → soubor se objeví ve stromu s
   badge "neregistrováno".
3. Uživatel klikne "Synchronizovat" → `handleSyncRun` discovery → `storeFile`
   → soubor je registrovaný + pushnutý (`adopted`). Badge zmizí.

## Ošetření chyb

- **409 konflikt** při save: strukturovaná odpověď `{currentVersion}`; UI nikdy
  tiše nepřepíše. Volby: ponechat moje (`force:true`) / načíst jejich (re-GET).
- **Binární / ne-text** soubor: GET vrací 415 `{editable:false}`; UI ukáže
  "tento soubor nelze editovat".
- **Uzel bez mirroru**: `createMirrorForNode` (idempotentní) před I/O; když
  selže (žádné remote routing), 409/400 s důvodem (vzor jako `MirrorCreateError`).
- **`storeFile` bez remote routing**: vrať jasnou chybu (uzel nemá remote).
- **Discovery selže** (chybí adapter): tiše přeskoč, neblokuj UI (vzor z
  `runDiscovery`).
- **Path traversal**: validovat `?path=` přes `safeMirrorJoin` / `subpathFromMirror`
  (už existují) – odmítnout cokoli mimo mirror.

## Testing

- Backend (node --test, `test/*.test.ts`): GET/PUT content (vč. 409 a force),
  create→registrace, rename (vč. nového filename), delete dvoufázově,
  sync-run auto-adopt new_local, sync-status untracked. Použít `setDbForTesting`
  + `:memory:` + `fs` remote (OpenDAL fs) jako v existujících sync testech.
- Path-safety test: `?path=../../escape` → odmítnuto.
- Frontend: smoke přes existující vzor (žádný heavy e2e); ručně přes Vite
  (`portuni.test`) – klik na soubor, edit, save, konflikt, full-screen, nový
  soubor, untracked badge → sync → registrace.

## Fáze (doporučené pořadí pro plán)

1. **Backend čtení/zápis**: typy, `routeFiles`, GET/PUT content (path-based,
   409, binary guard, path-safety) + `api.ts` klienti. Testy.
2. **Disk-truth strom + live refresh**: local-only discovery, `untracked` v
   sync-status, merge ve `FileTree` + badge, polling/visibility v `App.tsx`.
   (Samo o sobě opraví "MCP soubor není vidět".)
3. **Editor UI**: CodeMirror dep, `MarkdownEditor` + `EditorPane` +
   `EditorFullscreen`, wiring v `WorkspaceView`/`App`, `onOpenFile`.
4. **CRUD + auto-adopt**: create (registruje), rename (`renameFile`), delete
   (dvoufázově), auto-adopt v `handleSyncRun` (`adopted`).

## Otevřená rizika

- **Náklady pollování**: detail + sync-status každých ~5 s; pro single-user
  desktop OK. Discovery je name-only (bez hash) → levné. Interval laditelný;
  případně později lehký files-only endpoint.
- **Save-local-only vs untracked**: untracked soubor editovaný v editoru
  zůstane untracked dokud ho nezaregistruje sync (ne save). Vědomé rozhodnutí
  kvůli předvídatelnosti; badge + poll to dělá viditelným.
- **Rename remote**: ne všechny adaptéry mají levný rename; fallback copy+delete
  (Drive už `rename` má, OpenDAL také – ověřit `adapter.rename`).
