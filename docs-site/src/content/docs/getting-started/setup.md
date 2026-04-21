---
title: Setup
description: How to install and run Portuni.
---

## Prerequisites

- Node.js >= 20
- Varlock for secrets management
- A [Turso](https://turso.tech/) account for the team / production setup. Turso is the shared cloud database that lets multiple users and agents work against the same graph – it is the intended long-term deployment.
- No database account is needed for a local solo / testing setup (Portuni falls back to a SQLite file). Use this mode to try Portuni out or develop against it; plan to move to Turso as soon as more than one person needs the graph.

## Installation

```bash
git clone https://github.com/honzapav/portuni
cd portuni
npm install
npm run build
```

## Environment

Portuni uses Varlock for credential management. See `.env.schema` for the authoritative list.

| Variable | Mode | Description |
|----------|------|-------------|
| `PORTUNI_WORKSPACE_ROOT` | always required | Root for local mirror folders (e.g. `~/Workspaces/portuni`) |
| `TURSO_URL` | team setup | Turso database URL. Required for team / production. Leave empty for local solo / testing mode (falls back to SQLite at `./portuni.db`) |
| `TURSO_AUTH_TOKEN` | team setup | Turso auth token. Required together with `TURSO_URL` |
| `PORTUNI_USER_EMAIL` | optional | Solo user email in Phase 1 single-user mode. Default: `solo@localhost` |
| `PORTUNI_USER_NAME` | optional | Solo user display name. Default: `Solo User` |
| `PORT` | optional | HTTP port for the MCP server. Default: `3001` |

### Deployment modes

Portuni has two modes that share the same schema and tools:

- **Team / production (Turso).** Set `TURSO_URL` and `TURSO_AUTH_TOKEN`. The database lives in Turso's libsql cloud, so every teammate and every agent connects to the same graph. This is the only mode in which Portuni delivers its core value – a shared organizational knowledge graph. Plan for this mode as soon as more than one person is involved.
- **Solo / testing (local SQLite).** Leave both Turso variables empty. Portuni creates `./portuni.db` in the project directory on first start. Good for trying Portuni out, running a personal graph on one machine, or developing the server itself. Does not scale beyond a single machine, so treat it as a stepping stone rather than a destination.

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

## Running multiple instances

Portuni instances are fully independent: each has its own database, its own workspace root, and its own port. To run more than one in parallel:

1. **Check out the repo in a second location** (e.g. `~/Dev/projekty/portuni-alt`). Each checkout owns its own local SQLite file in its own directory.
2. **Give each instance distinct values** in its `.env.local`:
   - `PORT` – pick a different port (e.g. `3002`)
   - `PORTUNI_WORKSPACE_ROOT` – pick a different workspace root
   - optionally `PORTUNI_USER_EMAIL` / `PORTUNI_USER_NAME`
3. **Start each instance in its own tmux session** with a distinct session name.

Each running instance is a separate MCP endpoint. See the [MCP Clients](/clients/overview/) section for how to register multiple endpoints with your AI CLI.

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

## Connect a client

Portuni on its own is a passive server. To actually use it, connect an MCP client. See the [MCP Clients](/clients/overview/) section for per-client instructions – including how to grant the client filesystem access to your mirror folders.
