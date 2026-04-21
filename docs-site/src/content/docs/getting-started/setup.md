---
title: Setup
description: How to install and run Portuni.
---

If you're reading this, you're about to get Portuni running on your machine. This page walks you through the install, the environment variables, and starting the server – so that by the end, your AI agents have something to talk to.

## Before you start

- Node.js 20 or newer
- [Varlock](https://github.com/varlockteam/varlock) for secrets management
- A [Turso](https://turso.tech/) account if you're setting up the team or production mode. Turso is the shared cloud database that lets multiple people and multiple agents work against the same graph – it's where Portuni is designed to live long-term.
- **No database account needed** for a solo or testing setup: Portuni quietly falls back to a local SQLite file. Good for trying things out, or for working on the server itself. Plan to move to Turso as soon as more than one person needs the graph.

## Install

```bash
git clone https://github.com/honzapav/portuni
cd portuni
npm install
npm run build
```

## Environment

Portuni uses Varlock for credentials. The authoritative list of variables lives in `.env.schema`; here's the quick rundown:

| Variable | When you need it | What it's for |
|----------|------------------|---------------|
| `PORTUNI_WORKSPACE_ROOT` | always | Root directory for your local mirror folders, e.g. `~/Workspaces/portuni` |
| `TURSO_URL` | team setup | Turso database URL. Leave empty to fall back to local SQLite at `./portuni.db` |
| `TURSO_AUTH_TOKEN` | team setup | Turso auth token. Set alongside `TURSO_URL` |
| `PORTUNI_USER_EMAIL` | optional | Solo-user email in single-user mode. Defaults to `solo@localhost` |
| `PORTUNI_USER_NAME` | optional | Solo-user display name. Defaults to `Solo User` |
| `PORT` | optional | HTTP port for the MCP server. Default `3001` |

### Two ways to run it

- **Team / production (Turso).** Set `TURSO_URL` and `TURSO_AUTH_TOKEN`. The database lives in Turso's libsql cloud, so every teammate and every agent connects to the same graph. This is where Portuni delivers its core value – a shared, organization-wide knowledge graph. Move here as soon as more than one person is involved.
- **Solo / testing (local SQLite).** Leave both Turso variables empty. Portuni creates `./portuni.db` in the project directory on first start. Good for trying things out or working on the server itself, but it doesn't scale past one machine – treat it as a stepping stone, not a home.

## Running the server

```bash
npx varlock run -- npm start       # production
npx varlock run -- npm run dev     # development
```

Portuni listens on `http://localhost:3001` by default. Set `PORT` to change it.

If you'd like it to stay running in the background (so it survives closing the terminal), drop it into a tmux session:

```bash
tmux new-session -d -s portuni -c /path/to/portuni 'npx varlock run -- npm run dev'
```

## Running multiple instances

Portuni instances are independent: each has its own database, its own workspace root, and its own port. To run more than one side by side:

1. **Clone the repo in a second location** (e.g. `/path/to/portuni-alt`). Each clone keeps its own local SQLite file.
2. **Give each instance distinct values** in its `.env.local`:
   - `PORT` – pick a different port, e.g. `3002`
   - `PORTUNI_WORKSPACE_ROOT` – pick a different workspace root
   - optionally `PORTUNI_USER_EMAIL` / `PORTUNI_USER_NAME`
3. **Start each in its own tmux session** with a distinct session name, so you can find them again.

Each running instance is a separate MCP endpoint. See the [MCP Clients](/clients/overview/) section for how to register multiple endpoints with your AI CLI.

## Check it's alive

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

## Running the test suite

```bash
npm test
```

Portuni uses Node.js's built-in test runner (`node:test`). No external framework to install.

## Connect a client

Portuni on its own is a passive server – nothing happens until an MCP client connects. Head to [MCP Clients](/clients/overview/) for per-client instructions, including how to give each client access to your mirror folders.
