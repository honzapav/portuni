#!/bin/bash
# Portuni SessionStart hook — injects graph context when cwd is a Portuni workspace

PORTUNI_URL="${PORTUNI_URL:-http://localhost:3001}"
CWD="$(pwd)"
ENCODED_PATH=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$CWD")

# Quick health check
curl -s -m 0.2 "$PORTUNI_URL/health" > /dev/null 2>&1 || exit 0

# Query and format
curl -s -m 1 "$PORTUNI_URL/context?path=$ENCODED_PATH" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except:
    sys.exit(0)

if not data.get('match'):
    sys.exit(0)

node = data['node']
edges = data.get('edges', [])
events = data.get('events', [])

print(f\"Portuni: You are working in {node['type']} '{node['name']}' ({node['status']})\")
if node.get('description'):
    print(f\"  {node['description']}\")
print(f\"  Local path: {node['local_path']}\")
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
"
