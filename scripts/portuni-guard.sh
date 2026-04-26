#!/usr/bin/env bash
# Portuni write-scope PreToolUse hook.
#
# Wire into Claude Code (or any harness that exposes a PreToolUse hook) to
# block writes that fall outside the current mirror without explicit user
# approval. Reads the harness's hook payload from stdin (JSON), classifies
# the write target via the Portuni server's /scope endpoint.
#
# Decision -> exit code mapping (Claude Code convention):
#   tier1 (current mirror)            -> exit 0  (allow silently)
#   tier2 (sibling mirror)            -> exit 2  (deny with stderr message)
#   tier3 (outside PORTUNI_ROOT)      -> exit 2  (deny with stderr message)
#   target unparsable for write tool  -> exit 2  (FAIL CLOSED)
#   non-write tool                    -> exit 0  (allow silently)
#   server unreachable                -> exit 0  (soft fallback only)
#
# Configuration:
#   PORTUNI_URL          base URL of Portuni server (default http://localhost:4011)
#   PORTUNI_AUTH_TOKEN   bearer token if Portuni server has auth enabled

set -euo pipefail

URL="${PORTUNI_URL:-http://localhost:4011}"
TOKEN="${PORTUNI_AUTH_TOKEN:-}"

# Single Python program does the whole job. Passed via -c so that stdin
# stays bound to the JSON payload from the harness (a here-doc would steal
# it). cwd is captured before the python call so it reflects the harness.

PORTUNI_GUARD_URL="$URL" PORTUNI_GUARD_TOKEN="$TOKEN" PORTUNI_GUARD_CWD="$(pwd)" \
exec python3 -c '
import json
import os
import sys
import urllib.parse
import urllib.request

WRITE_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
TARGET_KEYS = ("file_path", "path", "target", "absolute_path")

raw = sys.stdin.read() or ""
try:
    payload = json.loads(raw) if raw.strip() else {}
except Exception:
    # Malformed payload: fail open. We do not know what the harness wanted
    # and breaking every tool call would be worse than missing a check.
    sys.exit(0)

tool_name = payload.get("tool_name") or payload.get("tool") or ""
tool_input = payload.get("tool_input") or {}

if tool_name and tool_name not in WRITE_TOOLS:
    sys.exit(0)

target = None
for k in TARGET_KEYS:
    v = tool_input.get(k) if isinstance(tool_input, dict) else None
    if isinstance(v, str) and v.strip():
        target = v.strip()
        break
if target is None:
    for k in TARGET_KEYS:
        v = payload.get(k)
        if isinstance(v, str) and v.strip():
            target = v.strip()
            break

if target is None:
    if tool_name in WRITE_TOOLS:
        sys.stderr.write(
            "portuni-guard: cannot determine target path for "
            + tool_name
            + "; refusing to allow write.\n"
        )
        sys.exit(2)
    sys.exit(0)

cwd = os.environ.get("PORTUNI_GUARD_CWD") or os.getcwd()
url = os.environ["PORTUNI_GUARD_URL"].rstrip("/")
qs = urllib.parse.urlencode({"cwd": cwd, "target": target})
req = urllib.request.Request(url + "/scope?" + qs)
token = os.environ.get("PORTUNI_GUARD_TOKEN", "")
if token:
    req.add_header("Authorization", "Bearer " + token)

try:
    with urllib.request.urlopen(req, timeout=1.0) as resp:
        data = json.loads(resp.read().decode("utf-8"))
except Exception:
    # Server unreachable: soft fallback. Do not block.
    sys.exit(0)

decision = data.get("decision", "allow")
reason = data.get("reason", "")

if decision == "allow":
    sys.exit(0)

sys.stderr.write("portuni-guard: write blocked. " + reason + "\n")
sys.exit(2)
'
