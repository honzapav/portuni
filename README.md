# Portuni

A shared map of how your organization works – its projects, processes, areas, and principles – held as one graph that every tool and every AI agent can read. People and agents draw from the same picture instead of rebuilding context from scratch in every app.

- Website: [portuni.com](https://portuni.com)
- Documentation: [docs.portuni.com](https://docs.portuni.com)
- License: [Apache 2.0](LICENSE)

## What's in this repo

The Portuni server: a TypeScript MCP server (Streamable HTTP) backed by Turso (shared team database) or local SQLite (solo / testing), with a pluggable file-sync layer for files attached to graph nodes.

```
src/         MCP server, schema, sync engine, tools
scripts/     SessionStart hook, maintenance scripts
test/        node:test suite (no external runner)
docs/        Internal design notes and specs
docs-site/   Public documentation site (docs.portuni.com)
website/     Marketing site (portuni.com)
```

## Quickstart

Requires Node.js 20+ and [Varlock](https://github.com/varlockteam/varlock).

```bash
git clone https://github.com/honzapav/portuni
cd portuni
npm install
npm run build
npx varlock run -- npm run dev
```

Server listens on `http://localhost:4011`. Health check: `curl http://localhost:4011/health`.

The full setup guide – environment variables, Turso vs local SQLite, running multiple instances, connecting MCP clients – lives at [docs.portuni.com/getting-started/setup](https://docs.portuni.com/getting-started/setup/).

## Tests

```bash
npm test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Read the [docs](https://docs.portuni.com) first – Portuni is built on specific concepts (POPP framework, intentional capture, graph-not-tree) and understanding them helps your contribution fit naturally.
