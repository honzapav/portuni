---
title: Claude Code
description: Connecting Claude Code to Portuni and granting it access to mirror folders.
---

## Register the MCP server

Add Portuni to `~/.claude.json`:

```json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

:::caution
Use `type: "http"` (Streamable HTTP), not `"sse"`. Claude Code ignores SSE transport in global config.
:::

## Accessing mirror folders

Claude Code enforces filesystem access in the **harness** – tool calls are checked against rules before they run. By default it can read and write inside the directory you launched it from. Portuni mirrors often live outside that directory, so the agent needs explicit access.

**At launch (recommended).** Pass `--add-dir` with the mirror root:

```bash
claude --add-dir ~/Workspaces/portuni
```

Every subdirectory under the given path is available for this session only. Put the flag in a shell alias or a project README if you open Portuni projects regularly.

**Mid-session.** Inside a running session:

```
/add-dir ~/Workspaces/portuni/q2-rebrand
```

Adds the directory for the current session. Note that `.claude/` configuration is **not** re-discovered from the added directory – only file access is granted.

**Persistent (use with care).** Adding to `~/.claude/settings.json` gives every Claude Code session on the machine access, whether you launched it for Portuni or not:

```json
{
  "permissions": {
    "additionalDirectories": ["/Users/me/Workspaces/portuni"]
  }
}
```

Reserve for workstations dedicated to Portuni work.

## SessionStart hook

The hook at `scripts/portuni-context.sh` injects graph context on every session start. Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/portuni/scripts/portuni-context.sh",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Replace the `command` path with the absolute path to your Portuni checkout. The hook queries Portuni for whichever workspace the current directory belongs to; if nothing matches it exits silently.

## Multiple Portuni instances

Register each running instance as its own MCP server in `~/.claude.json`:

```json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    },
    "portuni-alt": {
      "type": "http",
      "url": "http://localhost:3002/mcp"
    }
  }
}
```

The `SessionStart` hook script accepts a space-separated list of base URLs via the `PORTUNI_URLS` environment variable. It tries each URL in order and uses the first server whose workspace matches the current working directory.

Export the variable in your shell startup file (e.g. `~/.zshrc`):

```bash
export PORTUNI_URLS="http://localhost:3001 http://localhost:3002"
```

If `PORTUNI_URLS` is not set, the hook falls back to `PORTUNI_URL` (single URL), and finally to `http://localhost:3001`.

## Plan and bypass modes

- **Plan mode** (default `Shift+Tab`): read-only exploration, no tool writes execute.
- **Bypass mode** (`--dangerously-skip-permissions`): skips all permission checks. Useful in ephemeral sandboxes; avoid on a host machine with a populated Portuni mirror root.
