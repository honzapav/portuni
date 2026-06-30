# HTML viewer – design

> Status: design spec, ready for implementation plan. Authored 2026-06-30.
> Zachycuje brainstorm, aby čerstvý executor mohl pokračovat bez
> re-derivace konverzace. Asana: "HTML viewer" (Portuni #todo / Dev).

## Cíl (goal)

Renderovaný náhled `.html`/`.htm` souborů přímo v editor panelu workspace,
analogicky k tomu, jak `.md` dostává `MarkdownPreview`. Primární use-case:
prohlížení HTML, které vygeneruje Claude (typicky single-file s inline JS a
CDN knihovnami). Žádné velké aplikace, ale náhled musí být **plnohodnotný** –
JS i externí zdroje musí fungovat, jinak je viewer pro tuhle kategorii
k ničemu.

HTML soubory už dnes jdou otevřít a editovat (jako text v CodeMirror), protože
`text/html` projde `text/*` editable testem. Chybí jen **renderovaný náhled** –
"Náhled" dnes pro `.html` zobrazí HTML zdroj vyrenderovaný jako markdown.

## Non-goals

- Žádná editace přes HTML (žádný WYSIWYG). Edit režim zůstává zdrojový
  CodeMirror nad raw HTML – beze změny.
- Žádné uvolnění hlavního app CSP. Izolace renderu je **přes origin/proces +
  odepřenou capability**, ne přes oslabení CSP.
- Žádný backend obsahový endpoint navíc pro náhled. Desktop protokol čte
  soubor z mirroru přímo v Rustu; web používá `srcDoc` z už načteného obsahu.
- Žádná podpora multi-file HTML s relativními asset odkazy v rámci náhledu
  (v1 cílí na single-file HTML). Lze dořešit později.
- "Open in browser" je nice-to-have, **ne blocker** (viz níže).

## Bezpečnostní rámec (klíčové rozhodnutí)

HTML od Claude je quasi-nedůvěryhodný kód. Hlavní rizika: (1) přečtení/
zneužití auth tokenu, (2) volání naší authentikované API, (3) exfiltrace dat.

Rozhodnutí (potvrzeno uživatelem):

- **Tier: skripty + externí zdroje povoleny.** Exfiltrace ven je přijatý
  tradeoff (jde o vlastní Claude output). Token ale musí zůstat nedosažitelný.
- **Izolace, ne crippling.** Render běží v kontextu s vlastním (volným/žádným)
  CSP, ale fyzicky oddělený od hlavní app:
  - `sandbox="allow-scripts"` **bez `allow-same-origin`** → opaque origin,
    žádný přístup k DOM/cookies/localStorage rodiče.
  - Render kontext **nedostane** Tauri capability `api_request`/`central_request`
    → nemůže zavolat Rust pro token ani naši API.
  - Token žije jen v Rust/Keychain, nikdy v žádném webview JS (security pravidla
    projektu) → v dosahu náhledu není co ukrást.
- **Hlavní app CSP zůstává striktní** (`tauri.conf.json:26`,
  `default-src 'self'; script-src 'self'; ...`). Beze změny.

Trust boundary je tím stejná jako "otevřít v externím prohlížeči" – render smí
cokoliv *sám se sebou*, ale je odříznutý od Portuni tokenu a dat.

## Klíčová zjištění o současném stavu (grounding)

| Fakt | Důkaz |
|---|---|
| Preview režim v editor panelu vždy renderuje `MarkdownPreview` – žádný dispatch podle typu souboru. | `apps/web/src/components/EditorPane.tsx:122-126` |
| `EditorBody` dostává jen `ed` (FileEditor), `mode`, `onModeChange`, `capWidth` – **ne** relPath/příponu. `EditorPane` zná `relPath`; fullscreen mountuje samostatnou `EditorBody`. | `EditorPane.tsx:69-83`, `EditorPane.tsx:26` |
| `text/html` projde editable testem (`mime.startsWith("text/")`) na FE i BE → `.html` se dnes normálně otevře a uloží jako text. Agentův dřívější předpoklad "415" byl chybný. | `apps/server/domain/sync/file-content.ts:42-47`, `apps/web/src/components/DetailPane.files.tsx:56-61` |
| `mimeFor()` mapuje `.html → text/html`. `FileContentResponse` vrací `{ content, version, filename, mime_type }`. | `apps/server/domain/sync/engine.ts:45-48`, `apps/server/shared/api-types.ts:95-100` |
| Desktop CSP je striktní; `srcdoc`/`blob:` dokumenty **dědí** rodičovský CSP → inline i externí skripty by byly blokované `script-src 'self'` bez ohledu na `sandbox`. Proto je nutný iframe s reálnou URL, která má vlastní CSP. | `apps/desktop/tauri.conf.json:25-27` |
| Žádné iframe v appce dnes nejsou. Bezpečnostní hlavičky: `X-Frame-Options: DENY` (týká se jen framování *našich* stránek, ne `srcdoc`). Žádná CSP hlavička na HTTP straně. | `apps/server/http/middleware.ts:308-318` |
| Detekce prostředí: `isTauri()` přes `window.__TAURI_INTERNALS__`. Webview ↔ backend přes Tauri command `api_request` (Bearer injektuje Rust). | `apps/web/src/lib/backend-url.ts`, dřívější spec `2026-06-07-markdown-editor-design.md:49` |
| Shell plugin `open` allowlist = `"(https?|mailto):.+"` → **nepovoluje `file:`**, takže přímé otevření lokálního souboru shellem dnes neprojde. | `apps/desktop/tauri.conf.json:30-33` |

## Architektura – rozhodnutí

1. **Render = sandboxed iframe, dvě source strategie podle prostředí**
   (jedna komponenta `HtmlPreview.tsx`):
   - **Desktop (Tauri):** `<iframe sandbox="allow-scripts" src="<protokol>/<mirror-path>">`.
     Soubor servíruje **custom URI-scheme protokol** (`portuni-html://…`, na
     Windows `http://portuni-html.localhost/…`) – handler v Rustu čte z mirroru
     přímo z disku (žádný bearer token netřeba – obchází tokenless-iframe
     problém) a vrací `Response` s hlavičkami pod plnou kontrolou, tedy s
     **vlastním volným/žádným CSP**. Tauri do custom-scheme odpovědí
     **neinjektuje** app CSP (na rozdíl od asset protokolu). Iframe běží na
     odděleném originu protokolu, takže nedědí striktní app CSP → JS i externí
     zdroje fungují. Bez `allow-same-origin` → nedosáhne na hlavní app.
   - **Web (Vite dev):** `<iframe sandbox="allow-scripts" srcDoc={content}>`.
     Žádný app CSP v dev buildu → skripty i externí zdroje fungují rovnou,
     protokol netřeba.
2. **Dispatch v `EditorBody`** podle přípony otevřeného souboru:
   `.html`/`.htm` v preview režimu → `HtmlPreview`, jinak `MarkdownPreview`.
   Do `EditorBody` se prosadí přípona/relPath (a do fullscreen mountu taky).
3. **`.html` se otevírá ve výchozím preview režimu** (tam, kde `App.tsx`
   inicializuje editor mode). Ostatní typy beze změny.
4. **Edit režim beze změny** – raw HTML dál editovatelný v CodeMirror.
   (Volitelný polish: HTML syntax mode v CodeMirror místo markdown highlightu –
   nice-to-have, ne nutné.)
5. **Path akce:** tlačítko "Kopírovat cestu" na HTML náhledu (vždy).
   "Otevřít v prohlížeči" jen pokud to plán shledá levným (shell allowlist dnes
   blokuje `file:`) – **ne blocker**.

### Desktop serving = custom URI-scheme protokol (rozhodnuto)

Zvolen **custom protokol** (Option A), ne asset protokol. Důvody: per-response
kontrola CSP (volný CSP jen pro náhled, nic jiného se nesahá), vlastní path
scoping v handleru, žádný globální `dangerousDisableAssetCspModification`
(který by vypnul CSP injekci pro *všechny* asset odpovědi app-wide). Cena: víc
Rust kódu, compile-time registrace schématu.

**Sdílený požadavek (CSP framing):** hlavní app CSP nemá `frame-src`, takže
padá na `default-src 'self'` → framování protokol originu by bylo blokované.
Přidá se **jediná cílená direktiva** `frame-src 'self' <preview-origin>` do
`tauri.conf.json:26`. To povoluje jen *framování* izolovaného originu,
**nemění `script-src`** hlavní app → bezpečnostní posture drží. Web/Vite build
nepotřebuje nic (žádný CSP, `srcDoc` frame projde).

### Otevřené pro implementační plán (ne teď)

- Jak `HtmlPreview` na desktopu získá mirror cestu souboru (z node detailu /
  `local_path`) pro sestavení protokol URL.
- Async handler (`register_asynchronous_uri_scheme_protocol`) + path-traversal
  guard v Rustu (reuse logiky `safeMirrorJoin` – request musí resolvovat uvnitř
  mirror rootu, jinak chyba).
- Cross-platform tvar URL (`portuni-html://…` macOS/Linux vs
  `http://portuni-html.localhost/…` Windows). Cíl je macOS `.app`.
- Přesné `sandbox` flagy (zvážit `allow-popups` pro `target=_blank` odkazy;
  default držet minimální = jen `allow-scripts`).

## Komponenty (jednotky)

- **`HtmlPreview.tsx`** (nová) – co dělá: vyrenderuje obsah HTML v sandboxovaném
  iframe; jak: `isTauri()` → `src` přes protokol, jinak `srcDoc`; závisí na:
  obsahu/cestě z `FileEditor`, `isTauri()`.
- **Rust protokol handler** (desktop, nový) – co dělá: na request náhledu přečte
  mirror soubor z disku a vrátí HTML s volným CSP; jak: registrace protokolu v
  `apps/desktop` lib; závisí na: mirror root scope. **Bez** přístupu k tokenu.
- **`EditorBody` / `EditorPane`** (úprava) – dispatch preview podle přípony;
  prosazení přípony do těla a fullscreen mountu; "Kopírovat cestu" tlačítko.
- **`App.tsx`** (úprava) – výchozí mode `preview` pro `.html` při otevření.

## Data flow

1. Klik na `.html` v file tree → `openFileInEditor(nodeId, relPath)` (stávající).
2. `App.tsx` nastaví editorFile + výchozí mode `preview` (nově pro `.html`).
3. `EditorBody` v preview režimu detekuje příponu → mountne `HtmlPreview`.
4. Desktop: `HtmlPreview` sestaví protokol URL z mirror cesty → iframe `src`;
   Rust handler vrátí soubor s vlastním CSP. Web: iframe `srcDoc={ed.content}`.
5. Edit ↔ Náhled přepínač funguje dál; edit režim = CodeMirror nad zdrojem.

## Error handling

- Soubor mimo mirror scope / neexistuje → protokol handler vrátí chybu; iframe
  zobrazí prázdno – `HtmlPreview` ukáže fallback hlášku (analogicky k
  `EditorBody` error stavu).
- Web bez obsahu (loading/error) → řeší stávající `EditorBody` stavy před
  mountem náhledu.

## Testing

- **Unit (FE):** detekce přípony (`.html`/`.htm` vs `.md` vs ostatní); dispatch
  vybere `HtmlPreview` pro HTML a `MarkdownPreview` jinak; `HtmlPreview` renderuje
  iframe se správnými atributy (`sandbox="allow-scripts"` **bez**
  `allow-same-origin`; `src` na desktopu vs `srcDoc` ve webu).
- **Manuál (desktop):** Claude-style HTML s CDN skriptem (např. Chart.js/Tailwind
  CDN) se vyrenderuje interaktivně v panelu; v dev-tools ověřit, že náhled
  nedosáhne na token/API (opaque origin, žádná capability).
- **Manuál (web):** stejný soubor renderuje JS v sandboxu.
- **Regrese:** `.md` náhled i edit/save beze změny; edit/save `.html` beze změny.
