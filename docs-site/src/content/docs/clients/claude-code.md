---
title: Claude Code
description: Connecting Claude Code to Portuni and giving it access to your mirror folders.
---

Anthropic's Claude Code is the agent most Portuni users start with. It's the one we've tested the most and the one that ships with the `SessionStart` hook integration, so graph context lands in the agent without you having to lift a finger.

## Connect to Portuni

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
Use `type: "http"` (Streamable HTTP), not `"sse"` – Claude Code quietly ignores SSE transport in the global config, and you'll be left wondering why nothing's connecting.
:::

## Letting Claude Code into your mirror folders

Claude Code checks filesystem access through its own rules, not through an operating-system sandbox. By default it can read and write inside the directory you launched it from. Anything outside – including mirror folders in a separate workspace – needs a nudge.

You have three options, from friendliest to heaviest:

**At launch (recommended).** Pass `--add-dir`:

```bash
claude --add-dir ~/Workspaces/portuni
```

Everything below that path is accessible for this session only. Drop the flag into a shell alias or a project README if you open Portuni projects regularly.

**Mid-session.** If you realise halfway through that you need another folder:

```
/add-dir ~/Workspaces/portuni/q2-rebrand
```

Note: `.claude/` configuration from the added directory is **not** picked up – you're granting file access, not importing settings.

**Persistent (use with care).** Adding to `~/.claude/settings.json` hands every Claude Code session on the machine access to the folder, regardless of what you launched it for:

```json
{
  "permissions": {
    "additionalDirectories": ["/Users/me/Workspaces/portuni"]
  }
}
```

Fine on a workstation dedicated to Portuni. Worth thinking twice about on anything shared.

## The SessionStart hook

One of Claude Code's nicer tricks is the `SessionStart` hook – a script that runs at the start of every session. Portuni ships one at `scripts/portuni-context.sh` that automatically injects the right graph context whenever you start work inside a Portuni mirror folder.

Register it in `~/.claude/settings.json`:

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

Replace the `command` path with the absolute path to your Portuni checkout. The hook asks Portuni whether your current working directory corresponds to a known workspace; if nothing matches it exits silently without touching your conversation.

## Running more than one Portuni instance

If you're running several Portuni servers side by side, register each as its own MCP server in `~/.claude.json`:

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

The `SessionStart` hook script can route across all of them. It reads a space-separated list of base URLs from `PORTUNI_URLS`, tries each one in turn, and uses the first one whose workspace matches your current directory.

Export the variable in your shell startup file (e.g. `~/.zshrc`):

```bash
export PORTUNI_URLS="http://localhost:3001 http://localhost:3002"
```

If `PORTUNI_URLS` isn't set, the hook falls back to `PORTUNI_URL` (a single URL), and ultimately to `http://localhost:3001`. You only need one hook entry in `settings.json` – the script handles routing across instances.

## Plan mode and bypass mode

A couple of useful modes worth knowing about:

- **Plan mode** (default `Shift+Tab`) – read-only exploration. Useful when you're still figuring out what you want the agent to do and don't want it writing anything yet.
- **Bypass mode** (`--dangerously-skip-permissions`) – skips every permission check. Handy inside ephemeral sandboxes (Docker, VMs); worth avoiding on a host machine with a populated Portuni mirror root.
