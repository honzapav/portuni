# Portuni as Workspace — vision

> Status: vision document, not a plan. No implementation date. Captured for future reference so we don't have to re-derive the framing.

## Premise

Portuni v0 (file sync + graph + MCP) řeší backend problém: kde žije znalost, jak teče mezi lidmi, jak ji čtou agenti. Funguje, ale uživatel s ním komunikuje přes terminál, Drive UI a Claude Code MCP volání. Tři konteksty, žádný cítí jako "Portuni".

Portuni jako workspace je posun: **jedna aplikace, ve které člověk dělá svou znalostní práci**. Graf je shell. Files, agent, editor, sync stav — všechno orbituje kolem aktuálního node.

## Identita

> "Portuni je operační systém pro znalostní práci, agent-native."

Klíčová slova:
- **Operační systém** — ne aplikace, ne tool. Vrstva, ve které se odehrávají všechny ostatní akce. Terminál, editor, browser tabů, file picker, agent chat.
- **Znalostní práce** — psaní, výzkum, návrhy, syntéza. Ne tasky (od toho je Asana / Linear). Ne tabulky (od toho je Sheets / Airtable). Práce s textem a kontextem.
- **Agent-native** — Claude Code (a jeho budoucí ekvivalenty) nejsou feature. Jsou primary input. Otevřu terminál v Portuni, agent už ví, kde jsem, který node, který soubor, co se rozdělaného povaluje.

## Konkurence

**Skutečně konkuruje:**
- **Obsidian** — markdown knowledge base s grafem, lokální soubory, plugins
- **Solo (Aaron Francis)** — writing-first app, čistý markdown editor s preview
- **iA Writer** — markdown editor s typewriter / focus modes
- **Logseq, Roam, Tana** — graph-first knowledge
- **Cursor, VS Code + chat** — agent-native editing (ale code-first, ne knowledge-first)

**Nekonkuruje (a nesnažíme se):**
- **Asana, Linear, Jira** — task management. Portuni linkuje, ne nahrazuje.
- **Notion** — všeobjímající workspace s databázemi. Příliš generické, my máme úzký focus.
- **Google Docs, Office** — rich-format collaborative editing. My se držíme markdown + linkujeme native dokumenty.
- **Slack, Discord** — chat / messaging. Komunikace mezi lidmi není naše.

Pozice: **Obsidian, ale s agentem jako primárním kanálem a synchronizací jako first-class invariant.**

## Pozice vůči auto mode

> Doplněno 2026-04-25. Předtím v žádném dokumentu nebylo explicitně.

Auto mode v Claude Code (a jeho ekvivalenty) **není konkurence Portuni – je to jiná persona**. Soutěží o jiné lidi a jiné situace.

**Auto mode** = "agent procházej všechno, najdi si co potřebuješ, jdi rychle." Vhodné pro lidi, kteří:
- Nezáleží jim, co všechno agent v procesu uvidí
- Akceptují **context poisoning** (nesouvisející informace v jednom místě otráví výstupy) jako vedlejší efekt
- Nepotřebují vědět, co agent četl

**Portuni** = "agent uvidí přesně to, co jsem mu povolil; každé rozšíření je explicitní; existuje záznam." Vhodné pro lidi, kteří:
- Pracují s informacemi, jejichž **leak** do nesouvisejícího kontextu je problém (klientské materiály, citlivé poznámky, cross-org work)
- Chtějí **precízní výstupy** bez šumu z nesouvisejícího kontextu
- Potřebují **audit trail** – co agent v dané session četl (compliance, postmortem, tracking proč model rozhodl jak rozhodl)

**Klíčový bod:** Portuni nesoutěží o rychlost ani objem dat. Soutěží o **správnost a kontrolu**. Pro koho to je důležité, ten Portuni dává smysl. Pro koho ne, auto mode je dostačující – a bude dostačující i tehdy, až bude auto mode commodifikovaný a všudypřítomný (= moat Portuni **není** v tom, že auto mode je dnes Max-only; je v tom, že auto mode tyhle problémy strukturálně neřeší).

**Důsledky:**

1. **Komunikace** musí tuhle hranici držet. Portuni není "lepší auto mode", je to **control plane pro agentní práci se znalostmi**. README, talky, zmínky se tomuto pozicování musí přizpůsobit.
2. **Scope model** (implementace v `src/mcp/scope.ts` + `src/mcp/tools/scope.ts`: `portuni_expand_scope`, `portuni_session_log`, `PORTUNI_SCOPE_MODE`) je technické vyjádření této pozice. Read scope set + filesystem write tier 1/2/3 + audit jsou mechanismy, jak control plane funguje. Bez nich Portuni "ten control" jen tvrdí, ale nemá ho čím doložit.

## Core UX moves

### 1. Graf jako shell

Levý panel = kompresovaný graf (org → projects/processes → nodes). Klik = node se stane "active". Active node určuje:
- pravý panel: detail node (files, edges, owner, responsibilities, events, lifecycle, summary)
- terminal cwd
- agent context
- editor scope (jaký mirror se procháží)

Žádný globální "soubory na disku" view. Vše je nodescoped.

### 2. Agent terminál (killer feature)

V Portuni je tab "Terminal". Otevře shell s:
- `cwd` = mirror aktivního node
- `PORTUNI_ACTIVE_NODE` env var nastavený
- Claude Code už spuštěný a předem zkonfigurovaný k Portuni MCP serveru
- Agent v session prologue ví: "user works in node X, of org Y, files [...]"

> "Otevřu Claude Code v Portuni a všechno je jednodušší." — to je celá teze.

Konkrétně: agent nemusí pokaždé volat `portuni_get_node` na začátku. Nemusí se ptát "ve kterém adresáři jsi?". Ví to.

### 3. Markdown editor s preview

Side-by-side jako Obsidian / iA Writer:
- left: source markdown (CodeMirror nebo similar)
- right: rendered preview (live, syncscroll)
- top bar: file name, sync indicator, last save time
- save = auto `portuni_store` (na configured frequency, ne každý keystroke)

Linkování `[[Node Name]]` resolvuje proti grafu, autocomplete z grafu.

Out-of-scope pro v1: tabulky, embed chart, code blocks s execution. Čistý markdown.

### 4. Sync indikátor per-file

Vedle každého souboru v node detail panelu:
- ✓ clean
- ⬆ push (lokál nový)
- ⬇ pull (Drive nový)
- ⚠ conflict (oba se rozešli)
- ◯ orphan (DB row bez remote)
- 🔗 native (Google Doc / link, není sync)

Hover = detail (timestamps, hashes, who pushed). Klik = action menu (Push, Pull, Resolve, Snapshot).

### 5. Settings UI

Vše, co dnes vyžaduje varlock + gcloud + JSON klíče, je form:
- Add Drive remote: paste SA JSON, validate, "Test connection" button
- Routing rules: drag-drop priority list s vizuálním preview "tenhle node půjde na tenhle remote"
- Token store: dropdown (file / keychain / 1Password)
- Mirror locations: vidět všech 35 + možnost override per node

## Proč agent-native matters

Většina aplikací dnes přidává agenta jako "AI feature" — sidebar chat, autocomplete tlačítko. Portuni navrhuje opačné mapování: **agent je primary, UI je vizualizace toho, co agent + uživatel dělají společně**.

Důsledky:
- Každá akce v UI má MCP-tool ekvivalent. Klik = volání nástroje. Agent může všechno, co user může.
- Žádný state v UI bez state v MCP. Když agent něco změní, UI se aktualizuje (live).
- "Co bylo poslední velká věc, co jsem udělal?" — answerable both via UI scrolling AND `portuni_get_recent_audit { user, n: 10 }`.

## Otevřené otázky

1. **Editor implementace.** Tauri webview s CodeMirror? Native via SwiftUI / GTK? Jak markdown render? Jak performance při 1000+ souborech v node?
2. **Multi-window.** Jeden node per okno? Tabs? Split view (edit + preview + terminal v jednom)?
3. **Offline mode.** Když Drive není dostupný, UI by mělo fungovat. Sync indikátory zachycují stav.
4. **Search.** Cross-node fulltextový hledač přes všechny markdown soubory. Tantivy? Vector embeddings (semantic search)? Obojí?
5. **Tasks integrace.** "Tady linkujeme na Asana task" = je to MCP tool, nebo je to entity v Portuni? Pravděpodobně tool — Asana zůstává source of truth.
6. **Mobile.** Portuni iOS / iPadOS = read-only viewer + napsání rychlé poznámky? Plný editor? Long-term, nepotřebujeme řešit teď.

## Co je v core, co ne

> Doplněno 2026-04-25. Rozhodovací rámec pro otázku "patří X do Portuni?", aby se neřešilo ad-hoc per feature.

Portuni poskytuje **primitiva**. Aplikace nad nimi patří mimo core.

**V core:**
- Graf (POPP nodes, edges, lifecycle, events)
- File sync s remote drivery + mirrors
- Scope model + audit (impl: `src/mcp/scope.ts`, `src/mcp/tools/scope.ts`)
- MCP server s tools, REST endpoints (např. `/context`)
- Referenční React UI

**Mimo core (vítané jako patterns / examples / downstream projekty):**
- Chat boti (Google Chat, Signal, Slack adaptéry)
- Organizační templates (specifické šablony pro typ firmy / odvětví)
- Custom CLI nástroje napojené na Portuni MCP
- Integrace s konkrétními SaaS (Asana, Notion, Linear, atd. – linkujeme, neintegrujeme)
- Vendor-specific automatizace (Acme / Globex workflowy)

**Test, jestli něco patří do core:**

Pokud změna v API třetí strany (vendor SaaS, chat platform, LLM provider) by si vyžádala lock-step update v Portuni core, **dané X nepatří do core**. Core musí přežít vendor changes bez release.

**Konkrétní rozhodnutí (2026-04-25):**

- **Chat layer (Google Chat, Signal, atd.):** Globex-internal implementace, ne součást Portuni. Pokud později 3+ adopteři Portuni budou chtít podobný adaptér, povýšíme Globex implementaci na dokumentovaný pattern (`docs/patterns/chat-adapter.md`) nebo referenční ukázku v `/examples/`, **ne na core feature**.

**Důsledky principu:**

- **Open source dosah:** primitiva jsou stabilní, dlouhodobě udržovaná. Aplikace nad nimi se mohou množit bez tlaku na backward compatibility v core.
- **Pozicování:** Portuni se neprodává jako "all-in-one řešení s 100+ integracemi" (= OpenClaw model), ale jako "control plane + primitiva". Konkrétní integrace ukazujeme na příkladech, ne jako built-in features.
- **Co tato sekce není:** zákaz si pohrát s integrací nebo chat botem. Naopak – povzbuzení, aby se to dělalo, ale **mimo core repo**, s vlastním lifecycle a vlastní odpovědností. Pokud Globex postaví Google Chat bota, žije v Globex repo, ne v `portuni/`.

## Anti-patterns, kterým se vyhnout

- **Feature parity závody.** "Obsidian má dataview / canvas / kanban / ..." — všechno má jeden zápach: "ne, my to děláme jinak / nepotřebujeme."
- **Plugin systém.** Lákavé, ale fragmentuje produkt a generuje supply chain bezpečnostní dluh. Better: jasný integrační API přes MCP.
- **Realtime collaboration.** CRDTs, OT, Y.js. Jiný problém, jiný produkt. Portuni je single-author per file s lock-free Drive sync.
- **Roundtrip native formátů.** Editovat Google Doc v Portuni = open Drive UI. Snapshot je explicit operation. Native formats jsou linky, ne content.
- **Integration sprawl.** "100+ skills connected to apps" (à la OpenClaw). Každá integrace = maintenance burden + leak surface. Linkujeme, neintegrujeme. Adapters mimo core (viz sekce výš).
- **Feature counting jako marketing.** "X+ MCP tools and growing" je past – nutí počítat místo navrhovat. Portuni positioning = "úzký, hluboký, kontrolovaný", ne "wide and growing".
- **Multi-platform frontend sprawl.** Chat na Signal + Telegram + Discord + WhatsApp paralelně = 4× povrch pro bugy a abuse. Jeden kanonický frontend (React UI + MCP), ostatní jako tenké adaptéry mimo core.
- **Chat-as-primary-UI.** Konverzační prompt-response je strukturálně chudé pro graf, scope, audit, files. Chat je legitimní jako sekundární access mode, **nikdy** jako primární.

## Distribuční vrstva (Phase 1.5)

> Doplněno 2026-04-25. Reframe: desktop není workspace evoluce, je to **distribuční nutnost** – bez něj nelze Portuni dát do ruky nikomu, kdo není vývojář.

Před vším, co je v této vizi níž (workspace, agent terminál, editor), je jeden krok, který v původní formulaci chyběl: **zabalit současné Portuni jako desktop app, aby šlo distribuovat netechnickým uživatelům**.

Argument: dnes spustit Portuni znamená Node.js, `npm install`, tmux session, `varlock`, `gcloud auth`, `localias`, ručně editovaný `~/.claude/settings.json`. Pro vývojáře 30 vteřin. Pro Marii z marketingu nemožné. A dokud nemáme Marii, nikdy nezjistíme, jestli Portuni řeší skutečnou znalostní práci, nebo jen tu naši.

Druhý argument (od Honzy, 2026-04-25): "**Nedovedu si představit, že Portuni nebude desktop appka, když pracuje s lokálními soubory.**" Mirrors fyzicky existují na disku, ale dnes nejsou v Portuni "vidět" – uživatel vztah node↔soubor zažívá přes Finder a Drive UI, ne přes Portuni samotné. Desktop shell ten chybějící člen rovnice dosazuje.

Phase 1.5 distribuční shell obsahuje:

- **Tauri shell** (Rust + native webview, ~10 MB binary), embed současný React/Vite frontend (`app/`)
- **MCP server jako sidecar** – Node proces spuštěný appkou (Tauri sidecar API), žádný tmux, žádný ruční port management
- **Settings UI** místo CLI: form na Drive Service Account / OAuth popup, dropdown na token store, drag-drop routing rules, "Test connection" tlačítka
- **Lokální SQLite** v aplikační datové složce (`~/Library/Application Support/Portuni/...`), sync layer řeší cloud
- **Drive auth** přes OAuth popup, ne `gcloud auth application-default login`
- **Auto-update** přes GitHub releases / Tauri updater

Co Phase 1.5 **není**: terminál, markdown editor, agent integrace, "graf jako shell" UX. To je workspace evoluce (Phase 3–5). Phase 1.5 je čistě **transport**: dostat existující Portuni do rukou netech uživatelů beze změny kontraktu, který Portuni dnes uživateli dává.

**Multi-user / per-user auth v Phase 1.5 (vyřešeno 2026-05-05):** Každý
si nainstaluje Portuni se sdíleným Turso service tokenem (funguje pro
uzavřený okruh důvěryhodných lidí, např. Globex tým). Token je v OS
keychainu (macOS Keychain, Linux Secret Service, Windows Credential
Manager), nikdy ne v `config.json`. První spuštění ukáže modal,
který token přebere a uloží – další spuštění už je tichá.
Webview JS se k tokenu nedostane: HTTP volání mezi React frontendem
a Node sidecarem teče přes Tauri command (`api_request`), který
hlavičku `Authorization` injektuje až v Rust hostitelovi. Detaily v
`docs/auth-refactor-plan.md`. Pluggable identity adapters (Google
první) + per-user permissions zůstávají Phase 2 territory – referenční
model viz `docs/specs.md` → "Security model".

## Phasing intuice

Bez závaznosti:

**Phase 1 (hotovo)** – MCP server, file sync, graph backend, Drive integration, React/Vite frontend (`app/`). Spustitelné jen vývojářsky.

**Phase 1.5 – distribuční desktop shell.** Viz sekce výš. Cíl: `.dmg`/`.exe`, double-click, používá. Žádné nové funkce, jen balení existujícího.

**Phase 2** – větší MCP surface: search (semantic + fulltext nad markdown soubory v mirrors), snapshot, organization scaffolding (bootstrap nové org s default projekty/procesy/areas ze šablony), Notion adapter. Použitelné headless i přes desktop appku.

**Phase 3 – workspace shell rozšíření.** Nadstavba nad Phase 1.5 shellem: embedded terminál s `cwd` = mirror aktivního node, předem spuštěný Claude Code s Portuni MCP konfigurací, "Open Terminal" akce z node detail panelu. **Žádný markdown editor.** Editor zůstává externí.

**Phase 4 – markdown editor.** CodeMirror + preview side-by-side, auto-store on save, `[[Node Name]]` linkování s autocomplete z grafu. Tady se Portuni stává plnohodnotný workspace.

**Phase 5 – agent-native loop.** Tighter integration. Live updates v UI z agent akcí. Kontextové promptování. Macros / shortcuts.

**Each phase ships standalone value.** Phase 1.5 sám o sobě = "Portuni jde nainstalovat netech uživateli" – obrovský posun v dosahu i bez dalších featur. Phase 3 bez Phase 4 = pohodlnější Portuni s terminálem. Phase 4 bez Phase 5 = workspace bez kouzel. Phase 5 závisí na 4.

## Triggery pro start

### Phase 1.5 (distribuční shell)

Začít, když:
- ✓ Phase 1 sync má známé bugy / drift v produkci pod kontrolou (žádný major outstanding)
- ✓ Existuje aspoň jeden konkrétní netech kandidát na onboarding (druhá organizace, nebo netech člověk v Globex)
- ✓ Tým má kapacitu na 4–6 týdnů desktop balení (cca 0.5–1 FTE)

Trigger je primárně **produktově-distribuční, ne technický** – jakmile máme komu Portuni dát a sync drží, jdeme do toho.

### Phase 3+ (workspace evoluce: terminál, editor, agent loop)

Nezačít, dokud:
- ✗ Phase 1.5 desktop shell není v rukou aspoň 3–5 uživatelů a používá se denně
- ✗ MCP surface je tenká – chybí věci jako search, scaffolding, snapshot (= Phase 2)
- ✗ Globex team praktikuje znalostní práci přes Portuni denně, vidí konkrétní UX bolesti

Začít, když:
- ✓ Phase 1.5 je v produkci, lidi ji používají, máme reálný feedback
- ✓ Phase 2 MCP surface ships a stabilizuje se
- ✓ Tým má kapacitu na 3–6 měsíční workspace projekt (cca 1.5 FTE)

## Aktuální strategie (2026-04-25)

> Snapshot rozhodnutí v daném okamžiku. Aktualizovat při každém významném přerámování. Nepřepisuje phasing výš – říká, **co se dělá teď** a **co se odsouvá**.

### Co se odsouvá

- **Phase 1.5 desktop shell** – odsunut. Důvod: distribuční friction není ten skutečný bottleneck pro testování shared-context teze; ta teze nikdy nebyla pořádně postavena na test (jeden subject, sólo pracovník, žádný success kritérium předem). Stavět distribuci pro nedokázanou tezi = předčasné.
- **Globex team rollout** – odsunut. Důvod: dokud nemám ostrý a daty podložený value proposition, tahat lidi do něčeho, co sám neumím obhájit, není fér ani efektivní.

### Co se staví teď: Self-test "scope-model + dvě zařízení" (~3 týdny)

Logika: **Než stavím distribuci pro tezi, potřebuju mít ostrý value proposition s daty z vlastního použití.** Self-test je nejlevnější způsob, jak ho získat.

1. **Scope-model Phase A** (read scope core) – session scope set, `portuni_expand_scope`, `portuni_session_log`, `PORTUNI_SCOPE_MODE` env. Implementace v `src/mcp/scope.ts` + `src/mcp/tools/scope.ts`. **Hodnota teď:** ochrana před context poisoning a leakem ve vlastní práci. **Hodnota později:** ready pro multi-user.
2. **Scope-model Phase B** (filesystem write scope) – generování `.claude/settings.json` + `.codex/config.toml` s tier 1/2/3 deny rules na úrovni mirror. **Hodnota teď:** přestane se stávat, že agent edituje sourozeneckou mirror. **Hodnota později:** to samé pro tým a klientské oddělení.
3. **Druhé zařízení s opencode** – Portuni mirror, scope-model aktivní, reálná práce na obou strojích po dobu týdne+. Testuje cross-device hodnotu (tu auto mode strukturálně neumí).
4. **Měření** během celého období:
   - **Token spotřeba** pro typické úkoly: před scope-modelem vs. po (precízní kontext = méně search calls = méně tokens).
   - **Write leak incidents**: kolikrát se agent pokusil zapsat mimo current mirror.
   - **Read scope expansions**: kolikrát chtěl agent rozšířit kontext, čím (= mapa, kde je current scope set příliš úzký).
   - **Cross-device wins**: kolikrát ti přišlo vhod, že druhé zařízení vidí stejný graf.
5. **Po 3–4 týdnech review** – data, ne dojmy. Pak teprve rozhodnutí o desktop / Globex / dalším směru.

### Decision criteria po self-testu

**Pokračovat v invest (= jít do Phase 1.5 / Phase 2 nebo Globex testu):**
- Token economy je měřitelně lepší (cca 30 %+ pokles na ekvivalentní úkoly)
- Scope-model reálně zachytil neoprávněný read/write 5+ krát
- Cross-device sync ti aspoň jednou týdně reálně pomohl
- Aspoň jeden externí (post-konferenční) zájemce dotáhl instalaci a vrací feedback

**Strategický restart:**
- Token economy bez znatelného rozdílu (= hodnota Portuni je jinde, než jsem myslel)
- Scope-model nezachytil nic reálně problematického (= kontrolní teze není v praxi cítit)
- Cross-device sync ti mockrát nepomohl (= pracuješ stejně na jednom stroji)
- Žádný external interest po konferenci

### Konferenční kontext (2026-04-27, Po)

Konference je v pondělí 2026-04-27, dva dny po tomto rozhodnutí. Scope-model do té doby nestihneme – ten přijde po konferenci jako primary work track.

Konsekvence pro konferenci:
- **Zmínka jen krátká, žádné demo.** Pozicování v zmínce: "control plane pro agentní práci se znalostmi, ne lepší auto mode."
- Pokud někdo z attendees projeví zájem, **současná instalace zůstává jak je** (vývojářská: Node.js + tmux + varlock + gcloud). Pošleme link na repo s jasným upozorněním "vyžaduje technical comfort, do týdnů přijde lepší."
- Po self-testu (3–4 týdny po konferenci) bude install path stále vývojářský, ale scope-model bude ready a value claims dokázané daty. **V ten moment** má smysl follow-up komunikace s konferenčními kontakty.

Kontakty z konference jsou tedy první reálný "external single-user" testbed po self-testu, ne během něj. Konference není deadline pro produkt, je to **trigger pro identifikaci kandidátů** na pozdější self-onboarding.

## Otevřená otázka pro budoucnost

> "Když si představím sebe za 6 měsíců, otevřu Claude Code a píšu agentovi, nebo otevřu Portuni okno a kliknu?"

Honza (2026-04-25): "**Já bych Claude Code otevřel v Portuni a vše by bylo jednodušší.**"

To je validace agent-native směru. Desktop není místo, kde se klika místo agenta. Desktop je **kontejner pro agenta + nutné UI** (sync state, editor preview, settings).
