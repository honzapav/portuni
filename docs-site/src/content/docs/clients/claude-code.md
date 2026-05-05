---
title: Claude Code
description: Connecting Claude Code to Portuni and giving it access to your mirror folders.
---

Anthropic's Claude Code is the agent most Portuni users start with. It's the one we've tested the most and gets project-scoped MCP wiring + write-scope rules generated for free when you `portuni_mirror` a node.

## Connect to Portuni

Add Portuni to `~/.claude.json`:

```json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:4011/mcp"
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

## Auto-seed on connect

When `portuni_mirror` materialises a mirror's config, the generated `.mcp.json` URL carries `?home_node_id=<id>`. The first time Claude Code opens an MCP session inside that mirror, the Portuni server reads the param and seeds the read scope with the home node + its depth-1 neighbors – no hook, no opening tool call, scope is just ready. The same mechanism works for any MCP-capable client (Codex, etc.); it's not Claude Code-specific.

## Running more than one Portuni instance

If you're running several Portuni servers side by side, register each as its own MCP server in `~/.claude.json`:

```json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:4011/mcp"
    },
    "portuni-alt": {
      "type": "http",
      "url": "http://localhost:3002/mcp"
    }
  }
}
```

Each mirror's project-scoped `.mcp.json` (written by the Portuni instance that owns it) points at the right server with the right `home_node_id`, so opening a session in any mirror folder Just Works without manual routing.

## Plan mode and bypass mode

A couple of useful modes worth knowing about:

- **Plan mode** (default `Shift+Tab`) – read-only exploration. Useful when you're still figuring out what you want the agent to do and don't want it writing anything yet.
- **Bypass mode** (`--dangerously-skip-permissions`) – skips every permission check. Handy inside ephemeral sandboxes (Docker, VMs); worth avoiding on a host machine with a populated Portuni mirror root.
