# Multi-workspace desktop (design)

> Status: design spec, schváleno v brainstormu 2026-07-04, připraveno pro
> implementační plán. Motivace: dvě nezávislé Portuni instance na jednom
> stroji (Tempo v central mode + osobní „honzapav" v local mode) v jedné
> desktopové appce – jako obecná funkce pro N workspaces, ne jednorázový
> hack pro dvě.

## Glosář

- **Workspace** = nezávislý svět: vlastní graf (Turso DB nebo central
  server), vlastní sidecar, vlastní mirrory, tokeny a konfigurace.
  Dřívější pracovní názvy „instance" a „profil" ve spec nepoužíváme.
- **Workspace root** = složka workspace na disku (mirrory, `.portuni/sync.db`).
  Atribut workspace, ne samostatný koncept.
- **Workspace ID** = slug (`[a-z0-9-]`), zvolený při vytvoření, neměnný.
  Odvozuje se z něj data dir, Keychain suffix, jméno globálního MCP entry
  a jméno token env proměnné.

## Cíl

Jedna desktopová appka obsluhuje N nezávislých workspaces současně:
sidecary všech zapnutých workspaces běží naráz (každý na svém portu, se
svým data direm a credentials), UI zobrazuje vždy jeden a přepínač mění
jen pohled. Agent sessions (Claude Code, Codex, Vibe) fungují proti
všem workspaces kdykoli – uvnitř mirrorů automaticky (per-mirror
configy), mimo mirrory volbou pojmenovaného MCP serveru.

## Rozhodnutí z brainstormu

| Otázka | Rozhodnutí |
|---|---|
| Souběh vs. přepínání | **Sidecary všech zapnutých workspaces běží souběžně**; „přepínač" mění jen to, který workspace zobrazuje webview. Plný souběh v UI (dvě session naráz) mimo scope. |
| Název konceptu | **Workspace.** „Profil" evokuje předvolby uživatele, „instance" bylo zvažováno; workspace ladí se stávajícím workspace root (stane se atributem) a s mentálním modelem Slack/Notion. |
| Obecnost | Plnohodnotná funkce pro N workspaces s libovolnými jmény a kombinacemi režimů (local/central). Nic není vázané na konkrétní jména. |
| Globální MCP entries | Trvalé entry per workspace (`portuni-<id>`), obě/všechna živá zároveň. Nepřepisují se při přepnutí. Workspace z migrace v1 si drží jméno `portuni` (kompatibilita tool prefixů a permission allowlistů). |
| Token env vars | Per workspace: `PORTUNI_MCP_TOKEN_<ID>`. Appka injektuje do terminálů všechny; `PORTUNI_MCP_TOKEN` zůstává jako alias aktivního workspace. |
| Sidecar | Beze změny logiky – už dnes plně řízený env. Nová env `PORTUNI_WORKSPACE_ID`; bez ní se chová přesně jako dnes (standalone servery nulová regrese). |
| Bundle identifier | Zůstává `ooo.workflow.portuni`. Neměníme (fork identifieru zavržen jako build-time řešení, negeneralizuje). |
| Multi-tenant sidecar | Zavržen – velký zásah do backendu (server předpokládá jednu DB a jeden scope svět), přinesl by souběh v UI, který není potřeba, za nejvyšší cenu. |

## 1. Datový model configu

`config.json` (stále `~/Library/Application Support/ooo.workflow.portuni/config.json`,
non-secret) dostane verzi 2:

```json
{
  "config_version": 2,
  "active_workspace": "tempo",
  "workspaces": {
    "tempo": {
      "label": "Tempo",
      "enabled": true,
      "data_mode": "central",
      "server_url": "https://…",
      "google_client_id": "…",
      "google_client_secret": "…",
      "workspace_root": "~/Workspaces/portuni-tempo",
      "mcp_port": 47011,
      "mcp_server_name": "portuni"
    },
    "honzapav": {
      "label": "Honza Pav",
      "enabled": true,
      "data_mode": "local",
      "turso_url": "libsql://…",
      "workspace_root": "~/Workspaces/honzapav",
      "mcp_port": 47012
    }
  }
}
```

- Klíč mapy = workspace ID (slug, neměnný). `label` je zobrazované jméno,
  volně editovatelné.
- Pole uvnitř workspace jsou přesně dnešní pole plochého `DesktopConfig`
  (`apps/desktop/src/lib.rs`) – žádná nová sémantika, posun o úroveň níž.
- `mcp_port` se přiděluje při vytvoření workspace: první volný port od
  47011 vzhledem k portům ostatních workspaces v configu. Uloží se a je
  navždy stabilní (externí `.mcp.json` konfigy zůstávají platné).
- `mcp_server_name`: jméno globálního MCP entry, default `portuni-<id>`.
  Migrace v1 nastaví `portuni` (viz §6).
- `enabled: false` = sidecar se nespouští a globální MCP entry workspace
  se odinstaluje; data na disku zůstávají.
- `active_workspace` říká pouze, který workspace zobrazuje webview po
  startu. Žádný jiný význam.

## 2. Lifecycle sidecarů

Při startu appky Rust shell spustí sidecar **pro každý zapnutý workspace**
(dnes spouští jeden). Každý dostane své env – vše už dnes existuje, jen
se hodnoty berou z workspace místo z plochého configu:

- `PORTUNI_DATA_DIR=<app_data>/workspaces/<id>/` (vlastní `portuni.db`
  embedded replica),
- `PORTUNI_PORT=<mcp_port>`,
- `PORTUNI_WORKSPACE_ROOT`,
- tokeny z Keychainu daného workspace (§3),
- u `data_mode: "central"`: `PORTUNI_AGENT_MODE=1`, `PORTUNI_CENTRAL_URL`,
  `PORTUNI_CENTRAL_TOKEN`,
- **nově** `PORTUNI_WORKSPACE_ID=<id>` (konzumuje generátor configů, §4).

Změny v Rustu (`lib.rs`):

- Stav se zobecní z jednoho procesu na mapu `workspace_id → SidecarHandle`
  (child proces, port, health, restart policy). Dnešní chování per handle.
- Orphan reaper (`reap_orphan_sidecar`) běží per port před každým spawnem;
  logika beze změny, volá se N-krát.
- `api_request` / `central_request` routují podle **aktivního** workspace.
  Přepnutí v UI = zápis `active_workspace` + přesměrování routingu +
  reload webview. Žádný restart procesů.
- Pád jednoho sidecaru neshazuje ostatní. Ukončení appky zabije všechny.

Sidecar (Node) se nemění – s výjimkou čtení `PORTUNI_WORKSPACE_ID`
v generátorech configů (§4).

## 3. Keychain a tokeny

Keychain service zůstává `ooo.workflow.portuni`. Account jména dostanou
suffix workspace ID:

| Account (dnes) | Account (v2) |
|---|---|
| `turso_auth_token` | `turso_auth_token.<id>` |
| `mcp_auth_token` | `mcp_auth_token.<id>` |
| `google_refresh_token` | `google_refresh_token.<id>` |
| `portuni_session_jwt` | `portuni_session_jwt.<id>` |
| `portuni_device_token` | `portuni_device_token.<id>` |

- Všechny Keychain helpery (`lib.rs`, `auth.rs`, `pty.rs`) dostanou
  parametr workspace ID. Žádný unsuffixovaný přístup nezůstane.
- Migrace při prvním startu v2 překopíruje stávající accounty na
  suffixované a staré smaže (§6).
- Google login, session JWT i device token jsou tím plně per workspace –
  přihlášení v jednom workspace nikdy nepřepíše druhý. Device token je
  fakticky klíčovaný podle workspace (a tedy podle jeho `server_url`).
- Každý sidecar má vlastní `mcp_auth_token` (dnešní generování a
  persistence v Keychainu, jen per workspace) a vlastní Turso token.
- Secrets nikdy v `config.json` – beze změny (bezpečnostní pravidla platí).

## 4. MCP configy

### Globální (user-scoped fallbacky)

`~/.claude.json`, `~/.codex/config.toml`, `~/.vibe/config.toml`
(`apps/desktop/src/mcp_install.rs`):

- Jeden entry per zapnutý workspace, jméno = `mcp_server_name`
  (default `portuni-<id>`). Všechny entries jsou živé zároveň – session
  mimo mirror si vybírá podle jména.
- Instalátory se zobecní z „nahraď entry `portuni`" na „spravuj množinu
  entries podle configu": upsert pro zapnuté workspaces, odstranění entry
  při smazání nebo vypnutí workspace. Marker/managed logika per entry
  zůstává (Codex marker blok, Vibe de-dup by name, Claude replace by key).

### Per-mirror (project-scoped)

Generuje každý workspace svým serverem
(`apps/server/domain/write-scope.ts`, `scope-materialize.ts`):

- Jméno serveru zůstává `portuni` vždy – tool prefixy `mcp__portuni__*`
  jsou uvnitř mirrorů stejné pro všechny workspaces. URL míří na port
  daného workspace (funguje už dnes přes `PORTUNI_URL`/`PORT`).
- Token reference: `${PORTUNI_MCP_TOKEN_<ID>:-}` místo globálního
  `PORTUNI_MCP_TOKEN`; obdobně Codex a Vibe (`api_key_env`). Jméno
  proměnné = `PORTUNI_MCP_TOKEN_` + uppercase ID s `-` → `_`.
- Server zná své ID z env `PORTUNI_WORKSPACE_ID`. **Bez ní generuje
  přesně dnešní výstup** (`PORTUNI_MCP_TOKEN`) – standalone servery mimo
  desktop mají nulovou změnu.

### Spawnované terminály (pty.rs)

Appka injektuje tokeny **všech** zapnutých workspaces jako
`PORTUNI_MCP_TOKEN_<ID>`, plus `PORTUNI_MCP_TOKEN` = token aktivního
workspace (zpětná kompatibilita). Terminál otevřený v mirroru
libovolného workspace tak má vždy správný token, bez ohledu na to, který
workspace je aktivní v UI.

### Guard hook

Materializace zapíše URL a jméno token env proměnné daného workspace
přímo do hook command v `settings.local.json` (místo spoléhání na
`PORTUNI_URL`/`PORTUNI_AUTH_TOKEN` z prostředí shellu).

## 5. UI

- **Settings → Workspaces**: seznam (label, ID, režim, stav sidecaru);
  „Přidat workspace" = jméno (→ slug s validací a kontrolou unikátnosti),
  volba režimu (local: Turso URL + token; central: server URL + Google
  login), workspace root. Onboarding polí = dnešní Settings obsah, per
  workspace. Akce: zapnout/vypnout, smazat.
- **Smazání** odebere workspace z configu, zastaví sidecar, odinstaluje
  globální MCP entry a smaže Keychain accounty. **Data dir a mirrory na
  disku nechává** – destruktivní úklid jen ručně; potvrzovací dialog
  vypíše, co na disku zůstane.
- **Přepínač**: menu v hlavičce appky se jménem (label) aktivního
  workspace; rozbalení nabídne ostatní. Přepnutí = zápis
  `active_workspace`, přesměrování routingu, reload webview.
- Settings → Účet (Google login) se vztahuje vždy k aktivnímu workspace.
  Workspace-scoped Tauri commandy implicitně používají aktivní workspace
  (webview zobrazuje jen jeden svět naráz).

## 6. Migrace v1 → v2

Spouští se při prvním startu v2, když config nemá `workspaces`:

1. Jednorázový dialog „Pojmenuj svůj stávající workspace" (prefill
   `default`) – ID je pak neměnné, takže volba musí být uživatelova.
2. Plochá pole configu se zabalí do `workspaces.<id>`,
   `config_version: 2`, `active_workspace: <id>`.
3. Soubory z kořene data diru (`portuni.db` a související) se přesunou do
   `workspaces/<id>/`.
4. Keychain accounty se překopírují na suffixované, staré se smažou.
5. `mcp_server_name: "portuni"` – existující globální entry se jen
   aktualizuje na místě, tool prefixy a permission allowlisty se nemění.

Vlastnosti: migrace je **idempotentní** (přerušený běh se dá bezpečně
opakovat – každý krok kontroluje, zda už proběhl); sidecar se nespouští
před dokončením přesunu DB souborů; v2 config se nikdy tiše nepřepíše
defaultem (parse error = chyba uživateli, ne reset).

Sidecar logy nově per workspace: `sidecar-<id>.log` v dosavadním log
adresáři.

## 7. Error handling

- Pád/nespuštění jednoho sidecaru neblokuje ostatní. Workspace má stavový
  indikátor ve switcheru i v Settings; přepnutí na nefunkční workspace
  ukáže chybu s retry.
- Reaper zabíjí jen procesy identifikované jako `portuni-sidecar` na
  daném portu (dnešní logika). Cizí proces na portu = chyba u workspace
  („port obsazen, změň `mcp_port`"), žádný kill.
- Selhání Keychain migrace: staré accounty se nemažou, chyba se zobrazí,
  další start migraci zopakuje.
- Duplicitní `mcp_port` nebo ID v ručně editovaném configu = validační
  chyba při startu s jasnou hláškou (ne tichá kolize).

## 8. Testy

- **Rust unit testy**: parse configu v2, migrační transformace v1 → v2
  (včetně idempotence), alokace portů, odvození jmen (Keychain suffix,
  env var, MCP entry).
- **TS testy generátorů**: s `PORTUNI_WORKSPACE_ID` nastaveným →
  suffixovaná token proměnná v `.mcp.json`/Codex/Vibe výstupech; bez ní →
  bajtově dnešní výstup (regresní pojistka pro standalone).
- **TS testy instalátorů**: správa množiny globálních entries (upsert
  více workspaces, odstranění při disable/delete, zachování cizích entries).
- Stávající serverové testy běží bez `PORTUNI_WORKSPACE_ID` – hlídají
  nulovou regresi.
- **Ruční E2E checklist**: dva workspaces (central + local), oba sidecary
  běží, přepnutí pohledu, terminál v mirroru neaktivního workspace mluví
  se správným serverem a tokenem, agent session mimo mirror vidí obě
  pojmenovaná entries a obě fungují, smazání workspace nechá disk netknutý.

## Mimo scope

- Souběžné zobrazení dvou workspaces ve webview (dvě session naráz).
- Přejmenování workspace ID po vytvoření (label editovatelný je).
- Multi-tenant sidecar (jeden proces, víc DB).
- Automatický úklid dat smazaného workspace z disku.
