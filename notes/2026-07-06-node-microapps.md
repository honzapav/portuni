# Node micro-apps / generativní UI — shrnutí diskuze (2026-07-06)

## Otázka
Spouštět u každé node server a v něm malé React appky (lokální / online)?
Cíl: ad-hoc UI a mikroappky per node — workflow, kontrola, schvalování.

## Závěr
**Ne server per node.** Vzor, na který konvergovali Anthropic i OpenAI:
klientský widget v **izolovaném (cross-origin) iframu**, který nemá žádnou
ambient authority — každou citlivou schopnost volá přes **host-mediovaný
bridge**, kde host injektuje auth a vynucuje policy.

- **Anthropic Artifacts:** statická self-contained stránka, `*.claudeusercontent.com`
  origin, strict CSP blokuje veškerý egress. Backend přes proxovanou schopnost
  (`window.claude.*`).
- **OpenAI Apps SDK:** widget v iframu, `window.openai`, komunikace s hostem
  přes MCP Apps bridge (JSON-RPC přes postMessage). Backend = MCP nástroje.
- **Sandbox (Codex / Anthropic sandbox-runtime / Portuni):** stejný OS primitiv
  — Seatbelt (macOS) / Landlock+seccomp | bubblewrap (Linux). Klíč: **síť jen
  přes proxy**, defaultně zavřená. Portuni má dnes `(allow default)` pro síť —
  díra, pokud by u node běžel generovaný kód.

## Jak to sedí na Portuni
Skoro celý základ existuje: MCP server + nástroje, auth injekce (Tauri
`api_request`), **SessionScope jako permission model zdarma** (widget u node X
dědí scope té node). Chybí: bridge `window.portuni.*` + cross-origin iframe
(dnes same-doc srcDoc / `portuni-html://`).

## Bohatší appky (stav + síť)
- **Perzistence:** SQLite jako synchronizovaný soubor se **nedá kolaborativně
  mergovat** (binárka, konflikt/clobber) — proto workflow stav ukládat jako
  **řádky ve sdílené rovině (Turso)** = `app_data` per node, přes server, ne raw
  Turso creds v appce. Workflow/approval = append-only events + audit (Portuni
  má `events`/`audit_log`).
- **Web download:** nefetchovat z iframu (CORS + exfil kanál) → **host proxy**
  (`window.portuni.fetch`), allowlist, log.
- **Náklad:** ne per-node procesy/kontejnery, ale 3 featury na jednom serveru:
  bridge + `app_data` API + fetch proxy. Per node = jen widget soubor + namespace.

## Tiering
- **Tier 1 / 1.5** (doporučeno): widget v izolovaném iframu + host API.
  Pokryje viewer, generativní UI i workflow/approval třídu.
- **Tier 2** (jen když nutné): skutečný per-node runtime přes
  `@anthropic-ai/sandbox-runtime` s network jailem — dlouhoběžící úlohy,
  runtime deps, heavy compute, arbitrary SQL.

## Oprava faktu z diskuze
Central-mode **file content Phase B JE postavená a zadrátovaná**
(`file-content-remote.ts` B1+B2+B3; dispatch v `api/files.ts`; proxy gate v
`lib.rs` ji propouští na central). Stale je jen hlavička
`docs/architecture/central-file-content-phase-b.md` („Status: not started").
