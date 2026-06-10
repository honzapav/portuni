#!/usr/bin/env bash
# portuni run — launch any agent binary inside the current mirror's
# disk-scope sandbox.
#
#   cd ~/Workspaces/<org>/projects/<node>
#   portuni-run.sh claude            # or codex, aider, plain zsh, ...
#
# Fetches the Seatbelt profile for the cwd's mirror from the Portuni
# server (GET /sandbox-profile?cwd=...) and execs the command under
# sandbox-exec, so the kernel enforces the node scope: home mirror
# read+write, depth-1 neighbor mirrors read-only, the rest of
# PORTUNI_ROOT denied. This is the out-of-app counterpart of the desktop
# terminal's pty_spawn sandbox wiring.
#
# FAIL CLOSED: if the profile cannot be obtained (server down, cwd not
# in a mirror, auth failure), the command does NOT run unsandboxed —
# the error tells you why. Running without the boundary should be a
# deliberate act (invoke the agent directly), never an accident.
#
# Configuration:
#   PORTUNI_URL          base URL of the Portuni server
#                        (default http://127.0.0.1:47011 — the desktop
#                        sidecar; use http://localhost:4011 for dev)
#   PORTUNI_MCP_TOKEN    bearer token (same variable the per-mirror
#                        .mcp.json expands; required when auth is on)

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $(basename "$0") <command> [args...]" >&2
  exit 64
fi

if ! command -v sandbox-exec >/dev/null 2>&1; then
  echo "portuni-run: sandbox-exec not found (macOS only)" >&2
  exit 1
fi

URL="${PORTUNI_URL:-http://127.0.0.1:47011}"
URL="${URL%/}"
TOKEN="${PORTUNI_MCP_TOKEN:-}"

CWD="$(pwd)"
PROFILE_FILE="$(mktemp -t portuni-run-sbx)"
trap 'rm -f "$PROFILE_FILE"' EXIT

# urlencode cwd via python (always present on macOS).
ENCODED_CWD="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$CWD")"

AUTH_ARGS=()
if [ -n "$TOKEN" ]; then
  AUTH_ARGS=(-H "Authorization: Bearer $TOKEN")
fi

HTTP_CODE="$(curl -sS -o "$PROFILE_FILE.json" -w '%{http_code}' \
  "${AUTH_ARGS[@]}" \
  "$URL/sandbox-profile?cwd=$ENCODED_CWD")" || {
  echo "portuni-run: Portuni server unreachable at $URL — refusing to run unsandboxed" >&2
  exit 1
}

if [ "$HTTP_CODE" != "200" ]; then
  echo "portuni-run: $URL/sandbox-profile returned HTTP $HTTP_CODE:" >&2
  cat "$PROFILE_FILE.json" >&2 || true
  rm -f "$PROFILE_FILE.json"
  exit 1
fi

python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
sys.stdout.write(data["profile"])
' "$PROFILE_FILE.json" > "$PROFILE_FILE"
rm -f "$PROFILE_FILE.json"

# PORTUNI_MCP_TOKEN stays in env for the child so the per-mirror
# .mcp.json header expansion resolves inside the sandbox.
exec sandbox-exec -f "$PROFILE_FILE" "$@"
