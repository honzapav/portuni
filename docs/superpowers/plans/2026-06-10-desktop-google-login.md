# Desktop Google Login + Account UI Implementation Plan (3/4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Worktree execution; Rust changes need `cargo check` (full `cargo tauri build` jen na závěr, mimo subagenty).

**Goal:** Desktop umí Google login (PKCE přes systémový prohlížeč), ukazuje přihlášeného uživatele v nastavení a spravuje device tokeny — vše proti centrálnímu serveru `https://api.portuni.com`.

**Architecture:** Identity onboarding běží proti centrálnímu serveru; graf data jedou DÁL přes lokální sidecar (cutover = plán 4). Rust host drží PKCE flow, refresh token i session JWT v Keychain (vzor auth-refactor: žádný secret ve webview). Nový Tauri command `central_request` zrcadlí `api_request`, ale míří na `server_url` s user JWT a tichým refreshem. React přidá sekci „Účet" do Nastavení.

**Tech Stack:** Tauri 2 (Rust: tiny-http nebo std TcpListener pro loopback callback, keyring, reqwest), React/Vite, central REST (/auth/login, /me, /device-tokens).

**Blokováno na uživateli (E2E):** Google OAuth client (Desktop type) z Workspace admin checklistu (spec §6) — `google_client_id` v configu + `PORTUNI_GOOGLE_CLIENT_IDS`/google mode na serveru. Kód se píše a testuje s mocky; E2E až po dodání client ID.

---

### Task 1: Desktop config + auth commands (Rust)

**Files:** `src-tauri/src/lib.rs` (nebo nový `src-tauri/src/auth.rs`), `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`.

- `DesktopConfig` += `server_url: Option<String>`, `google_client_id: Option<String>` (non-secret, config.json).
- Keychain účty (service `ooo.workflow.portuni`): `google_refresh_token`, `portuni_session_jwt`.
- Commands:
  - `auth_status() -> { configured: bool, logged_in: bool, user: Option<UserInfo> }` — configured = server_url+client_id set; logged_in = JWT v keychain (+ /me ověření lazy ve webview).
  - `google_login() -> UserInfo` — PKCE: verifier/challenge S256, loopback `127.0.0.1:<ephemeral>/callback`, otevřít systémový prohlížeč (`tauri-plugin-opener`/existing pattern — viz jak app otevírá externí linky), scope `openid email profile`, `access_type=offline prompt=consent` (refresh token), výměna kódu na token endpointu (reqwest), POST `{server_url}/auth/login` s id_token → `{token, user}`; uložit refresh_token + JWT do Keychain; vrátit user.
  - `auth_refresh() -> UserInfo` — refresh_token → nový id_token → /auth/login → nový JWT.
  - `auth_logout()` — smazat oba Keychain záznamy.
- Registrace v invoke_handler + capabilities.

Test: `cargo check` + unit test PKCE helperu (verifier→challenge S256 known vector) `cargo test`.

### Task 2: central_request command (Rust)

**Files:** `src-tauri/src/lib.rs`/`auth.rs`.

`central_request(method, path, body) -> { status, body }` — base `server_url`, `Authorization: Bearer <JWT z Keychain>`; při 401 jednou `auth_refresh()` a retry; bez JWT → error "not logged in". Zrcadlí tvar `api_request` (webview-kompatibilní). `cargo check`.

### Task 3: Settings → Účet (React)

**Files:** `app/src/components/Settings*.tsx` (najít stávající settings strukturu — multi-session workspace spec přesunul Nastavení s podsekcemi), nový `app/src/components/AccountSection.tsx`, `app/src/lib/central.ts` (wrapper na invoke central_request / auth_* commands).

- Nepřihlášen + configured: tlačítko „Přihlásit přes Google" → `google_login` → zobrazit kartu.
- Nepřihlášen + neconfigured: info „Centrální server není nakonfigurován" + jak doplnit config.json.
- Přihlášen: avatar, jméno, e-mail, globální role, skupiny (GET /me přes central_request), „Odhlásit".
- Device tokeny: tabulka (label, vytvořen, poslední použití, expirace, revoked), „Nový token" (label input → POST → plaintext zobrazit JEDNOU s tlačítkem kopírovat + varování), „Revokovat" per řádek.
- Česky s diakritikou, žádné emoji. Stav přes existující UI vzory (najít, jak app dělá fetch/notifikace).

Test: `npm --prefix app run build` (tsc + vite) zelený; pokud má app testy, doplnit smoke na AccountSection render.

### Task 4: QA + docs

- `npm run qa` (server části nedotčeny — musí zůstat zelené), `cargo check`, `npm --prefix app run build`.
- AGENTS.md: jak nakonfigurovat desktop pro central server (server_url, google_client_id) + že E2E login čeká na OAuth client.
- Commit po každém tasku.

### Out of scope (plán 4)

Cutover `api_request` na central, sidecar jako sync agent, mirror regen s device tokeny, revokace sdílených Turso tokenů.
