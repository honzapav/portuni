# Runbook: sdílení Portuni s týmem (auth + distribuce)

> Autor: 2026-07-03. Cíl: přepnout produkci z solo (`env`) na `google` mód a
> onboardit teammates v `central` režimu. Kód je hotový a v `main`
> (auth vrstva `apps/server/auth/`, central mód desktopu, central file-content
> `file-content-remote.ts`). Chybí **admin/ops kroky**, ne vývoj.
>
> Navazuje na spec `2026-06-09-google-groups-auth-design.md` §6 a plán
> `2026-06-10-central-cutover.md`. Zdroj proměnných: `docs/env-vars.md`.

## Konstanty (zjištěné z prostředí)

| Věc | Hodnota |
|---|---|
| Doména | `workflow.ooo` |
| Impersonovaný admin (DWD) | `honza@workflow.ooo` |
| DWD scope | `https://www.googleapis.com/auth/admin.directory.group.readonly` |
| Skupiny | `portuni-admins@`, `portuni-managers@`, `portuni-team@workflow.ooo` |
| Drive SA (krok 3) | `portuni-sync@portuni-sync-test-89642.iam.gserviceaccount.com` |
| Drive remote name | `tempo-drive` → env `PORTUNI_REMOTE_TEMPO_DRIVE__SERVICE_ACCOUNT_JSON` |
| VPS | `root@64.226.121.79`, `/opt/portuni/portuni.env`, unit `portuni` |
| Central server URL | `https://api.portuni.com` |
| Teammate config | `~/Library/Application Support/ooo.workflow.portuni/config.json` |

## Prostředí (zjištěno)

- Org: `tempo.ooo` (ID `480394102423`, customer `C039k2u20`). `workflow.ooo` je
  sekundární doména téhož Workspace účtu.
- GCP projekt pro auth: **`portuni-auth`** (nový, pod org tempo.ooo, bez billingu
  — Admin SDK + Cloud Identity ho nepotřebují).
- Billing (jediný dostupný): `honzapav.com` (`01C455-76D34A-464AF0`) — osobní.

---

## Krok 1 — Google Workspace / Cloud (blokuje vše)

### HOTOVO přes gcloud (2026-07-03)

- ✅ Projekt `portuni-auth` založen pod org 480394102423.
- ✅ API zapnutá: `admin.googleapis.com`, `cloudidentity.googleapis.com`,
  `iamcredentials.googleapis.com`, `cloudresourcemanager.googleapis.com`.
- ✅ DWD service account: `portuni-groups@portuni-auth.iam.gserviceaccount.com`.
  Klíč: `~/.portuni-secrets/portuni-groups-key.json` (mode 600, netisknout).
- ✅ **oauth2ClientId (pro DWD autorizaci v 1c): `101296651075942446089`**
- ✅ Skupiny založené (Cloud Identity, security+discussion):
  `portuni-admins@`, `portuni-managers@`, `portuni-team@workflow.ooo`.
  `honza@workflow.ooo` přidán do `portuni-admins`.

### ZBÝVÁ RUČNĚ (konzole)

#### 1c. Domain-wide delegation — **ADMIN KONZOLE**

admin.google.com → Security → Access and data control → API controls →
Domain-wide Delegation → Add new:
- **Client ID**: `101296651075942446089`
- **OAuth scopes**: `https://www.googleapis.com/auth/admin.directory.group.readonly`

#### 1d. OAuth client (Desktop) — **CLOUD CONSOLE**

console.cloud.google.com (projekt `portuni-auth`) → APIs & Services →
nejdřív **OAuth consent screen** (Internal, název „Portuni") → pak Credentials →
Create credentials → OAuth client ID → Application type **Desktop app** →
„Portuni Desktop". Ulož **Client ID**. Jde do:
- teammate `config.json` → `google_client_id`
- VPS `PORTUNI_GOOGLE_CLIENT_IDS`

---

## Krok 2 — Zapnout google mód na VPS (SENSITIVE, dělat s Honzou)

Šablona google sekce `portuni.env` (doplnit hodnoty z kroku 1):

```dotenv
# --- google mode ---
PORTUNI_AUTH_MODE=google
PORTUNI_JWT_SECRET=<openssl rand -base64 48>
PORTUNI_GOOGLE_CLIENT_IDS=<Desktop OAuth Client ID z 1d>
PORTUNI_ALLOWED_DOMAIN=workflow.ooo
PORTUNI_GOOGLE_SA_KEY_JSON=<obsah ~/.portuni-secrets/portuni-groups-key.json jako jeden řádek>
PORTUNI_GOOGLE_IMPERSONATE=honza@workflow.ooo
PORTUNI_GROUPS_ADMIN=portuni-admins@workflow.ooo
PORTUNI_GROUPS_MANAGE=portuni-managers@workflow.ooo
PORTUNI_GROUPS_WRITE=portuni-team@workflow.ooo
```

```bash
# na VPS:
ssh root@64.226.121.79
# uprav /opt/portuni/portuni.env (viz výše), pak:
systemctl restart portuni
# ověř:
curl -s https://api.portuni.com/health          # ok
# z desktop appky: Nastavení → Účet → Přihlásit přes Google → GET /me vrací roli+skupiny
```

**Rollback**: vrať `PORTUNI_AUTH_MODE=env` + `systemctl restart portuni`.

## Krok 3 — Drive SA secret na VPS (po kroku 2)

Umožní central-mode file content. Potřebuje klíč **Drive** SA (`portuni-sync`),
ne DWD SA:

```bash
gcloud iam service-accounts keys create /tmp/portuni-sync-key.json \
  --iam-account portuni-sync@portuni-sync-test-89642.iam.gserviceaccount.com
# na VPS do portuni.env (jeden řádek):
# PORTUNI_REMOTE_TEMPO_DRIVE__SERVICE_ACCOUNT_JSON=<obsah portuni-sync-key.json>
systemctl restart portuni
```

Ověření: SKIP-gated central e2e test se spustí, jakmile je Drive SA env
přítomný (real central read+edit Drive souboru).

## Krok 4 — Distribuce Portuni.app

- Build hotový: `apps/desktop/target/release/bundle/dmg/Portuni_0.1.0_aarch64.dmg`.
- **Gap: build není podepsaný/notarizovaný.** Na cizím Macu Gatekeeper hlásí
  „neznámý vývojář". Řešení:
  - rychlé (pro pár lidí): `xattr -dr com.apple.quarantine /Applications/Portuni.app`
    po instalaci, nebo pravý klik → Otevřít.
  - správné (na šíření): Developer ID podpis + notarizace
    (`codesign --deep --sign "Developer ID Application: ..."` + `notarytool`).
    Vyžaduje Apple Developer účet.

## Krok 5 — Onboard teammate (po 2–4)

1. Přidat do Google skupiny (`portuni-team@workflow.ooo` apod.).
2. Nainstalovat `Portuni.app`.
3. Vytvořit `~/Library/Application Support/ooo.workflow.portuni/config.json`:

```json
{
  "server_url": "https://api.portuni.com",
  "google_client_id": "<Desktop OAuth Client ID z 1d>",
  "google_client_secret": "<Client secret z 1d (GOCSPX-…)>",
  "data_mode": "central"
}
```

Pozn.: `google_client_secret` je u installed-app klienta nutný pro token
exchange (Google ho vyžaduje i s PKCE), ale není to reálné tajemství —
distribuuje se s každou instalací. Bez přihlášení appka zobrazí login
obrazovku (CentralLoginGate), ne graf.

4. Spustit app → Nastavení → Účet → Přihlásit přes Google.
5. Agenti: tlačítko instalace MCP zapíše central URL; terminály dostanou device
   token automaticky.

Pozn. (aktualizace 2026-07-03 večer): teammate v central režimu **má lokální
mirrory** — sidecar běží jako sync agent (watcher, sync, mirror složky na
disku), graf i bajty jdou přes server s device tokenem. Implementace:
`docs/superpowers/plans/2026-07-03-teammate-mirrors.md`, E2E ověřeno
(`scripts/e2e/teammate-mirrors.sh`). **Funguje proti api.portuni.com až po
deployi aktuálního main** (nasazený dist nemá sync-info/register/base64
endpointy ani central file content).

## Krok 6 — Po migraci

- **Revokovat sdílené Turso tokeny** (spec §6): teammates už chodí přes server,
  přímý libSQL z klientů končí.
- Aktualizovat `docs/specs.md` (group visibility mění read-only fallback).

## Pojistky (hotovo)

- **Turso denní backup na VPS** (always-on): `/opt/portuni/backup-turso.sh` +
  systemd `portuni-backup.timer` (04:00 UTC, rotace lokálně 30 dní,
  `/var/backups/portuni/`). Dump přes libSQL `/dump` endpoint (curl + token
  z `portuni.env`, žádný turso CLI). Ověřeno end-to-end (Result=success).
- **Offsite do GCS**: upload přes rclone do
  `gs://worfklowdb-backup/portuni/portuni_YYYY-MM-DD_HHMM.sql.gz` (sdílený
  DB-backup bucket, projekt `infrastructure-489410`, EUROPE-WEST3, konvence
  jako ostatní DB). Uploader SA `worflowdb-backup-user@infrastructure-489410`,
  klíč na VPS `/opt/portuni/gcs-backup-sa.json` (mode 600). GCS selhání = exit 2
  (systemd unit failed), lokální kopie se zachová.
- **Monitoring**: UptimeRobot heartbeat (interval 1 den). Skript pingne heartbeat
  URL až po úspěšném dumpu i GCS uploadu; chybějící ping = alert.
- Turso Cloud PITR běží automaticky (obnova: `turso db create X --from-db portuni --timestamp ...`).
- Lokální `scripts/backup-turso.sh` (varlock) zůstává jako manuální/offline nástroj
  na Macu — už není naplánovaný (launchd zrušen).
- **Pozn.**: bucket nemá lifecycle na `portuni/` prefix; objekty se hromadí
  (~280 KB/den, zanedbatelné). Případný cleanup přidat později.
