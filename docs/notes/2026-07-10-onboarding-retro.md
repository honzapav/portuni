# Portuni – retrospektiva prvního onboardingu teammate

**Datum:** 2026-07-10
**Kdo:** onboarding Lukáše (interní účet, doména workflow.ooo) do central módu
**Cíl session:** dostat teammate k datům a souborům, aniž bychom sdíleli Turso URL + token

---

## Průběh v kostce

Zadání „jak pustit teammate bez Turso creds" postupně odhalilo řetěz překážek:
central mód sice existuje a je nasazený, ale **onboarding do něj není self-serve** →
ruční editace `config.json` → chyba v Google OAuth → po opravě selhával **pull souborů** →
po rozjetí pullu vyplul **chybějící model sdílení na Google Drive UI**. Nakonec:
login funguje, soubory se materializují na disk (přes spuštění terminálu), zbývá
Drive-sharing integrace (samostatný úkol).

---

## Co šlo dobře

- **Central architektura je reálně hotová a nasazená.** `api.portuni.com` běží, device
  tokeny, agent mód, mirror-less Drive-direct file content — vše shipnuté, ne jen návrh.
- **VPS byl správně nakonfigurovaný** pro file-bytes plane: `PORTUNI_TOKEN_STORE=varlock`
  + `PORTUNI_REMOTE_TEMPO_DRIVE__SERVICE_ACCOUNT_JSON` + `PORTUNI_AUTH_MODE=google`.
  Nemuseli jsme na serveru nic měnit.
- **Diagnostika přes server log zabránila zbytečnému zásahu.** Hypotéza „chybí SA
  credential na VPS" (moje i tvoje) byla mylná — ověření v `/opt/portuni/portuni.env`
  a v `journalctl` ukázalo, že credential tam je a chyby v logu jsou staré (před opravou
  na varlock 5. 7.). Nesahali jsme do funkčního serveru.
- **Jakmile se opravil OAuth, zbytek zapadl:** login prošel, spuštění terminálu
  zmaterializovalo mirror a pull začal doručovat soubory na disk.

## Co šlo špatně / třecí plochy

1. **Žádný self-serve onboarding pro central mód.** Fresh-install wizard ve v0.4.0
   (`TursoSetupGate`) nabízí jen dvě cesty: „Připojit se k Turso organizaci" (URL + token)
   nebo „Začít lokálně". Central mód se musí naseedovat **ručně** předvyplněným
   `config.json` mimo UI. To je jádro problému — běžný uživatel to sám nezvládne.
2. **Placeholder v config.json se odeslal Googlu doslova.** Vzorový `config.json` obsahoval
   `"google_client_id": "<workspace-oauth-client-id>"`; zkopíroval se i s `<...>` →
   Google vrátil `invalid_request` / „doesn't comply with OAuth policy". Příčina byla vidět
   až v URL (`client_id=%3Cworkspace-oauth-client-id%3E`).
3. **Google OAuth setup je bolestivý a neintuitivní:**
   - Test users se schovávají pod **Audience**; **Internal** aplikace je nemají vůbec.
   - Klient musí být typu **Desktop app** kvůli náhodnému loopback portu; Web app →
     `redirect_uri_mismatch`.
   - Nová Google konzole **plný client_secret po vytvoření znovu neukáže** (jen poslední
     4 znaky) → nutnost „Add secret", který je navíc neaktivní kvůli limitu (musí se
     nejdřív smazat starý).
4. **Materializace souborů na disk je schovaná za „spusť terminál".** Že teammate musí
   pustit terminál, aby měl soubory fyzicky na disku, není nikde vidět — pro netechnického
   uživatele neintuitivní.
5. **Sdílení na Google Drive UI vůbec není řešené.** Node-access ACL v Portuni je jiný
   systém než Drive sharing; teammate se do Drive UI nedostane. Navíc chybí per-node
   read/write model (viz samostatný úkol).
6. **Celý onboarding vyžadoval devs u stolu** — ruční `config.json`, práce v Google Cloud
   konzoli, přístup na VPS. Nic z toho není přenositelné na běžného uživatele „na dálku".

## Na co si dát pozor (gotchas do dokumentace)

- **Placeholdery ve vzorových configech jsou past** — pošlou se doslova a chyba je matoucí.
  Klíč hledej v URL: `client_id=<...>`.
- **OAuth client MUSÍ být Desktop app** (loopback random port). Web app → `redirect_uri_mismatch`.
- **Google nová konzole neukáže plný secret znovu** — „Add secret" (limit → smazat starý).
- **Consent screen Internal = žádné test users.** External + Testing → přidat test usera;
  interní uživatel test-user limit obchází úplně.
- **VPS file-bytes plane potřebuje** `PORTUNI_TOKEN_STORE=varlock` +
  `PORTUNI_REMOTE_<NAME>__SERVICE_ACCOUNT_JSON`. Chyba
  „PORTUNI_WORKSPACE_ROOT must be set for FileTokenStore" = špatný token store.
- **Server-side login potřebuje client_id v `PORTUNI_GOOGLE_CLIENT_IDS`** na VPS, jinak
  odmítne token (špatná audience) i po úspěšném prohlížečovém loginu.
- **Log serveru je zdroj pravdy** — nehádat příčinu, ověřit (`journalctl -u portuni`).

## Co vylepšit (návrhy, seřazené podle dopadu)

1. **Central cesta ve fresh-install wizardu.** Třetí volba „Přihlásit se účtem": zadá se
   (nebo je default `api.portuni.com`) `server_url`, zbytek přes Google login. Žádná ruční
   editace `config.json`. → jediná reálná překážka self-serve onboardingu.
2. **Server-served OAuth config.** Appka si stáhne `google_client_id` z
   `{server}/public-config`; nikdy se needituje ručně, a je to **multi-org ready**
   (organizace = `server_url`, jeden generický build). Volitelně **server-brokered token
   exchange** → `client_secret` žije jen na serveru, nikdy v klientu ani buildu.
3. **Explicitní akce „Stáhnout na disk / Mirror"** v UI, ať materializace nezávisí na tom,
   že uživatel pustí terminál.
4. **Onboarding checklist / dokumentace pro Google OAuth setup** (Desktop app, consent
   screen, test users, secret) — jednorázová dev činnost, ale bez návodu bolestivá.
5. **Portuni → Drive permission sync** (samostatný Asana úkol): per-node role read/write
   zrcadlená do Google Drive sharing přes Service Account.
6. **Invite flow v UI.** Endpoint `POST /auth/users/invite` + `SettingsPage.users.tsx` už
   existují — zpřístupnit adminovi jako standardní součást onboardingu (pozvat e-mailem →
   grant node-access).

## Zbývající kroky pro Lukáše konkrétně

- **Zápis zpět:** Lukáš je zatím `read` (globální scope z group membership). Pro editaci
  a push ho přidat do write-skupiny (`PORTUNI_GROUPS_WRITE` na VPS).
- **Drive UI přístup:** čeká na Drive-sharing integraci (samostatný úkol).
