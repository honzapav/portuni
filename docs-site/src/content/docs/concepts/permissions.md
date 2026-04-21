---
title: Filesystem Permissions
description: How each MCP client handles access to mirror folders outside the current project.
---

Portuni's data lives in two places: the graph (in Turso or SQLite) and [local mirrors](/concepts/mirrors/) on disk. The graph is reached over MCP and needs no filesystem access at all. Mirrors are different – they are plain folders, often outside the directory where you launched your AI agent, and the agent needs permission from its host to read and write them.

Every client handles this differently. That matters, because "Portuni works fine but the agent can't touch the mirror folder" is an easy trap.

## The three models

| Client | Where is it enforced? | What happens without config? |
|--------|----------------------|-------------------------------|
| Claude Code | Harness (policy check before tool call) | Agent asks for per-session approval |
| Codex CLI | OS kernel sandbox (Seatbelt / Landlock+seccomp) | Write silently fails; model may not realise why |
| Gemini CLI | Harness + optional OS sandbox | Mirror files are invisible to the workspace |

### Claude Code

Policy-based. The harness intercepts each tool call and checks it against allow/deny rules before the kernel ever sees it.

### Codex CLI

Kernel sandbox. `sandbox-exec` on macOS, Landlock + seccomp on Linux. A misbehaving model genuinely cannot escape – which makes Codex attractive for unattended runs, but also means a missing `writable_roots` entry is a hard block with no runtime escape hatch.

### Gemini CLI

Harness-based with an optional OS sandbox layer. The **workspace concept** is explicit: only directories the CLI knows about enter the agent's world. Directories outside simply don't exist from the agent's point of view – there is nothing to deny, because there is nothing to see.

## Granting access: prefer flags over global config

The instinct is to add your mirror root to each client's user-level config (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`) and forget about it. That works, but it also means **every** CLI session – unrelated work too – inherits that access quietly.

Safer default: grant access at launch time. The scope is obvious, it lives alongside the command that needs it, and you can bake it into an alias or a project README.

| Client | At launch (recommended) | Mid-session | Persistent (quiet default) |
|--------|-------------------------|-------------|----------------------------|
| Claude Code | `claude --add-dir <path>` | `/add-dir <path>` | `permissions.additionalDirectories` |
| Codex CLI | `codex --add-dir <path>` | — requires restart | `[sandbox_workspace_write].writable_roots` |
| Gemini CLI | `gemini --include-directories <path>` | `/directory add <path>` | `context.includeDirectories` |

A few practical notes:

- Put the flag in a shell alias or a project README so anyone opening a Portuni mirror knows to use it.
- Codex CLI has no mid-session escape: once launched, the sandbox is fixed. Plan which roots you need before `codex` starts.
- Persistent config is still legitimate on dedicated Portuni machines where the global default matches reality. Just choose it deliberately, not by accident.

## Why Portuni doesn't solve this for you

Portuni is the MCP server; it returns paths but never touches your filesystem from the agent's side. Filesystem permissions sit squarely with the client. Keeping the two concerns separate is what lets Portuni stay thin and pluggable – but it does mean this one piece of setup has to be done per client.

See the per-client pages for exact config blocks: [Claude Code](/clients/claude-code/), [Codex CLI](/clients/codex-cli/), [Gemini CLI](/clients/gemini-cli/).
