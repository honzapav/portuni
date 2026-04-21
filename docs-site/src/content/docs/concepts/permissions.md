---
title: Filesystem Permissions
description: How each MCP client handles access to mirror folders outside the current project.
---

Portuni's data lives in two places: the graph – which sits in Turso or SQLite and is reached entirely through MCP – and your [local mirrors](/concepts/mirrors/), which are real folders on your disk. The graph never needs filesystem access. Mirrors absolutely do.

And that's where things get interesting. Mirror folders often live outside the directory where you launched your AI agent, and every CLI has its own opinion about whether the agent is allowed to read or write there.

This page is the single place that explains why – because "Portuni works fine but the agent can't touch the mirror folder" is a very common trap, and understanding the models makes it much easier to avoid.

## Three clients, three different philosophies

| Client | Where it's enforced | What happens if you forget to grant access |
|--------|---------------------|---------------------------------------------|
| Claude Code | In the agent harness – a policy check before each tool call | Agent asks for per-session approval |
| Codex CLI | In the operating-system kernel (Seatbelt / Landlock + seccomp) | Write silently fails; the model may not even notice |
| Gemini CLI | In the agent harness, with an optional kernel sandbox on top | Mirror files simply don't appear in the agent's world |

### Claude Code

Claude Code is **policy-based**. Before each tool call, the harness checks it against allow/deny rules you've set in `settings.json`. The kernel never gets involved; everything is handled inside the agent. Granting access is a matter of adding the mirror root to `permissions.additionalDirectories` or passing `--add-dir` at launch.

### Codex CLI

Codex takes the strictest approach: a real **kernel sandbox**. On macOS it uses `sandbox-exec`; on Linux it combines Landlock with seccomp. A model that tries to write outside its allowed roots genuinely cannot – the operating system itself refuses. That makes Codex attractive when you want to hand agents a lot of autonomy. It also means a missing `writable_roots` entry is a hard block, with no in-session escape hatch.

### Gemini CLI

Gemini CLI lives somewhere in between. At heart it's harness-based like Claude Code, but it adds an **explicit workspace concept**: the agent only sees directories that have been listed (via `includeDirectories`, `--include-directories`, or `/directory add`). Everything else simply doesn't exist from the agent's point of view – so there's nothing to deny, because there's nothing to see. An optional operating-system sandbox can be layered on top for extra safety.

## Our recommendation: grant access at launch, not globally

The instinct, when you first hit this, is to drop your mirror root into each client's user-level config and forget about it – `~/.claude/settings.json`, `~/.codex/config.toml`, or `~/.gemini/settings.json`. That works, but it also means **every** session on the machine now has access to those folders, whether or not you intended. It's a quiet global default, and it's easy to forget about.

The safer habit is to grant access when you launch the client. The scope is obvious, the path is tied to the command that needs it, and you can bake it into a shell alias or a project README so the team picks it up for free.

| Client | At launch (recommended) | Mid-session | Persistent (quiet global default) |
|--------|-------------------------|-------------|------------------------------------|
| Claude Code | `claude --add-dir <path>` | `/add-dir <path>` | `permissions.additionalDirectories` |
| Codex CLI | `codex --add-dir <path>` | — requires restart | `[sandbox_workspace_write].writable_roots` |
| Gemini CLI | `gemini --include-directories <path>` | `/directory add <path>` | `context.includeDirectories` |

A few practical notes:

- Bake the flag into a shell alias or a project README so anyone opening a Portuni mirror gets it without thinking about it.
- Codex CLI gives you no mid-session escape – once it's running, the sandbox is fixed. Decide which roots you need before you launch.
- Persistent config is perfectly reasonable on machines dedicated to Portuni, where the global default matches reality. Just pick it deliberately, rather than by accident.

## Why Portuni doesn't solve this for you

Portuni is the MCP server. It returns paths and records where files live, but it never reaches into your filesystem from the agent's side. The file access belongs to the client, by design. Keeping those two concerns separate is what lets Portuni stay thin and pluggable – and it's what lets you swap Claude Code for Codex, or add Gemini on the side, without changing anything on the server.

The price of that separation is that filesystem permissions need to be set up once per client. Fortunately, that's a five-minute job each.

For exact config blocks, see the per-client pages: [Claude Code](/clients/claude-code/), [Codex CLI](/clients/codex-cli/), [Gemini CLI](/clients/gemini-cli/).
