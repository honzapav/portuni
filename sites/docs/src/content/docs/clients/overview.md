---
title: MCP Clients
description: How to connect Portuni from Claude Code, Codex CLI, Gemini CLI, and Mistral Vibe, and how each client handles filesystem permissions.
---

Portuni is a plain HTTP server that speaks MCP – which means any AI client that speaks MCP over HTTP can talk to it. The clients most teams are running today each have their own page here:

- [Claude Code](/clients/claude-code/) – Anthropic's terminal agent
- [Codex CLI](/clients/codex-cli/) – OpenAI's terminal agent
- [Gemini CLI](/clients/gemini-cli/) – Google's terminal agent
- [Mistral Vibe](/clients/mistral-vibe/) – Mistral's terminal agent
- [Claude Desktop](/clients/claude-desktop/) – the chat app, connected to a central server with a device token
- [Custom Connector (OAuth)](/clients/connector/) – claude.ai, Claude Desktop, Claude mobile, and Claude Code, connected to a central server with one URL and a Google login instead of a device token

If you're using something else that speaks MCP, the same ideas apply – you just have to hunt down the equivalent settings yourself.

The [desktop app](/clients/desktop-app/) sits on both sides of this picture: it's a Portuni client in its own right, and its embedded sidecar is the server the CLIs above usually connect to. The client landscape is also a bit wider than the four pages here – `portuni_mirror` writes a `.cursor/rules` file into every mirror (the same scope hint that lands in `PORTUNI_SCOPE.md`), and the desktop app's terminal ships launch presets for Cursor Agent and OpenCode alongside the four clients above.

## One URL, four different habits around your files

The hard part isn't connecting. All four clients need roughly the same URL. What differs is **how each one treats your local files** – specifically, the mirror folders that Portuni points to. Those folders often sit outside the directory where you launched the CLI, and every client has its own opinion about whether the agent is allowed to read or write there.

This is where Portuni users most often get stuck: the server is running, the graph is loading, but the agent quietly fails to write a file and nobody's quite sure why. The short answer is almost always "the client doesn't know it's allowed to touch that folder yet."

## Our recommendation: grant access at launch, not globally

Every client lets you list allowed directories in a config file once and forget about it – `~/.claude/settings.json`, `~/.codex/config.toml`, or `~/.gemini/settings.json`. That works, but it's a quiet global default: **every** session on the machine inherits that access, not just the ones you actually meant for Portuni. It's easy to stop thinking about, and easy to be surprised by later.

The friendlier approach is to hand the path to the client at launch time. The scope is obvious, it lives alongside the command that needs it, and you can bake it into a shell alias or a project README.

| Client | At launch (recommended) | Mid-session | Persistent (quiet global) |
|--------|-------------------------|-------------|----------------------------|
| Claude Code | `claude --add-dir <path>` | `/add-dir <path>` | `permissions.additionalDirectories` |
| Codex CLI | `codex --add-dir <path>` | — requires restart | `[sandbox_workspace_write].writable_roots` |
| Gemini CLI | `gemini --include-directories <path>` | `/directory add <path>` | `context.includeDirectories` |
| Mistral Vibe | `vibe --trust --add-dir <path>` | — | `trusted_folders.toml` |

Codex CLI is a little different. It locks the sandbox at the operating-system level, so once it's running there's no way to widen access without restarting. Worth deciding which roots you'll need before you launch it.

For the full reasoning behind all this, head to [Concepts → Filesystem Permissions](/concepts/permissions/).

## Before you start

All pages in this section assume a Portuni server is already running. With the desktop app, each enabled workspace runs its own sidecar on a loopback port allocated from `47011` up – Settings → MCP Server shows the exact URL and token, and its one-click install buttons wire up Claude Code, Codex, and Vibe for you. A standalone CLI server listens on `http://localhost:4011/mcp` by default. If neither is running, pop over to [Getting Started → Setup](/getting-started/setup/) first – it's a few minutes of work and you can come back.

One variant to know about: in a **central-mode** workspace the local sidecar runs as a sync agent and still serves the MCP endpoint (the *front door*): device-local tools such as `portuni_mirror`, `portuni_store` and `portuni_pull` run on your machine, every graph tool is proxied to the organization's central server with your device token. The URL and token the desktop app installs are therefore the same loopback ones as in local mode. A client with no desktop app at all connects to the central server's `/mcp` directly — see [Claude Desktop](/clients/claude-desktop/) and [Data Modes](/concepts/data-modes/).
