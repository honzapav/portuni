---
title: Claude Code
description: Connecting Claude Code to Portuni and giving it access to your mirror folders.
---

Anthropic's Claude Code is the agent most Portuni users start with. It's the one we've tested the most and gets project-scoped MCP wiring + write-scope rules generated for free when you `portuni_mirror` a node.

## Connect to Portuni

If you run the desktop app, you don't do this by hand: **Settings → MCP Server → the Claude Code install button** writes one entry per workspace into `~/.claude.json`, named `portuni-<workspace-id>` and pointing at that workspace's sidecar port (allocated from `47011` up), token included. A workspace migrated from a single-workspace install keeps the historical name `portuni`.

For a standalone CLI server, add Portuni to `~/.claude.json` yourself:

```json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:4011/mcp",
      "headers": {
        "Authorization": "Bearer ${PORTUNI_MCP_TOKEN:-}"
      }
    }
  }
}
```

Claude Code expands `${VAR:-}` at config load, so the token stays out of the file – export `PORTUNI_MCP_TOKEN` in your shell (Settings → MCP Server → Copy token in the desktop app). The standalone server requires the header whenever `PORTUNI_AUTH_TOKEN` is set; the desktop sidecar always requires it.

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

When `portuni_mirror` materialises a mirror's config, the generated `.mcp.json` URL carries `?home_node_id=<id>`. The first time Claude Code opens an MCP session inside that mirror, the Portuni server reads the param and seeds the read scope with the home node + its depth-1 neighbors – no hook, no opening tool call, scope is just ready. Server-side the mechanism is client-agnostic, but `.mcp.json` is the only per-mirror connection file Portuni writes: Codex's per-mirror `.codex/config.toml` carries only sandbox config, and Mistral Vibe has no Portuni-managed project file at all, so both start unscoped and rely on `portuni_session_init` instead.

## Running more than one Portuni instance

With the desktop app this is the normal state, and it's managed for you: every enabled workspace runs its own sidecar (loopback ports allocated from `47011` up), and the install button in Settings writes one `~/.claude.json` entry per workspace, named `portuni-<workspace-id>` – so tool names become `mcp__portuni-<id>__portuni_get_node` and so on. A workspace migrated from the single-workspace era keeps the historical name `portuni`. Per-mirror configs reference each workspace's token by name (`PORTUNI_MCP_TOKEN_<ID>`), never a literal, so the right credential resolves no matter which workspace a folder belongs to — export it in the shell you run Claude Code from (Settings → MCP server → Copy token). The app has no terminal of its own to export it for you.

If you're running several standalone CLI servers instead, register each as its own MCP server in `~/.claude.json` yourself:

```json
{
  "mcpServers": {
    "portuni": {
      "type": "http",
      "url": "http://localhost:4011/mcp",
      "headers": { "Authorization": "Bearer ${PORTUNI_MCP_TOKEN:-}" }
    },
    "portuni-alt": {
      "type": "http",
      "url": "http://localhost:3002/mcp",
      "headers": { "Authorization": "Bearer ${PORTUNI_ALT_MCP_TOKEN:-}" }
    }
  }
}
```

Each mirror's project-scoped `.mcp.json` (written by the Portuni instance that owns it) points at the right server with the right `home_node_id`, so opening a session in any mirror folder Just Works without manual routing.

## Plan mode and bypass mode

A couple of useful modes worth knowing about:

- **Plan mode** (default `Shift+Tab`) – read-only exploration. Useful when you're still figuring out what you want the agent to do and don't want it writing anything yet.
- **Bypass mode** (`--dangerously-skip-permissions`) – skips every permission check. Handy inside ephemeral sandboxes (Docker, VMs); worth avoiding on a host machine with a populated Portuni mirror root.

## Claude Code jako runner

Everything above is about a hand-opened terminal. A **task** started from a
node's "Nový úkol" button (or `POST /sessions`) runs Claude Code the same
way, but Portuni drives it directly over
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
instead of spawning a terminal:

- The node's mirror is the working directory, and the task's brief becomes
  the first message — no manual `cd` or prompt needed.
- The node's context (name, goal, recent events, a handoff pointer if
  you're resuming) is appended to Claude Code's own system prompt, the same
  content a hand-opened terminal gets in `PORTUNI_SCOPE.md`.
- Permission decisions follow the same write-scope rules as the guard hook
  (`.claude/settings.local.json`) — editing inside the current mirror is
  allowed automatically, editing another node's mirror is refused, and a
  scope-expanding or plan-approval request shows up as a question in the
  task's chat instead of a terminal prompt.
- **Login stays entirely in the CLI.** The task runner uses whatever
  account `claude` is already logged into on this machine (`CLAUDE_CONFIG_DIR`,
  set per Runnery instance in Settings → Runnery, selects which one) — Portuni
  never asks for or stores Anthropic credentials of its own.
- If nothing is logged in, the task's chat shows an error saying so instead
  of quietly failing.

Nastavení → Runnery shows whether `claude` is installed and logged in on
this device (`claude --version` / `claude auth status`), and lets you
manage the provider instances (name, environment, default per organization)
a task's runner picks from when more than one exists.
