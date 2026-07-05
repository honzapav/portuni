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
- **Settings page** — workspaces (create, enable, switch, pick each one's data mode), per-workspace Turso credentials and workspace root, an Account section (Google sign-in and device tokens for central mode), a Synchronizace section (one-click Google Drive connect for local workspaces — see [Working in the App](/guides/working-in-the-app/#synchronizace-google-drive)), and an MCP Server section with one-click install buttons for Claude Code, Codex, and Mistral Vibe.
- **Create-node modal**, **date picker**, and other interactive controls for editing the graph directly from the UI.

## Embedded MCP sidecar

The app bundles the Portuni MCP server as an embedded binary (`binaries/portuni-sidecar`) and spawns it on launch. You do not need to:

- Clone the GitHub repo.
- Install Node.js or Varlock.
- Run `npm start` in a tmux session.

Each enabled **workspace** runs its own sidecar on a fixed loopback port, allocated from `47011` up (the first workspace gets `47011`). Any MCP client — Claude Code, Codex CLI, Gemini CLI, Mistral Vibe — can point at `http://localhost:<port>/mcp` the same way it would at a standalone server. The sidecar's bearer token is persisted per workspace in the macOS Keychain (it survives restarts and can be rotated from Settings); the easiest way to wire up an external client is the one-click install buttons in Settings → MCP Server, which register the right URL and token for each workspace. Terminals spawned inside the app get every workspace's token injected as `PORTUNI_MCP_TOKEN_<workspace-id>` (plus `PORTUNI_MCP_TOKEN` as an alias for the active workspace); shells outside the app need the token exported manually.

## Workspaces

The app manages one or more workspaces — think of each as an independent Portuni: its own database, its own workspace root for mirrors, its own sidecar port, and its own Keychain-held credentials. All enabled workspaces run concurrently; the UI switcher only changes which one you're looking at. Each workspace also picks its **data mode**: local (its own Turso/SQLite database) or central (your organization's server — see [Data Modes](/concepts/data-modes/)), so a personal graph and a company graph can live side by side in one app.

## Install

1. Open the [GitHub releases](https://github.com/honzapav/portuni/releases) page.
2. Download the DMG matching your CPU:
   - `Portuni_<version>_aarch64.dmg` — Apple Silicon (M1/M2/M3/M4)
   - `Portuni_<version>_x64.dmg` — Intel
3. Open the DMG and drag `Portuni.app` to `/Applications/`.
4. Launch it.

Release DMGs are Developer ID signed and notarized, so the app opens without Gatekeeper warnings. If you built the app yourself without signing secrets, you'll see the "unidentified developer" dialog — right-click → Open to bypass.

## First run

A fresh install creates your first workspace and walks you through its setup. What you're asked depends on the workspace's data mode:

- **Local mode** — paste your `TURSO_URL` and `TURSO_AUTH_TOKEN`, or skip to use a local SQLite database, and pick the root directory where mirror folders will live (e.g. `~/Workspaces/portuni`; the equivalent of `PORTUNI_WORKSPACE_ROOT` in the CLI install). Credentials go to the macOS Keychain — you never edit `.env.local` for the desktop install.
- **Central mode** — sign in with your Google account instead; no database credentials needed. See [Data Modes](/concepts/data-modes/).

After that, you land in the Workspace view. Create your first organization node, then add projects / processes / areas / principles under it. (Upgrading from an older single-workspace install? The app migrates your existing configuration into the first workspace automatically.)

## Updating

Releases are tag-driven (`v*`). When a new release lands, download the new DMG and drag-replace `Portuni.app` in `/Applications/`. There is no in-app auto-update yet. Your settings, database (local SQLite or Turso), and mirror folders are unaffected.

## Connecting external MCP clients to the app's sidecar

The desktop app and an external MCP client (Claude Code, Codex CLI, Gemini CLI, Mistral Vibe) can share the same backend:

1. The easiest way: use the one-click install buttons in Settings → MCP Server, which register each workspace's URL and token for you.
2. Wiring by hand instead? Point the external client at the workspace's sidecar, `http://localhost:<port>/mcp` (ports start at `47011`; shown in Settings), with the workspace's token as a bearer header.
3. Reads and writes from the external client land in the same graph as the app — keep the app open or the sidecar will exit with it.

For the per-client configuration details see [Claude Code](/clients/claude-code/), [Codex CLI](/clients/codex-cli/), [Gemini CLI](/clients/gemini-cli/), [Mistral Vibe](/clients/mistral-vibe/).

## When to use the CLI server instead

Stick with the standalone CLI server (covered in [Setup](/getting-started/setup/)) when:

- You're contributing to Portuni — the CLI dev loop is faster than rebuilding the `.app` on every change.
- You're on Linux or Windows. Native bundles for those platforms aren't on the near roadmap.
- You're deploying Portuni to a shared server, not a personal machine — see [Team Setup](/getting-started/team-setup/).

Running multiple graphs side by side used to be a CLI-only affair; today it's a desktop feature — create another workspace instead.

## See also

- [Setup](/getting-started/setup/) — install paths and configuration
- [MCP Clients overview](/clients/overview/) — how each client treats your local files
- [Local Mirrors](/concepts/mirrors/) — the per-device mirror model the app surfaces in the Workspace view
- [Data Modes (Local vs Central)](/concepts/data-modes/) — local vs central mode and what each can do with files
