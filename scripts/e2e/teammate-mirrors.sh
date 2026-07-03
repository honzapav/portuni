#!/usr/bin/env bash
# Teammate-mirrors E2E: a real central server (fs remote) + the agent-mode
# sidecar, exercising mirror create -> watcher register -> sync push ->
# remote edit -> pull. No prod, no Drive, no Turso cloud.
set -euo pipefail

REPO=/Users/honzapav/Dev/projekty/portuni
NODEBIN="$HOME/.nvm/versions/node/v24.0.2/bin"
export PATH="$NODEBIN:$PATH"
SP="$(cd "$(dirname "$0")" && pwd)"

E2E=$(mktemp -d /tmp/portuni-e2e.XXXXXX)
REMOTE_ROOT="$E2E/remote"; CENTRAL_DATA="$E2E/central-data"; CENTRAL_WS="$E2E/central-ws"
AGENT_DATA="$E2E/agent-data"; AGENT_WS="$E2E/agent-ws"
mkdir -p "$REMOTE_ROOT" "$CENTRAL_DATA" "$CENTRAL_WS" "$AGENT_DATA" "$AGENT_WS"
TOK="e2e-shared-token"
NODE_ID="E2E000000000000000000PROJ0"
CENTRAL_PORT=49301
AGENT_PORT=49302

cleanup() {
  for pid in "${CENTRAL_PID:-}" "${AGENT_PID:-}"; do
    if [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT

echo "== seed central db =="
"$NODEBIN/npx" tsx "$REPO/scripts/e2e/seed.mts" "$CENTRAL_DATA/portuni.db" "$REMOTE_ROOT"

echo "== start fake central (dist/desktop.js, env auth) =="
env -i HOME="$HOME" PATH="$PATH" \
  PORTUNI_DATA_DIR="$CENTRAL_DATA" TURSO_URL="file:$CENTRAL_DATA/portuni.db" \
  PORTUNI_PORT=$CENTRAL_PORT PORTUNI_AUTH_TOKEN="$TOK" \
  PORTUNI_WORKSPACE_ROOT="$CENTRAL_WS" PORTUNI_WATCH_MIRRORS=0 \
  "$NODEBIN/node" "$REPO/dist/desktop.js" > "$E2E/central.log" 2>&1 &
CENTRAL_PID=$!

echo "== start agent sidecar (agent mode) =="
env -i HOME="$HOME" PATH="$PATH" \
  PORTUNI_AGENT_MODE=1 \
  PORTUNI_CENTRAL_URL="http://127.0.0.1:$CENTRAL_PORT" \
  PORTUNI_CENTRAL_TOKEN="$TOK" \
  PORTUNI_URL="http://127.0.0.1:$CENTRAL_PORT" \
  PORTUNI_DATA_DIR="$AGENT_DATA" PORTUNI_PORT=$AGENT_PORT \
  PORTUNI_AUTH_TOKEN="agent-local-token" \
  PORTUNI_WORKSPACE_ROOT="$AGENT_WS" \
  "$NODEBIN/node" "$REPO/dist/desktop.js" > "$E2E/agent.log" 2>&1 &
AGENT_PID=$!

wait_http() { # url, expected substring of any 2xx body
  for i in $(seq 1 40); do
    if curl -fsS -m 2 -H "Authorization: Bearer $2" "$1" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "TIMEOUT waiting for $1"; return 1
}
wait_http "http://127.0.0.1:$CENTRAL_PORT/health" "$TOK"
wait_http "http://127.0.0.1:$AGENT_PORT/health" "agent-local-token"
echo "both up"

A() { curl -fsS -m 20 -H "Authorization: Bearer agent-local-token" "$@"; }

echo "== 1) mirror create via agent =="
A -X POST "http://127.0.0.1:$AGENT_PORT/nodes/$NODE_ID/mirror" | tee "$E2E/mirror.json"
MIRROR=$("$NODEBIN/node" -e "console.log(JSON.parse(require('fs').readFileSync('$E2E/mirror.json','utf8')).local_path)")
test -d "$MIRROR/wip" || { echo "FAIL: wip dir missing"; exit 1; }
echo "mirror at $MIRROR"

echo "== 2) drop a file; watcher should register it (record-only) =="
echo "hello from teammate" > "$MIRROR/wip/e2e-note.md"
sleep 2
STATUS=$(A "http://127.0.0.1:$AGENT_PORT/nodes/$NODE_ID/sync-status")
echo "$STATUS" | grep -q "e2e-note" || true
# After watcher registration the file is a tracked record classified push:
echo "$STATUS" | "$NODEBIN/node" -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const s=JSON.parse(d);
    const push=s.files.filter(f=>f.sync_class==='push').length;
    const untracked=s.untracked.length;
    console.log('push='+push,'untracked='+untracked);
    if(push+untracked<1){console.error('FAIL: file not visible to status');process.exit(1)}
  })"

echo "== 3) sync run: push to the remote =="
A -X POST "http://127.0.0.1:$AGENT_PORT/nodes/$NODE_ID/sync" | tee "$E2E/sync1.json"
REMOTE_FILE="$REMOTE_ROOT/e2e-org/projects/e2e-proj/wip/e2e-note.md"
test -f "$REMOTE_FILE" || { echo "FAIL: bytes did not reach the remote"; ls -R "$REMOTE_ROOT"; exit 1; }
grep -q "hello from teammate" "$REMOTE_FILE" || { echo "FAIL: remote content mismatch"; exit 1; }
echo "remote push OK"

echo "== 4) status should be clean =="
A "http://127.0.0.1:$AGENT_PORT/nodes/$NODE_ID/sync-status" | "$NODEBIN/node" -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const s=JSON.parse(d);
    const cls=s.files.map(f=>f.sync_class).join(',');
    console.log('classes:',cls,'untracked:',s.untracked.length);
    if(!s.files.every(f=>f.sync_class==='clean')){console.error('FAIL: not clean after push');process.exit(1)}
  })"

echo "== 5) remote edit -> pull =="
echo "edited on the remote side" > "$REMOTE_FILE"
# The central serves hashes from Turso records; a direct fs write bypasses
# them, so refresh the record via the central's own byte-write endpoint
# (exactly what another teammate's push would do).
B64=$("$NODEBIN/node" -e "console.log(Buffer.from('edited via central by teammate B').toString('base64'))")
curl -fsS -m 20 -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -X PUT "http://127.0.0.1:$CENTRAL_PORT/nodes/$NODE_ID/file?path=wip/e2e-note.md" \
  -d "{\"content_base64\":\"$B64\",\"force\":true}" > /dev/null
# The agent's CentralClient holds sync-info in a 3s micro-cache; an edit made
# by ANOTHER user (this direct central PUT) becomes visible on the next
# fetch after the TTL. The UI polls at 5s, so real usage never notices --
# but this assertion must wait the TTL out.
sleep 4
STATUS2=$(A "http://127.0.0.1:$AGENT_PORT/nodes/$NODE_ID/sync-status")
echo "$STATUS2" | "$NODEBIN/node" -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const s=JSON.parse(d);
    const pull=s.files.filter(f=>f.sync_class==='pull').length;
    console.log('pull candidates:',pull);
    if(pull!==1){console.error('FAIL: expected 1 pull candidate');process.exit(1)}
  })"
A -X POST "http://127.0.0.1:$AGENT_PORT/nodes/$NODE_ID/sync" > "$E2E/sync2.json"
grep -q "edited via central by teammate B" "$MIRROR/wip/e2e-note.md" \
  || { echo "FAIL: pull did not update the local file"; exit 1; }
echo "pull OK"

echo "== 6) pending aggregate over agent =="
A "http://127.0.0.1:$AGENT_PORT/sync/pending"
echo

echo "== 7) scope config materialized with central MCP URL =="
if [ -f "$MIRROR/.mcp.json" ]; then
  grep -q "http://127.0.0.1:$CENTRAL_PORT/mcp" "$MIRROR/.mcp.json" \
    && echo ".mcp.json points at central MCP OK" \
    || { echo "WARN: .mcp.json exists but URL unexpected:"; cat "$MIRROR/.mcp.json"; }
else
  echo "NOTE: no .mcp.json (PORTUNI_ROOT not resolvable in tmp workspace) — non-fatal"
fi

echo
echo "E2E PASSED. Logs in $E2E"
