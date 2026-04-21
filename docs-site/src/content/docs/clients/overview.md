---
title: MCP Clients
description: How to connect Portuni from Claude Code, Codex CLI, and Gemini CLI, and how each client handles filesystem permissions.
---

Portuni is a plain HTTP server that speaks MCP – which means any AI client that speaks MCP over HTTP can talk to it. The three clients most teams are running today each have their own page here:

- [Claude Code](/clients/claude-code/) – Anthropic's terminal agent
- [Codex CLI](/clients/codex-cli/) – OpenAI's terminal agent
- [Gemini CLI](/clients/gemini-cli/) – Google's terminal agent

If you're using something else that speaks MCP, the same ideas apply – you just have to hunt down the equivalent settings yourself.

## One URL, three different habits around your files

The hard part isn't connecting. All three clients need roughly the same URL. What differs is **how each one treats your local files** – specifically, the mirror folders that Portuni points to. Those folders often sit outside the directory where you launched the CLI, and every client has its own opinion about whether the agent is allowed to read or write there.

This is where Portuni users most often get stuck: the server is running, the graph is loading, but the agent quietly fails to write a file and nobody's quite sure why. The short answer is almost always "the client doesn't know it's allowed to touch that folder yet."

## Our recommendation: grant access at launch, not globally

Every client lets you list allowed directories in a config file once and forget about it – `~/.claude/settings.json`, `~/.codex/config.toml`, or `~/.gemini/settings.json`. That works, but it's a quiet global default: **every** session on the machine inherits that access, not just the ones you actually meant for Portuni. It's easy to stop thinking about, and easy to be surprised by later.

The friendlier approach is to hand the path to the client at launch time. The scope is obvious, it lives alongside the command that needs it, and you can bake it into a shell alias or a project README.

| Client | At launch (recommended) | Mid-session | Persistent (quiet global) |
|--------|-------------------------|-------------|----------------------------|
| Claude Code | `claude --add-dir <path>` | `/add-dir <path>` | `permissions.additionalDirectories` |
| Codex CLI | `codex --add-dir <path>` | — requires restart | `[sandbox_workspace_write].writable_roots` |
| Gemini CLI | `gemini --include-directories <path>` | `/directory add <path>` | `context.includeDirectories` |

Codex CLI is a little different. It locks the sandbox at the operating-system level, so once it's running there's no way to widen access without restarting. Worth deciding which roots you'll need before you launch it.

For the full reasoning behind all this, head to [Concepts → Filesystem Permissions](/concepts/permissions/).

## Before you start

All pages in this section assume Portuni is already running on `http://localhost:3001/mcp`. If it isn't, pop over to [Getting Started → Setup](/getting-started/setup/) first – it's a few minutes of work and you can come back.
