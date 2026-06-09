# Google OAuth + Workspace Groups – auth a access control (design)

> Status: design spec, ready for implementation plan. Authored 2026-06-09.
> Zachycuje brainstorm z aktuální session, aby čerstvý executor mohl
> pokračovat bez re-derivace konverzace. Navazuje na `docs/specs.md`
> → "Security model" (Phase 2 target) a `docs/auth-refactor-plan.md`
> (Phase A–C, shipped 2026-05-05).

## Cíl

Přechod z Phase 1.5 (sdílený Turso service token, jediný SOLO_USER,
enforcement žádný) na Phase 2: per-user identita přes Google OAuth,
oprávnění z Google Workspace Groups, reálně vynutitelný access control
na centrálním serveru. Cílový milník: týmový test s plným workflow
(desktop app + Claude Code v mirrorech) a s daty, která část týmu
nesmí vidět.

## Rozhodnutí z brainstormu

| Otázka | Rozhodnutí |
|---|---|
| Enforcement boundary | Centrální server – jediný drží Turso token; klienti přes HTTPS s per-user auth. Přímé libSQL z klientských strojů končí. |
| Granularita | Globální role (admin/manage/write/read) **i** node-level přístup (`visibility='group'` + `meta.access_group`) hned v prvním testu. |
| Workspace | Jedna doména, admin přístup k dispozici (DWD service account + správa skupin). |
| Klienti | Plný workflow: desktop app i agenti (remote MCP), lokální sync agent pro mirrors/file sync. |
| Hosting | DigitalOcean `utilities` VPS (fra1, 64.226.121.79), doména `api.portuni.com`. |
| Group visibility sémantika | Ne-člen node **nevidí vůbec** (mizí z list/search/context/get). Admin vidí vše. Read-only fallback ze specs.md:203 se ruší – skrývání by de facto popřel. |
| MCP auth pro agenty | Minted per-user per-device tokeny (revokovatelné, hashované na serveru). Plný MCP OAuth flow = pozdější upgrade. |
| Offline desktop | Pro test obětováno (žádná embedded replica u klientů). |
| Externí uživatelé | Mimo rozsah testu. Google-account externisté půjdou později přes externí členství ve skupinách (Directory API je vrací); ne-Google externisté přes budoucí adaptér. Design jim nesmí bránit. |

## 1. Topologie

```
┌──────────────────────── utilities VPS (DO, fra1) ───────────────────────┐
│  Caddy/nginx (TLS, api.portuni.com)                                     │
│     │                                                                   │
│  Portuni server (Node) – REST + MCP Streamable HTTP                     │
│     ├─ identity middleware (IdentityAdapter)                            │
│     ├─ enforcement vrstva (globální role + node-level groups)           │
│     └─ libSQL klient → Turso  (jediný držitel tokenu)                   │
└──────────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                        ▲
        │ HTTPS + user JWT   │ HTTPS + user JWT       │ HTTPS + device token
┌───────┴────────┐  ┌────────┴─────────┐  ┌───────────┴──────────┐
│ Desktop webview │  │ lokální sync     │  │ Claude Code v mirroru │
│ (api_request →  │  │ agent (mirrors + │  │ (.mcp.json → remote   │
│  central URL)   │  │ file sync; graf  │  │  MCP URL + token)     │
│                 │  │ přes REST)       │  │                       │
└─────────────────┘  └──────────────────┘  └───────────────────────┘
```

- Sdílené Turso tokeny u teammates se po migraci **revokují**.
- Session scope (`src/mcp/scope.ts`) zůstává ortogonální vrstvou nad
  permissions, beze změny (viz docs-site scope-enforcement.md:139).

## 2. Identity adapter vrstva

Backend zná jen rozhraní:

```ts
interface IdentityAdapter {
  // Ověř IdP credential (u Googlu ID token) → identita. Portuni session
  // JWT a device tokeny ověřuje server core, ne adaptér.
  verify(credential: string): Promise<{ email: string; name: string; sub: string }>;
  // Vyhodnoť oprávnění pro identitu.
  resolveAccess(email: string): Promise<{ globalScope: GlobalScope; groups: string[] }>;
}
```

Implementace:

- **GoogleAdapter** (první/kanonický):
  - Login: OAuth 2.0 authorization code + PKCE přes systémový prohlížeč;
    loopback redirect chytá Rust host, refresh token jde do Keychainu
    (vzor z auth-refactor: žádný secret ve webview JS, žádný plaintext
    na disku).
  - `verify`: OIDC ověření Google ID tokenu (issuer, audience, podpis).
  - `resolveAccess`: Admin SDK Directory API `groups.list(userKey=email)`
    přes service account s domain-wide delegation, scope
    `admin.directory.group.readonly`. Cache 15 min (in-memory).
- **EnvAdapter** (dev/local): identita z env (`PORTUNI_USER_EMAIL` /
  `PORTUNI_USER_NAME`), plný admin. Dnešní lokální vývoj na 4011 jede
  dál bez Googlu a zároveň ověřuje, že rozhraní není fikce.
- Budoucí: Microsoft/Okta/SAML adaptér, allowlist adaptér pro ne-Google
  externisty. Enforcement vrstva pracuje jen s výsledkem `resolveAccess`.

Session tokeny: server po loginu vydává krátkožijící Portuni JWT
(identita + globalScope + groups), klient ho tiše obnovuje přes refresh
token. Skupiny se přepočítají nejpozději po 15 min.

### Auth pro agenty (MCP)

- Desktop app po Google loginu umí vymintovat **device token**
  (per-user, per-device, label, expirace, revokace). Server ukládá jen
  hash.
- `portuni_mirror` regeneruje `.mcp.json` s remote MCP URL
  (`https://api.portuni.com/mcp?...`) a device tokenem.
- Plný MCP OAuth (Claude Code ho podporuje) je pozdější aditivní upgrade.

## 3. Autorizační model

### Globální role

Mapování skupin → role je konfigurace serveru (env/config, ne DB):

| Google Group | Role |
|---|---|
| portuni-admins@<doména> | admin |
| portuni-managers@<doména> | manage |
| portuni-team@<doména> | write |
| (kdokoli ověřený v doméně) | read |

Nejvyšší vyhrává. Každý MCP tool a REST route deklaruje minimální roli
(tabulka v kódu dle specs.md:177–182: read = get/search/list, write =
log/resolve/supersede/store, manage = create/connect/update, admin =
vše + správa).

### Node-level (group visibility)

- `nodes.visibility` rozšířeno o `'group'`; skupina v
  `meta.access_group` (e-mail skupiny).
- **Dědičnost po `belongs_to` řetězu**: node bez vlastního
  `access_group` zdědí omezení nejbližšího omezeného předka. (Org
  invariant zaručuje právě jeden scoping parent, takže řetěz je
  jednoznačný.)
- **Sémantika: ne-člen node nevidí vůbec** – node mizí z `list_nodes`,
  search, `get_context`, `get_node` vrací not_found-ekvivalent, edges
  na něj se nefiltrují do odpovědí. Admin vidí vše. Toto je vědomá
  odchylka od specs.md:203 (read-only fallback) – specs.md po
  implementaci aktualizovat.
- Write na group node: člen skupiny s globální rolí ≥ write.

### Vynucovací body

- Rozšířený `guardNodeRead` (visibility=group + dědičnost vedle
  stávajících hard floors private/scope_sensitive).
- Filtry v list/search/context (set viditelných node IDs per session,
  cache per group-membership snapshot).
- Write guard před každou mutací (role + node-level).
- Vše audituje do existujícího audit logu se skutečným `user_id`.

## 4. Schéma a migrace

- **users**: + `google_sub` (unikátní), `avatar_url`, `last_login_at`.
  Migrace: při prvním loginu s e-mailem == stávající SOLO_USER e-mail
  se obohatí existující řádek (historie zůstane připsaná), jinak se
  založí nový.
- **nodes**: CHECK constraint na `visibility` += `'group'`.
- **device_tokens** (nová): `id`, `user_id`, `label`, `token_hash`,
  `created_at`, `expires_at`, `revoked_at`, `last_used_at`.
- Skupinová cache in-memory (žádná tabulka).

## 5. Desktop + sync agent

- **Login UX**: první spuštění → "Přihlásit přes Google" (nahrazuje
  Turso-token modal pro teammates). PKCE flow viz §2.
- **User info v nastavení**: avatar, jméno, e-mail, vyhodnocená globální
  role, projektové skupiny, odhlášení, správa device tokenů
  (seznam/revokace). Data z nového `GET /me`.
- **`api_request`**: base URL z config.json (`server_url`, non-secret),
  default `https://api.portuni.com`; injektuje user JWT z Keychainu.
- **Sync agent** (zmenšený sidecar): mirrors + file sync lokálně,
  metadata grafu přes REST se stejným tokenem. Per-device sync.db
  zůstává.
- **Drive sync**: pro test beze změny (Service Account). Obsah souborů
  na Drive řídí Drive ACL, ne Portuni skupiny. Per-user Drive OAuth =
  pozdější fáze.

## 6. Deployment, testy, mezery

- **Deployment**: Docker kontejner (nebo systemd unit) na utilities
  VPS za Caddy/nginx s TLS; DNS pro `api.portuni.com` přes doctl,
  pokud je zóna na DO. Stav stroje ověřit při implementaci (SSH v
  brainstormu nebyl k dispozici).
- **Rate limiting**: hrubý per-token limiter na HTTP vrstvě.
- **Testy**: enforcement matice jako unit testy s fake adapterem
  (role × akce; group visibility × členství; dědičnost po
  `belongs_to`; hard floors zůstávají). Integrační smoke: login →
  tool call → audit záznam se správným user_id.
- **Admin checklist (Google Workspace, mimo kód)**:
  1. Service account + klíč, povolit Admin SDK API.
  2. Domain-wide delegation pro scope
     `https://www.googleapis.com/auth/admin.directory.group.readonly`,
     určit impersonovaného admina.
  3. OAuth client (Desktop type) pro PKCE login flow.
  4. Založit skupiny: portuni-admins@, portuni-managers@,
     portuni-team@ + projektové skupiny dle potřeby testu.
- **Vědomě odloženo**: offline režim desktopu; gating obsahu souborů
  Portuni skupinami; ne-Google externisté; plný MCP OAuth; multi-org;
  rotace Turso tokenu.

## Otevřené body pro implementační plán

- Pořadí landingu: (1) server-side identity + enforcement + EnvAdapter
  + testy, (2) deployment na VPS, (3) desktop login + user info +
  device tokens, (4) sync agent přepojení na REST, (5) mirror regen na
  remote MCP, (6) revokace sdílených Turso tokenů + aktualizace
  specs.md a docs-site.
- REST API dnes nepokrývá nutně všechno, co sync agent potřebuje –
  inventura endpointů je úkol plánu, ne designu.
