# Central Cutover Implementation Plan (4/4 — fáze A)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Teammate v režimu `data_mode=central` pracuje s grafem výhradně přes `https://api.portuni.com` (vynucená práva), agenty připojuje na central MCP s device tokenem. Owner zůstává v `local` režimu beze změny.

**Architecture:** `DesktopConfig.data_mode: "local" (default) | "central"`. V central režimu `api_request` směruje na `server_url` s user JWT (reuse `central_request` plumbing, tichý refresh); LOCAL_ONLY cesty (mirror/sync/file-content/write-scope/sandbox) vrací 501 `{error:"local_only"}` a UI je skryje. `install_claude_global` v central režimu zapíše central MCP URL; `PORTUNI_MCP_TOKEN` pro terminály = device token (mintnutý přes central, uložený v Keychain pod `portuni_device_token`). Sidecar se v central režimu nespouští.

**Fáze B (samostatná session, mimo tento plán):** REST-ifikace sync enginu (mirrors/file sync pro teammates) — viz spec §5; rozsah srovnatelný s plánem 1. Revokace sdílených Turso tokenů až po reálné migraci teammates (user action).

### Task 1 (Rust): data_mode + api_request routing

`DesktopConfig.data_mode` (serde default "local"). V `api_request`: central režim → LOCAL_ONLY prefix check (`/write-scope`, `/sandbox-profile`, `/positions`? ne — positions je graf; přesný seznam: `/write-scope`, `/sandbox-profile`, cesty obsahující `/mirror`, `/sync-status`, `/sync`, `/file` content, `/folder-url` zůstává central — server ho má) → 501 local_only; jinak `do_central_request` (JWT+refresh). Local režim beze změny. Sidecar spawn: přeskočit v central režimu. Command `get_data_mode() -> {mode, server_url}`. `cargo check` + unit testy prefix matcheru.

### Task 2 (Rust): agenti v central režimu

`install_claude_global` (najít v lib.rs): v central režimu zapíše do `~/.claude.json` central `{server_url}/mcp` URL + `${PORTUNI_MCP_TOKEN:-}` referenci (stejný vzor jako mirror configy). Terminal spawn env: v central režimu `PORTUNI_MCP_TOKEN` = device token z Keychain (`portuni_device_token`); pokud chybí, mint přes central (`POST /device-tokens`, label "Desktop terminály") a ulož. `cargo check`.

### Task 3 (React): UI adaptace

`get_data_mode` wrapper; v central režimu skrýt mirror/sync/local-workspace affordance (najít komponenty volající mirror/sync endpointy) a u 501 local_only ukázat decentní hlášku "Dostupné jen v lokálním režimu (fáze B)". Settings → Účet: zobrazit aktivní režim. `tsc --noEmit` + `npm --prefix app run build`.

### Task 4: docs + qa

AGENTS.md (data_mode gotcha, jak nastavit teammate desktop: server_url+google_client_id+data_mode=central), `npm run qa`, merge.
