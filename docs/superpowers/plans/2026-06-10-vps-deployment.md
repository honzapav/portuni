# VPS Deployment (api.portuni.com) Implementation Plan (2/4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. This plan mixes one code task with live-infra ops steps; ops steps run from the controller session (SSH to the VPS), not in subagents.

**Goal:** Portuni server běží na DigitalOcean utilities VPS za Caddy/TLS na `https://api.portuni.com`, připravený na google auth mode.

**Architecture:** Build lokálně, rsync `dist/` + manifesty do `/opt/portuni`, `npm ci --omit=dev` na serveru, systemd unit pod dedikovaným uživatelem, Caddy vhost s TLS, DNS A záznam přes Netlify API (zóna portuni.com = 69eaed44c2d6326de557db8b). Start v `PORTUNI_AUTH_MODE=env` se silným `PORTUNI_AUTH_TOKEN` (interim, stejný trust model jako dnes); přepnutí na google mode až budou Workspace credentials (admin checklist ve specu §6).

**Recon facts (2026-06-10):** VPS 64.226.121.79 (fra1, 2 GB), Caddy v systemd s vhostem tracker.mcp.tempo.ooo → 8787, Node v22.22.0, `/opt/<app>` konvence, žádný Docker. portuni.com NS = NS1 (Netlify DNS), Netlify CLI autentizovaný.

---

### Task 1: Rate limiter (code, subagent)

**Files:** Create `src/http/rate-limit.ts`, modify `src/http/server.ts` (wire before applyGates), test `test/http-rate-limit.test.ts`.

Per-token (bearer value hash, fallback per-IP) sliding-window limiter, default 240 req/min, env `PORTUNI_RATE_LIMIT_PER_MIN` (0 = disabled, default 0 v env mode / lokálu, deployment ho zapne). Při překročení 429 + `Retry-After`. TDD, in-memory, žádné závislosti.

### Task 2: Deploy script (code, subagent)

**Files:** Create `scripts/deploy-vps.sh` (committed). Kroky: `npm run qa` → rsync `dist/ package.json package-lock.json` na `root@64.226.121.79:/opt/portuni/` → `npm ci --omit=dev` na serveru → `systemctl restart portuni` → curl smoke `https://api.portuni.com/health`.

### Task 3: DNS (ops)

`netlify api createDnsRecord` na zóně `69eaed44c2d6326de557db8b`: A `api` → `64.226.121.79`, TTL 3600. Ověřit `dig +short api.portuni.com`.

### Task 4: Server provisioning (ops, idempotentní)

1. `useradd --system --home /opt/portuni portuni` (pokud neexistuje), `mkdir -p /opt/portuni`.
2. `/opt/portuni/portuni.env` (chmod 600, owner portuni): `PORT=4011`, `HOST=127.0.0.1`, `TURSO_URL=...`, `TURSO_AUTH_TOKEN=...` (z lokálního varlock env, nikdy nelogovat), `PORTUNI_AUTH_MODE=env`, `PORTUNI_AUTH_TOKEN=<openssl rand -base64 32>`, `PORTUNI_USER_EMAIL=honza@workflow.ooo`, `PORTUNI_USER_NAME=Honza Pav`, `PORTUNI_ALLOWED_HOSTS=api.portuni.com`, `PORTUNI_RATE_LIMIT_PER_MIN=240`. Google vars (`PORTUNI_GOOGLE_*`, `PORTUNI_JWT_SECRET`, `PORTUNI_GROUPS_*`, `PORTUNI_ALLOWED_DOMAIN=workflow.ooo`) předpřipravené zakomentované.
3. systemd unit `/etc/systemd/system/portuni.service`: `ExecStart=/usr/bin/node /opt/portuni/dist/index.js`, `EnvironmentFile=/opt/portuni/portuni.env`, `User=portuni`, `Restart=always`, `RestartSec=3`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadWritePaths=/opt/portuni`. `daemon-reload`, `enable`.
4. Caddy vhost append do `/etc/caddy/Caddyfile`: `api.portuni.com { reverse_proxy 127.0.0.1:4011 }`, `systemctl reload caddy`.

POZN: server čte Turso přímo (source of truth), žádná lokální replika. Mirrors/file-sync na serveru neběží (sync agent = plán 4); PORTUNI_WORKSPACE_ROOT není potřeba.

### Task 5: First deploy + smoke (ops)

`scripts/deploy-vps.sh`; pak: `curl https://api.portuni.com/health` → 200; `/mcp/info` → JSON `has_auth_token:true`; bez tokenu `/graph` → 401; s tokenem `/me` → solo admin identita; MCP initialize handshake přes curl → 200. Záznam výsledků do reportu.

### Task 6: Docs (code)

`docs/env-vars.md` + AGENTS.md gotcha (deploy: `scripts/deploy-vps.sh`, unit `portuni.service`, env na VPS `/opt/portuni/portuni.env`), commit.

**Blokované na uživateli (go-live google mode):** Workspace admin kroky ze specu §6 (DWD SA, OAuth client, skupiny) → pak naplnit google vars v `portuni.env`, `PORTUNI_AUTH_MODE=google`, restart.
