---
title: Desktop App
description: Portuni.app — the Tauri-built macOS desktop client with an embedded MCP server sidecar.
---

`Portuni.app` is the Tauri-built macOS desktop client. It's the daily-driver way to use Portuni: install one DMG and you get the UI, the MCP server, and the integration glue in a single application.

## What it gives you

A native macOS window (1600×1000 by default, opens maximized) with:

- **Graph view** — Cytoscape-rendered interactive node graph using the `fcose` force-directed layout. Pan, zoom, click a node to focus.
- **Detail pane** — the right column shows the focused node's full detail: owner, responsibilities, data sources, tools, events timeline, files. Same payload `portuni_get_node` returns over MCP, rendered as a panel rather than JSON.
- **Workspace view** — a node browser with type / status filters, sidebar navigation, and a status footer.
- **Multi-session terminal tabs** — built-in `xterm`-based terminals attached to the focused node's local mirror via PTY. Run `claude`, `codex`, or any shell command in-context without leaving the app.
- **Actors page** — browse and manage actors and assignments.
- **Settings page** — Turso credentials, workspace root, and a section for managing the embedded MCP server.
- **Create-node modal**, **date picker**, and other interactive controls for editing the graph directly from the UI.

## Embedded MCP sidecar

The app bundles the Portuni MCP server as an embedded binary (`binaries/portuni-sidecar`) and spawns it on launch. You do not need to:

- Clone the GitHub repo.
- Install Node.js or Varlock.
- Run `npm start` in a tmux session.

The sidecar listens on `http://localhost:4011` (same port as the CLI build), so any MCP client — Claude Code, Codex CLI, Gemini CLI — can point at it the same way. The app passes an auth token to the sidecar per-launch; if you want external MCP clients to connect, copy the token from the Settings → MCP Server section into your client config.

## Install

1. Open the [GitHub releases](https://github.com/honzapav/portuni/releases) page.
2. Download the DMG matching your CPU:
   - `Portuni_<version>_aarch64.dmg` — Apple Silicon (M1/M2/M3/M4)
   - `Portuni_<version>_x64.dmg` — Intel
3. Open the DMG and drag `Portuni.app` to `/Applications/`.
4. Launch it.

First launch shows the Gatekeeper "unidentified developer" dialog because the app is not yet code-signed (`APPLE_CERTIFICATE` secrets aren't wired into the release workflow). Right-click → Open the first time to bypass; subsequent launches are clean.

## First run

The app walks you through two gates before you can use it:

1. **Turso setup gate** — paste your `TURSO_URL` and `TURSO_AUTH_TOKEN`, or skip to use a local SQLite database. The settings are stored locally via the app's settings storage; you don't edit `.env.local` for the desktop install.
2. **Workspace-root prompt** — pick the root directory where mirror folders will live (e.g. `~/Workspaces/portuni`). This corresponds to the `PORTUNI_WORKSPACE_ROOT` env var in the CLI install.

After these, you land in the Workspace view. Create your first organization node, then add projects / processes / areas / principles under it.

## Updating

Releases are tag-driven (`v*`). When a new release lands, download the new DMG and drag-replace `Portuni.app` in `/Applications/`. There is no in-app auto-update yet. Your settings, database (local SQLite or Turso), and mirror folders are unaffected.

## Connecting external MCP clients to the app's sidecar

The desktop app and an external MCP client (Claude Code, Codex CLI, Gemini CLI) can share the same backend:

1. Open the app and grab the auth token from Settings → MCP Server.
2. Point the external client at `http://localhost:4011/mcp` with that token as a bearer header.
3. Reads and writes from the external client land in the same graph as the app — keep the app open or the sidecar will exit with it.

For the per-client configuration details see [Claude Code](/clients/claude-code/), [Codex CLI](/clients/codex-cli/), [Gemini CLI](/clients/gemini-cli/).

## When to use the CLI server instead

Stick with the standalone CLI server (covered in [Setup](/getting-started/setup/)) when:

- You're contributing to Portuni — the CLI dev loop is faster than rebuilding the `.app` on every change.
- You're on Linux or Windows. Native bundles for those platforms aren't on the near roadmap.
- You're deploying Portuni to a shared server, not a personal machine.
- You want to run multiple Portuni instances side by side with distinct workspace roots.

## See also

- [Setup](/getting-started/setup/) — install paths and configuration
- [MCP Clients overview](/clients/overview/) — how each client treats your local files
- [Local Mirrors](/concepts/mirrors/) — the per-device mirror model the app surfaces in the Workspace view
