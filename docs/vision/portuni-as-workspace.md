# Portuni as Workspace — vision

> Status: vision document, not a plan. No implementation date. Captured for future reference so we don't have to re-derive the framing. Naposledy revidováno 2026-09-12.

## Premise

Portuni je vrstva mezi agentem a digitálními nástroji firmy. Drží kontext (graf POPP, scope), spravuje soubory nodů (mirrors, Drive), koordinuje s lidmi přes Asanu a spouští práci v cizích runnerech. Nenahrazuje žádný nástroj, integruje se s nimi. Používá to celý tým: Portuni desktop, Asana, Drive, každý nástroj ve své roli.

Způsob práce: člověk zadává práci agentovi nebo ji po něm přebírá, v UI dělá context management, Portuni to zjednodušuje. Děláme to pro sebe a pro svůj tým, abychom ušetřili práci a naučili se to.

## Identita

> "Portuni je control plane pro agentní práci se znalostmi."

Klíčová slova:
- **Control plane** — ne aplikace, ne tool. Vrstva, která rozhoduje, co agent vidí, kde pracuje, co smí zapsat a kde o tom zůstane záznam.
- **Znalostní práce** — psaní, výzkum, návrhy, syntéza. Ne tasky (od toho je Asana). Ne tabulky (od toho je Sheets / Airtable). Práce s textem a kontextem.
- **Agent-native** — agent je primární vstup. Kanál je úkol a jeho chat, ne terminál. Runner (Claude Code, Codex, OpenCode) je cizí a jen se připojí.

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
2. **Scope model** (implementace v `apps/server/mcp/scope.ts` + `apps/server/mcp/tools/scope.ts`: `portuni_expand_scope`, `portuni_session_log`, session type odvozený serverem z auth cesty – `interactive_task`/`interactive_chat`/`headless`/`env`, žádný `PORTUNI_SCOPE_MODE` env přepínač) je technické vyjádření této pozice. Read scope set + filesystem write tier 1/2/3 + audit jsou mechanismy, jak control plane funguje. Bez nich Portuni "ten control" jen tvrdí, ale nemá ho čím doložit.

## Konkurence

Portuni je vrstva pod nástroji, ne další nástroj vedle nich. Nesoutěží o uživatele s editory ani s knowledge base aplikacemi, ale s tím, že si harness vendor (Anthropic, OpenAI, T3) dostaví vlastní graf a knowledge base. To pro nás není důvod k rozhodování: děláme to pro sebe a pro tým.

**Nekonkuruje (a nesnažíme se):**
- **Asana, Linear, Jira** — task management. Asana je koordinační plocha týmu, Portuni ji nenahrazuje.
- **Notion** — všeobjímající workspace s databázemi. Příliš generické, my máme úzký focus.
- **Google Docs, Office** — rich-format collaborative editing. My se držíme markdown + linkujeme native dokumenty.
- **Slack, Discord** — chat / messaging. Komunikace mezi lidmi není naše.
- **Claude Code, Codex, OpenCode, T3 Code** — runnery a harnessy. Portuni je spouští a dává jim kontext, nestaví vlastní agent loop.

## Core UX moves

### 1. Práce na nodu je hlavní obrazovka

Záložka Práce: uprostřed chat relace s agentem, vedle detail nodu (soubory, hrany, aktéři, odpovědnosti, události, lifecycle) a editor. Levý sloupec ukazuje otevřené nody a jejich relace se stavem. Graf je mapa, ne shell: slouží k orientaci, tvorbě a propojování nodů.

Aktivní node určuje agentův kontext, scope a mirror, ve kterém runner pracuje. Žádný globální "soubory na disku" view. Vše je nodescoped.

### 2. Úkol a relace

Jednotka práce je relace, a relace je úkol. Relace trvá od zadání do archivu; pod ní se střídají konverzace runneru, po každém handoffu nová. Úkol relaci přidává zadání (prompt v Portuni, Asana task, později GitHub issue), stav (běží / čeká na mě / hotovo / archiv), runner, místo běhu a odkaz na Asana task.

- **Kompakce kontextu úkolu** je věc Portuni, kompakce transkriptu je věc runneru. „Předat a začít znovu" = suspend → handoff → nová konverzace naplněná kódem (seed, read set, orientace) plus handoff agenta.
- **Otázka agenta** je tah v chatu. Portuni podle ní nastaví stav „čeká na mě". V headless úkolu z Asany je tatáž událost komentářem v Asaně. Jeden model, dva povrchy, žádné zrcadlení.
- **Autonomie po triggeru** platí i pro odeslání: agent smí na konci běhu odeslat výstupy na Drive a napsat do Asany, když se tak rozhodne. Záměr vyjádřilo zadání úkolu.
- **Přehled** je inbox: běží, čeká na mě, hotovo, na pozadí.

### 3. Markdown editor s preview

Side-by-side jako Obsidian / iA Writer:
- left: source markdown (CodeMirror)
- right: rendered preview (live, syncscroll)
- top bar: file name, sync indicator, last save time

Člověk v Portuni píše rukou. Watcher registruje změny, push na remote je záměrná akce.

Out-of-scope: tabulky, embed chart, code blocks s execution. Čistý markdown.

### 4. Sync indikátor per-file

Vedle každého souboru v node detail panelu:
- ✓ clean
- ⬆ push (lokál nový)
- ⬇ pull (Drive nový)
- ⚠ conflict (oba se rozešli)
- ✕ remote_missing / remote_error / deleted_local
- 🔗 native (Google Doc / link, není sync)

Hover = detail (timestamps, hashes, who pushed). Klik = action menu (Push, Pull, Resolve, Snapshot).

### 5. Nastavení

Hosté a providery místo příkazu agenta a profilů. Lokální CLI se najdou samy, přihlášení se dělá v nich. Vzdálený host se ohlásí sám, jakmile na něm běží Portuni agent přihlášený Googlem. Host je tvůj, dokud ho neoznačíš jako týmový. Host a instance providera se volí per úkol nebo výchozí per organizace. Tajemství nikdy do webview ani do plaintextu.

## Runner a místo běhu

Model T3 Code: provider + environment.

- **Provider** (Claude Code, Codex, OpenCode) se nenastavuje. Najde se na PATH, přihlášení se ověří dotazem na samotné CLI. Osobní předplatné musí fungovat. Víc účtů = víc instancí providera (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, env); datový model dnešních profilů zůstává, čte ho adaptér na hostu.
- **Environment** je stroj s běžícím Portuni agentem (sidecar v agent módu, odpojený od desktopu): lokálně, na serveru jako služba, na starém Macu přes launchd, volitelně instalovaný z desktopu přes SSH. Environment vlastní mirrory, providery a jejich přihlášení.
- **Bez párování, přes central.** Host se přihlásí device tokenem a drží odchozí spojení k centralu, klient mluví jen s centralem. Host nepotřebuje otevřený port ani tunel. Chat úkolu teče přes central. V lokálním módu je klient a host jeden proces.
- **Jedno rozhraní runner, pod ním adaptéry**: Claude Agent SDK, Codex app-server, OpenCode, ACP pro ostatní. ACP samotné nestačí, oba hlavní runnery mají vlastní bohatší kanál.
- **Kanonický model událostí.** UI nekreslí výstup providera, ale vlastní události (zpráva, tool call, změna souboru, žádost o schválení, otázka, kompakce), na které adaptéry překládají. Proto UI vypadá stejně bez ohledu na runner.
- **Práva runneru = práva zadavatele.** Runner vidí to, k čemu je node propojený, a jedná s právy člověka, který úkol zadal, nikdy víc. Týmový host dostane k úkolu token na jméno zadavatele a po skončení ho zahodí. Kernelový sandbox není; write-scope se vynucuje schvalovacím callbackem adaptéru a guard hookem, čtení mimo scope hlídá MCP scope a `portuni_read_file`.
- **Relace je vázaná na host, ale přenosná.** Handoff umožní pokračovat na jiném hostu novou konverzací.
- **Riziko, které nezmizí:** Anthropic v roce 2026 dvakrát změnil postoj k použití předplatného z cizích klientů; dnes to funguje, právní text říká „použijte API klíč". OpenAI to výslovně povoluje. Volba adaptérů to nemění.

## Asana

Asana je koordinační plocha týmu. Portuni funguje i bez ní.

- Node (kromě organizace) může mít Asana projekt: založit nebo napojit existující. Vazba jde přes dnešní tools, které už na Asana projekty odkazují. Organizace odpovídá Asana týmu (otevřeno).
- Úkol lze zadat z Portuni (prompt, vložený link na task) i z Asany (přiřazení agentovi). Obě cesty jsou rovnocenné; trigger z Asany je stretch, firma nemůže překopat Asanu ani Drive ze dne na den.
- Pole, která lidé čtou a mění (název, zadání, přiřazení, stav, komentáře), žijí v Asaně, když je node napojený; jinak v Portuni. Pravda o běhu žije v Portuni.
- Nic se nezrcadlí automaticky. Interaktivní relace žije v chatu v Portuni, komentář do Asany je rozhodnutí agenta nebo člověka. Úkol zadaný v Asaně běží headless a odpovídá komentářem v Asaně (model AIQ).
- Asana je první adaptér rozhraní „task surface", stejný vzor jako `FileAdapter`. Změna Asana API nesmí vynutit lock-step update core.

## Skills, rutiny, nadhled

- **Skill je node zabalený pro agenta.** Znalost nodu (popis, principy, soubory, postupy, rozhodnutí) se zkompiluje do jednoho nebo více skills a agent node invokuje, když ho potřebuje. Skill nepíše člověk, píše ho agent v běhu na nodu; Portuni ten běh spouští jako rutinu při změně obsahu nodu, výsledek balí a distribuuje do týmu: do sessions runnerů i do ručně otevřených CLI. Invokace nodu je rozšíření scope plus načtení jeho skillu, jedna akce.
- **Rutina je úkol s rozvrhem a politikou.** Každý běh je relace na nodu, headless na některém hostu; handoff mezi běhy je paměť rutiny. Politika říká, co se stane s výsledkem: `auto` zapíše a odešle, `review` nechá v „čeká na mě". Node má vedle relací záložku se svými rutinami (poslední běh, příští běh, stav), Přehled má sekci „Na pozadí". Když rutina něco potřebuje, jde to stejným kanálem jako každý úkol.
- **Agent nadhledu je rutina na organizaci.** Scope celé firmy, pravidelně projde graf a navrhne chybějící nody, úpravy a slepá místa. Navrhuje, člověk přijímá.
- **Kontext firmy a člověka je skill organizace a skill aktéra.** Aktéři v grafu ponesou roli, vztah k organizacím a entity, které dnes žijí mimo Portuni. Skill organizace vzniká stejným mechanismem jako skill procesu.
- **Šablony projektů** jsou zatím myšlenka. Návrh bez nového typu: proces nese, jak se z něj zakládá projekt, a založení je skill toho procesu.

## Local vs. central

Nová funkce se staví jednou, jako kód serverové domény, který běží na centralu i v lokálním sidecaru. Co by pro lokální mód vyžadovalo druhou implementaci, je central-only. Lokální mód je central v krabici pro jednoho člověka: SQLite místo Postgres, bez Google loginu, bez Drivu, bez týmu. Slouží na vyzkoušení a musí se v něm dát pracovat.

| | Central | Lokál |
|---|---|---|
| Graf, mirrory, editor, sledování souborů | ano | ano, stejný kód |
| Relace jako úkol, chat, handoff, runner rozhraní, adaptéry | ano | ano, stejný kód, host = tentýž sidecar |
| Host přes central, fronta úkolů, token na jméno zadavatele | ano | ne, úkol se spustí přímo na tomto stroji |
| Asana adaptér | ano | ne |
| Rutiny, agent nadhledu, generování skills | ano, plánovač na centralu | ne; rutinu jde spustit ručně jako úkol |
| Tým, práva, sdílené hosty | ano | ne |
| Drive sync | ano | ne |

Dnešní dvojice engine / engine-central, router / agent-router, transport / agent-transport jsou to, čemu se nová práce vyhýbá; další pár nesmí vzniknout. Runner a chat se staví v sidecaru tak, aby v central módu byl sidecar host a central držel záznam relace, a v lokálním módu obojí dělal jeden proces.

## Proč agent-native matters

Většina aplikací dnes přidává agenta jako "AI feature" — sidebar chat, autocomplete tlačítko. Portuni navrhuje opačné mapování: **agent je primary, UI je vizualizace toho, co agent + uživatel dělají společně**.

Důsledky:
- Každá akce v UI má MCP-tool ekvivalent. Klik = volání nástroje. Agent může všechno, co user může.
- Žádný state v UI bez state v MCP. Když agent něco změní, UI se aktualizuje (live).
- "Co bylo poslední velká věc, co jsem udělal?" — answerable both via UI scrolling AND `portuni_get_recent_audit { user, n: 10 }`.

## Otevřené otázky

1. **Offline mode.** Když Drive není dostupný, UI by mělo fungovat. Sync indikátory zachycují stav.
2. **Search.** Cross-node fulltextový hledač přes všechny markdown soubory. Tantivy? Vector embeddings (semantic search)? Obojí?
3. **Organizace ↔ Asana tým.** Jak se mapuje organizace, když nemá vlastní Asana projekt.
4. **Missing pieces.** Portuni loguje, když někdo narazí na chybějící node, hlasy se sčítají a Přehled pomáhá prioritizovat. Vztah k agentovi nadhledu.
5. **Šablony projektů.** Viz Skills, rutiny, nadhled.
6. **Mobile.** Read-only viewer + rychlá poznámka? Long-term, neřešíme teď.

## Co je v core, co ne

> Doplněno 2026-04-25. Rozhodovací rámec pro otázku "patří X do Portuni?", aby se neřešilo ad-hoc per feature.

Portuni poskytuje **primitiva**. Aplikace nad nimi patří mimo core.

**V core:**
- Graf (POPP nodes, edges, lifecycle, events, aktéři)
- File sync s remote drivery + mirrors
- Scope model + audit (impl: `apps/server/mcp/scope.ts`, `apps/server/mcp/tools/scope.ts`)
- Relace, úkoly, rutiny, handoff
- Rozhraní runner + adaptéry, runner host
- Rozhraní task surface + Asana adaptér
- Skills z nodů (generování, distribuce)
- MCP server s tools, REST endpoints (např. `/context`)
- Referenční React UI

**Mimo core (vítané jako patterns / examples / downstream projekty):**
- Chat boti (Google Chat, Signal, Slack adaptéry)
- Organizační templates (specifické šablony pro typ firmy / odvětví)
- Custom CLI nástroje napojené na Portuni MCP
- Integrace s dalšími SaaS (Notion, Linear, atd.) – linkujeme, neintegrujeme; Asana je výjimka jako koordinační plocha týmu
- Vendor-specific automatizace (Acme / Globex workflowy)

**Test, jestli něco patří do core:**

Pokud změna v API třetí strany (vendor SaaS, chat platform, LLM provider) by si vyžádala lock-step update v Portuni core, **dané X nepatří do core**. Core musí přežít vendor changes bez release. Asana a runnery jsou za adaptérem právě proto.

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
- **Integration sprawl.** "100+ skills connected to apps" (à la OpenClaw). Každá integrace = maintenance burden + leak surface. Linkujeme, neintegrujeme; Asana a runnery jdou přes adaptér s jedním rozhraním.
- **Vlastní agent loop.** Portuni nevlastní transkript, tooly ani kompakci transkriptu. Runner je cizí a jen se připojí; když přijde lepší, vymění se adaptér.
- **Vestavěný terminál jako UI.** Surový výstup CLI je technický, každý runner vypadá jinak a nic z něj nejde strukturovaně vyčíst. UI stojí nad kanonickými událostmi.
- **Feature counting jako marketing.** "X+ MCP tools and growing" je past – nutí počítat místo navrhovat. Portuni positioning = "úzký, hluboký, kontrolovaný", ne "wide and growing".
- **Multi-platform frontend sprawl.** Chat na Signal + Telegram + Discord + WhatsApp paralelně = 4× povrch pro bugy a abuse. Jeden kanonický frontend (React UI + MCP), ostatní jako tenké adaptéry mimo core.
- **Chat-as-primary-UI.** Chat je kanál úkolu, ne UI nad grafem, scope, auditem a soubory. Ty mají vlastní pohledy.
