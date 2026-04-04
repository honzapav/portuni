---
title: Setup
description: How to install and run Portuni.
---

## Prerequisites

- Node.js >= 20
- Turso database account
- Varlock for secrets management

## Installation

```bash
git clone https://github.com/honzapav/portuni
cd portuni
npm install
npm run build
```

## Environment

Portuni uses Varlock for credential management. Required variables (defined in `.env.schema`):

| Variable | Description |
|----------|-------------|
| `TURSO_URL` | Turso database URL |
| `TURSO_AUTH_TOKEN` | Turso auth token |
| `PORTUNI_WORKSPACE_ROOT` | Root for local mirror folders (e.g. `~/Workspaces/portuni`) |

## Running the server

```bash
npx varlock run -- npm start       # production
npx varlock run -- npm run dev     # development
```

Server listens on `http://localhost:3001` by default. Override with the `PORT` environment variable.

Recommended: run in a tmux session so it persists in the background:

```bash
tmux new-session -d -s portuni 'cd ~/Dev/projekty/portuni && npx varlock run -- npm run dev'
```

## Claude Code integration

### Global MCP config

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

:::caution
Use `type: "http"` (Streamable HTTP), not `"sse"`. Claude Code ignores SSE transport in global config.
:::

### SessionStart hook

The hook at `scripts/portuni-context.sh` automatically injects graph context when you start a Claude Code session in a Portuni workspace folder. Configure it in `~/.claude/settings.json`.

The hook shows: which node you're working in, connected nodes, and recent events.

## Verify

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

## Running tests

```bash
npm test
```

Uses Node.js built-in test runner (`node:test`). No external test framework needed.
