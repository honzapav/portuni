#!/usr/bin/env bash
# Deploy the Portuni server to the utilities VPS (api.portuni.com).
# Builds locally, rsyncs dist + manifests, installs prod deps on the
# server, restarts the systemd unit, smoke-checks /health.
# Prereqs: ssh root@VPS works; /opt/portuni + portuni.service provisioned
# (see docs/superpowers/plans/2026-06-10-vps-deployment.md, Task 4).
set -euo pipefail

VPS_HOST="${PORTUNI_VPS_HOST:-root@64.226.121.79}"
APP_DIR="/opt/portuni"
HEALTH_URL="https://api.portuni.com/health"

cd "$(dirname "$0")/.."

echo "==> qa (lint + typecheck + tests + build)"
npm run qa

echo "==> rsync dist + manifests -> $VPS_HOST:$APP_DIR"
rsync -az --delete dist/ "$VPS_HOST:$APP_DIR/dist/"
rsync -az package.json package-lock.json "$VPS_HOST:$APP_DIR/"

echo "==> install prod deps + restart"
ssh "$VPS_HOST" "cd $APP_DIR && npm ci --omit=dev --no-audit --no-fund && chown -R portuni:portuni $APP_DIR && systemctl restart portuni"

echo "==> smoke check"
sleep 2
for i in 1 2 3 4 5; do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null; then
    echo "OK: $HEALTH_URL is healthy"
    exit 0
  fi
  echo "retry $i..."
  sleep 3
done
echo "FAIL: $HEALTH_URL not healthy after deploy" >&2
ssh "$VPS_HOST" "journalctl -u portuni -n 40 --no-pager" >&2 || true
exit 1
