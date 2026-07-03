#!/usr/bin/env bash
# Daily offline backup of the Portuni Turso database.
#
# Produces a gzipped SQLite/libSQL .dump (DDL + INSERTs) in ~/backups/portuni/,
# independent of Turso Cloud PITR. Restore into any SQLite/libSQL target:
#   gunzip -c backup.sql.gz | turso db shell <target> ".read /dev/stdin"
#
# Credentials come from the repo's varlock env (.env.local: TURSO_URL,
# TURSO_AUTH_TOKEN) -- the token is never printed. The dump endpoint needs an
# https:// scheme, so libsql:// is rewritten on the fly.
#
# Scheduled via ~/Library/LaunchAgents/ooo.workflow.portuni.backup.plist.
# launchd runs with a minimal PATH, so node + turso paths are pinned below.
set -euo pipefail

REPO="/Users/honzapav/Dev/projekty/portuni"
BACKUP_DIR="$HOME/backups/portuni"
RETAIN_DAYS=30
# Pinned tool paths (nvm default node for varlock, homebrew for turso).
export PATH="$HOME/.nvm/versions/node/v24.0.2/bin:/opt/homebrew/bin:$PATH"

cd "$REPO"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="$BACKUP_DIR/.portuni-$STAMP.sql.partial"
OUT="$BACKUP_DIR/portuni-$STAMP.sql.gz"

# Dump via varlock so the auth token stays out of argv/logs.
node_modules/.bin/varlock run -- sh -c \
  'URL=$(printf "%s" "$TURSO_URL" | sed "s#^libsql://#https://#"); \
   turso db shell "$URL?authToken=$TURSO_AUTH_TOKEN" ".dump"' > "$TMP"

# Sanity gate: a real dump has tables and ends with COMMIT. Refuse to keep a
# truncated/empty file (a silent empty backup is worse than none).
if ! grep -q "CREATE TABLE" "$TMP" || ! tail -3 "$TMP" | grep -q "COMMIT;"; then
  echo "backup-turso: dump failed sanity check (no tables or no COMMIT), discarding" >&2
  rm -f "$TMP"
  exit 1
fi

gzip -c "$TMP" > "$OUT"
rm -f "$TMP"
echo "backup-turso: wrote $OUT ($(wc -c < "$OUT") bytes, $(grep -c 'CREATE TABLE' <(gunzip -c "$OUT")) tables)"

# Rotate: drop dumps older than RETAIN_DAYS.
find "$BACKUP_DIR" -name 'portuni-*.sql.gz' -type f -mtime +"$RETAIN_DAYS" -delete
