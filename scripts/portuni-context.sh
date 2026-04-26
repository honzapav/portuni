#!/bin/bash
# Portuni SessionStart hook – injects graph context when cwd is a Portuni workspace.
#
# Supports multiple Portuni instances. Set PORTUNI_URLS to a space-separated list
# of base URLs (e.g. "http://localhost:4011 http://localhost:3002"); the hook tries
# each in order and uses the first server whose workspace matches the current
# working directory. If PORTUNI_URLS is not set, the hook falls back to
# PORTUNI_URL (single URL), and finally to http://localhost:4011 as the default.

if [ -n "$PORTUNI_URLS" ]; then
  URLS="$PORTUNI_URLS"
elif [ -n "$PORTUNI_URL" ]; then
  URLS="$PORTUNI_URL"
else
  URLS="http://localhost:4011"
fi

CWD="$(pwd)"
ENCODED_PATH=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$CWD")

# Bearer auth for the optional PORTUNI_AUTH_TOKEN. /health stays public so
# the liveness probe below works without a secret. /context is protected.
AUTH_HEADER=()
if [ -n "${PORTUNI_AUTH_TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $PORTUNI_AUTH_TOKEN")
fi

for URL in $URLS; do
  # Quick health check – skip unreachable instances silently
  curl -s -m 0.2 "$URL/health" > /dev/null 2>&1 || continue

  OUTPUT=$(curl -s -m 1 "${AUTH_HEADER[@]}" "$URL/context?path=$ENCODED_PATH" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except:
    sys.exit(1)

if not data.get('match'):
    sys.exit(1)

node = data['node']
edges = data.get('edges', [])
events = data.get('events', [])

print(f\"Portuni: You are working in {node['type']} '{node['name']}' ({node['status']})\")
if node.get('description'):
    print(f\"  {node['description']}\")
print(f\"  Local path: {node['local_path']}\")
print()
print(f\"Initialize the read scope for this session by calling: portuni_session_init(home_node_id='{node['id']}')\")
print('  (Seeds the scope set with this home node + its depth-1 neighbors. Reads beyond that need explicit expansion.)')
print()

if edges:
    print('Connected nodes:')
    for e in edges:
        r = e['related']
        path_info = f\" -> {r['local_path']}\" if r.get('local_path') else ''
        print(f\"  --{e['relation']}--> {r['type']}: {r['name']}{path_info}\")

if events:
    print()
    print('Recent events:')
    for ev in events:
        ts = ev['created_at'][:10]
        print(f\"  [{ts}] {ev['type']}: {ev['content']}\")
")

  if [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
    exit 0
  fi
done

exit 0
