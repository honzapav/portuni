# Postgres cutover runbook

Batch B of `docs/superpowers/plans/2026-09-12-infra-batch.md`: central
leaves Turso for managed Postgres, and each local workspace leaves its
SQLite for embedded PGlite. This is a one-off data migration per database
(central once; each local workspace once, whenever its owner updates), not
part of the ordinary release flow (`docs/release-process.md`).

Order matters: this cutover (B5, `scripts/db-export.ts`/`scripts/db-import.ts`)
lands and is exercised **before** B4 removes libsql from the codebase
entirely, specifically so the rollback below still works. Do not attempt
this runbook against a build that has already dropped the libsql driver.

## Central: Turso → managed Postgres

Prerequisites: a managed Postgres instance reachable from the VPS (Tempo),
its connection string, and SSH access to the VPS
(`docs/superpowers/plans/2026-06-10-vps-deployment.md`).

1. **Stop the server.** `ssh $VPS_HOST systemctl stop portuni` — no writes
   land on Turso while the export is in flight; a write that lands after
   the export but before the cutover is live is simply lost.
2. **Back up Turso first regardless** (the existing safety net,
   `docs/lessons-learned.md` §7 / `scripts/backup-turso.ts` —
   `deploy-vps.sh` already runs this before every migrating deploy; run it
   by hand here too since this is not going through `deploy-vps.sh`):
   ```
   TURSO_URL=... TURSO_AUTH_TOKEN=... node --import tsx scripts/backup-turso.ts
   ```
3. **Export from Turso:**
   ```
   TURSO_URL=... TURSO_AUTH_TOKEN=... \
     node --import tsx scripts/db-export.ts /path/to/export-$(date +%Y%m%d)
   ```
   Prints a per-table row count; `manifest.json` in the output directory
   records a SHA-256 checksum per table and the source's own applied
   migration ids (reference only — see `apps/server/infra/db-export.ts`'s
   header for why those are never imported).
4. **Apply the Postgres baseline to the target**, then import:
   ```
   PORTUNI_DATABASE_URL=postgres://... node --import tsx -e '
     import("./apps/server/infra/schema.js").then(({ ensureSchema }) => ensureSchema());
   '
   PORTUNI_DATABASE_URL=postgres://... \
     node --import tsx scripts/db-import.ts /path/to/export-$(date +%Y%m%d)
   ```
   `db-import.ts` refuses outright if the target already has data (beyond
   the solo user `ensureSchema()` itself seeds) — see its own header
   comment. A refusal means either the target was not actually empty (stop
   and investigate) or this cutover already ran once.
5. **Point the VPS at Postgres.** Add `PORTUNI_DATABASE_URL=postgres://...`
   to `/opt/portuni/portuni.env` (the systemd `EnvironmentFile`
   `deploy-vps.sh`'s header comment describes); leave `TURSO_URL`/
   `TURSO_AUTH_TOKEN` in place for now — the rollback below needs them.
6. **Deploy and verify:**
   ```
   ./scripts/deploy-vps.sh
   ```
   (its own smoke check already polls `/health`; a manual check is
   `curl -fsS https://api.portuni.com/health`). Spot-check a handful of
   nodes/sessions/files through the app against what the pre-cutover
   Turso database had, beyond the export manifest's row counts.

### Rollback

Until B4 removes libsql, rolling back is one env var: remove
`PORTUNI_DATABASE_URL` from `/opt/portuni/portuni.env` (or point it back at
`file:`/`libsql:` explicitly) and restart — `getDb()`
(`apps/server/infra/db.ts`) falls back to `TURSO_URL` exactly as it did
before the cutover, and Turso itself was never written to during the
export (step 1 stopped the server first), so it is still the
authoritative, current database. No data moves backward; the cutover
simply stops being used.

## Local workspace: SQLite → PGlite

Deferred to B4 (`feat(infra,desktop): PGlite is the local database, libsql
is gone`) — the desktop app drives this one itself (detect a legacy
`portuni.db`, run the same export/import pair against it, rename the old
file aside) rather than a human running these scripts by hand. This
section will be filled in when that issue lands.
