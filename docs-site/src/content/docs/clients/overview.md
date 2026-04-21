---
title: MCP Clients
description: How to connect Portuni from Claude Code, Codex CLI, and Gemini CLI, and how each client handles filesystem permissions.
---

Portuni is a plain HTTP MCP server – any client that speaks Streamable HTTP MCP can connect to it. This section covers the three CLIs most Portuni users run today:

- [Claude Code](/clients/claude-code/) (Anthropic)
- [Codex CLI](/clients/codex-cli/) (OpenAI)
- [Gemini CLI](/clients/gemini-cli/) (Google)

## Why each client has its own page

Connecting is trivial – all three need roughly the same URL. What differs is **how the client reaches the files that Portuni's mirrors point to**. Mirrors live on your local disk, often outside the directory where you started the CLI, and each client has its own permission model.

## Grant access per launch, not globally

Every client lets you list mirror directories permanently in a user-level config file (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`). It works, but it is a quiet global default: **every** session on the machine inherits that access, not just the ones actually working with Portuni. It is easy to forget about.

The safer default is to grant access **at launch** with a flag. Scope is obvious, it lives alongside the command that needs it, and you can bake it into an alias or a project README.

| Client | At launch (recommended) | Mid-session | Persistent (quiet global) |
|--------|-------------------------|-------------|----------------------------|
| Claude Code | `claude --add-dir <path>` | `/add-dir <path>` | `permissions.additionalDirectories` |
| Codex CLI | `codex --add-dir <path>` | — requires restart | `[sandbox_workspace_write].writable_roots` |
| Gemini CLI | `gemini --include-directories <path>` | `/directory add <path>` | `context.includeDirectories` |

Codex CLI is the outlier. It enforces the sandbox in the OS kernel, so there is no slash command that can widen `writable_roots` in a running session. Decide which roots you need before launching.

See [Concepts → Filesystem Permissions](/concepts/permissions/) for why this shapes up the way it does.

## Prerequisite

All pages in this section assume the Portuni server is already running on `http://localhost:3001/mcp`. If not, see [Getting Started → Setup](/getting-started/setup/).
