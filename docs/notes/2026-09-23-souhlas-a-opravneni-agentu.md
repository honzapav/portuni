# Souhlas, scope a oprávnění agentů — analýza stavu

Podklad pro spec. Popisuje, jak dnes Portuni rozhoduje, co agent smí
číst a zapsat, kde se ptá člověka, a kde ten model selhává. Vychází ze
srpnového redesignu (`docs/superpowers/specs/2026-08-31-scope-sessions-redesign-design.md`),
z kódu (`mcp/scope.ts`, `domain/write-gate.ts`, `mcp/tools/scope.ts`,
`mcp/agent-transport.ts`, `domain/runner/permissions.ts`) a z incidentů
z 22. 9. 2026 (AIQ NaturaMed, claude.ai Konektor, chat v Portuni).

## Co model dnes tvrdí

Tři pojmy, každý s vlastním pravidlem:

| Pojem | Otázka | Kdo rozhoduje | Dnes |
|---|---|---|---|
| Oprávnění | Smí tahle identita node vidět a měnit? | Server, z Google skupin a udělení na node | Platí vždy, bez dialogu. Jen u vyhledávání a globálního listu je to jediná brána. |
| Scope | Je node součástí toho, na čem session pracuje? | Server, z výchozího nodu a hran grafu | Čtení: hrana povolí sama, skok bez hrany chce potvrzení. Zápis: jen výchozí node, jinak potvrzení. |
| Souhlas | Kdo potvrzení dá? | Klient, přes MCP dialog (elicitation) | Předpoklad: kdo dialog umí, má u něj člověka. |

Typ session určuje, co z toho platí. Odvozuje se z přihlašovacího údaje:

| Typ | Podle čeho | Čtení | Zápis | Dialog |
|---|---|---|---|---|
| `interactive_task` | token zařízení, `?home_node_id` | scope + hrany + dialog | výchozí node, vlastní nody, dialog | ano |
| `interactive_chat` | OAuth konektor (claude.ai) | jen oprávnění | nody vytvořené v kterékoli dřívější konektorové session uživatele, jinak dialog | ano |
| `headless` | token zařízení s příznakem headless | scope; skok jen se zdůvodněním | výchozí node a vlastní nody, nic víc | ne |
| `env` | loopback token (osobní workspace) | scope + hrany + dialog jako `interactive_task` | bez omezení | ano (jen čtení) |

## Kde to selhává

### 1. Typ session neříká, jestli u ní sedí člověk

Typ se odvozuje z tokenu, ne z toho, jestli existuje kanál, kde se dá
zeptat. Důsledky:

- AIQ na starém Macu jde přes sidecar s tokenem zařízení, takže je
  `interactive_task`. Server mu pošle dialog. Headless Claude dialog
  přijme a sám odmítne. Server zapíše „uživatel odmítl", i když nikdo
  nic neodmítl (NaturaMed, 22. 9.).
- Sidecar v týmovém workspace navíc *nikdy* nedokáže headless poznat:
  jeho lokální HTTP server jede v `env` módu a typ se dopočítává jako
  `interactive_task` pro každé připojení (`deriveAgentSessionType`).
  Headless token by musel jít přímo na centrální server, mimo zařízení
  s mirrorem. Pak ale nefungují lokální nástroje (`portuni_store`).
- Chat v Portuni měl do 22. 9. dialogy zahazovat: adaptér runneru
  neměl `onElicitation`, nástroj visel do timeoutu (PR #473 to opravuje).
- Claude.ai na telefonu dialog nemusí ukázat; agent pak hlásí
  „No approval received" a čtenář si myslí, že chyba je v Portuni.

Pokaždé stejný vzor: server se zeptal do prázdna a výsledek zapsal
jako lidské rozhodnutí.

### 2. Osobní a týmový workspace se chovají jinak

V osobním workspace je každá session `env`: čtení má scope a dialogy
jako v týmu, ale zápisová brána `env` výslovně pouští všechno. V
týmovém workspace se na zápis ptá. Pravidlo z `CLAUDE.md` („každá
změna funguje v obou") tady neplatí od návrhu, protože spec `env`
vyňal. Jeden člověk tak vidí dva různé produkty podle toho, jestli má
tým.

### 3. Dvě brány na jednu věc

`portuni_expand_scope` zastaví nejdřív runner v aplikaci
(`permissions.ts`: „Rozšířit rozsah relace?", kromě politiky `auto`).
U zápisu (`writable: true`) se pak během nástroje zeptá ještě server
dialogem: dvakrát na totéž. U čtení server dialog nepošle a přijme
zdůvodnění, takže tam je jedinou skutečnou otázkou ta z runneru. Brána
v runneru vznikla, když se dialogy do chatu nedostaly. Každý další
adaptér (Codex, OpenCode) ji musí volat stejně, jinak se chová jinak
než Claude.

### 4. U čtení je souhlas na čestné slovo

Skok bez hrany server přijme s `reason: "user-confirmed-in-chat"`.
Ověřit to nemůže. Audit zapíše, co agent napsal. Pro člověka v chatu
je to přijatelná pojistka pozornosti; pro agenta bez člověka je to
brána, kterou projde každý, kdo napíše správnou větu. Platí to i pro
tvrdé dno (`private` cizího uživatele, `scope_sensitive`): dialog se
ukáže jen při přímém čtení (`get_node`), ale `portuni_expand_scope` s
`confirmed_hard_floor: true` projde bez dialogu, na slovo agenta.
Headless je jediný typ, kde tvrdé dno drží.

Dvě další díry stejného druhu:

- `portuni_session_init` smí kdykoli přenastavit výchozí node, bez
  potvrzení, i v headless session. Nový výchozí node je automaticky
  zapisovatelný, takže se tím obchází zápisová sada (oprávnění ne).
- Seed scope bere sousedy výchozího nodu jen podle viditelnosti, ne
  podle `scope_sensitive`. Citlivý soused je ve scope od začátku a
  tvrdé dno se na něj už nepoužije, ani v headless.

### 5. Souhlas supluje oprávnění

Dialog byl navržený jako pojistka pro člověka: „agent chce jinam, než
řešíme". U agenta bez člověka se z něj stala jediná hranice zápisu.
Když dialog chybí, agent nemůže nic; když se objeví a někdo ho
odklikne, agent smí do toho nodu zapisovat po zbytek session, ne jen
tu jednu operaci. Oprávnění agenta jako takového neexistují: běží pod
tvůrcem (spec aktérů) nebo pod tokenem zařízení svého stroje.

MCP navíc není jediná cesta. Runner pouští Bash bez otázky, disk
nemá sandbox a souborové REST cesty mají výjimku pro běžný token
zařízení. Hranice pro agenta musí platit i tam, jinak je scope jen
nápověda pro poslušný model.

V týmovém workspace se souhlas ani nepřenese celý: sidecar drží
vlastní zápisovou sadu pro lokální nástroje (`portuni_store`,
`portuni_mirror`) a výsledek `expand_scope` z centrálního serveru do ní
nepropisuje. Po odsouhlaseném rozšíření může lokální nástroj stejně
narazit.

### 6. UI schválení nebylo nikdy hotové jako celek

- Chat posílal u schválení text tlačítka; runner bere text jako
  odpověď, která povoluje. „Ne" schvalovalo rozšíření scope i plán
  (PR #473).
- Dialog ze serveru nemá v chatu žádné rozlišení od schválení nástroje;
  otázka nenese, kdo se ptá (server, runner) ani co se stane po „Ne".
- Chat drží jednu otevřenou otázku na session. Druhá otázka (dva
  nástroje naráz, dialog vedle schválení nástroje) první přepsala a
  odpověď na ni už neměla kam dojít (PR #473 otázky řadí za sebou).
- Nikde v UI není vidět, co session smí: výchozí node, rozšíření,
  zápisová sada. `portuni_session_log` ukazuje jen čtecí scope, ne
  zápisovou sadu.
- Timeout dialogu 4 minuty je pro telefon a pro člověka mimo obrazovku
  krátký. Po vypršení agent dostane samostatný výsledek `timeout` s
  pokynem zeptat se znovu; odmítnutí a zrušení dialogu (headless Claude
  ho zruší sám) se ale slévají do „uživatel odmítl".

### 7. Soubory mimo zařízení

`portuni_store` bere jen cestu na disku zařízení s mirrorem. Session
z claude.ai jde přímo na centrální server a skončí vnitřní chybou
(`PORTUNI_WORKSPACE_ROOT must be set`). Není to selhání souhlasu, ale
stejná příčina: model počítá s tím, že kdo zapisuje, sedí u zařízení.

## Co z toho plyne

Model má tři otázky smíchané do jedné a jediný typ odpovědi (dialog).
Rozdělení:

1. **Oprávnění rozhodují vždy a samy.** Čtení, vyhledávání i zápis se
   nejdřív ptají „smí tahle identita?". Odpověď dává server z udělení,
   bez dialogu, pro člověka i agenta. Agent má vlastní identitu a
   vlastní udělení na nody a konektory (Asana: „Agenti jako servisní
   účty"). Práva konkrétního běhu jsou průnik: vlastník ∩ agent ∩ úkol.
   Vlastní identita sama o sobě běh neomezuje; bez třetího členu
   (úkol) by každý běh měl všechna práva agenta.
2. **Scope je pojistka pozornosti, ne bezpečnost.** Platí jen tam, kde
   je člověk, kterého chrání před tím, aby agent odběhl. Kde člověk
   není, scope nerozhoduje nic; rozhodují oprávnění a audit. Výjimka:
   tvrdé dno (`scope_sensitive`, cizí `private`) dostane vlastní
   vymahatelnou politiku nezávislou na scope, protože audit zásahu
   nezabrání.
3. **Kanál souhlasu je vlastnost session, ne klienta.** Session nese,
   jestli má živý lidský kanál (chat v Portuni s připojeným oknem,
   terminál, claude.ai s dialogy) nebo ne (AIQ, rutiny, sync agent).
   Server se ptá jen tam, kde kanál je, a ptá se jednou. Bez kanálu
   dialog nevzniká a nezapisuje se žádné „uživatel odmítl". Kanál
   neznamená důkaz souhlasu: to, kdo smí odpovědět (vlastník session),
   ověřuje server stejně jako dnes u `answer`.
4. **Jedna brána.** Runner v aplikaci se na scope neptá; ptá se server,
   odpověď se vrací do chatu stejnou komponentou jako ostatní schválení.
   Čtecí skok bez hrany tím přijde o svou jedinou skutečnou otázku:
   buď se server začne ptát dialogem i u čtení, nebo čtení zůstane na
   oprávněních a auditu. Spec musí zvolit.
5. **Osobní a týmový workspace stejně.** `env` přestává být výjimka pro
   agenty: osobní workspace má stejné typy session a stejné brány, jen
   s jedinou identitou. Výjimku si drží jen to, co agent není: UI
   aplikace (člověk) a deterministický sync (proces bez session).
6. **UI je součást brány.** Schválení v chatu nese, kdo se ptá a co se
   stane po odmítnutí; tlačítka posílají rozhodnutí, ne text; session
   ukazuje svůj scope a zápisovou sadu; souhlas platí pro jednu
   operaci, nebo je to výslovně trvalé udělení, a UI to rozlišuje.
   Pozdější odpověď na nezodpovězený dialog není prodloužený timeout
   (naráží na limit volání nástroje), ale trvalá žádost s expirací,
   která se při vyřízení znovu ověří proti oprávněním.

## Co se tím nemění

- Tvrdé dno (`private` cizího uživatele, `scope_sensitive`) zůstává
  tvrdé pro agenty bez člověka.
- Vyhledávání a globální list zůstávají jen na oprávnění.
- Audit každé expanze a každého zápisu zůstává.
- Nody vytvořené session zůstávají v její zápisové sadě.

## Rozhodnutí, která spec musí udělat

1. **Co omezuje konkrétní běh:** průnik práv vlastníka, agenta a úkolu;
   pravidla pro nody vytvořené během běhu, pro tvrdé dno, pro expiraci
   a odvolání udělení.
2. **Kde leží autorita:** nezfalšovatelná vazba přihlašovací údaj →
   agent → session; kotva session neměnná, nebo měnitelná jen
   s potvrzením (`session_init` dnes mění bez něj); jedna brána pro
   MCP, REST, sidecar i disk.
3. **Co přesně schválení znamená:** jedna operace, nebo trvalé udělení;
   kdo smí odpovědět; rozdílné výsledky pro odmítnutí, zrušení,
   timeout a ztrátu kanálu.

## Otevřené otázky pro spec

- Čí přihlašovací údaj nese sdílený konektor (strojový vs. půjčený od
  člověka) a jak se to zapisuje do auditu.
- Udělení na node: jen jmenované nody, nebo i podstrom (organizace →
  projekty).
- Kde v UI člověk udělení agentovi spravuje a kde vidí, co agent udělal.
- Jak session zjistí, že kanál právě zmizel (zavřené okno chatu) a co
  se stane s otevřeným dialogem: čekat, nebo odmítnout a nechat agenta
  zeptat se znovu.
