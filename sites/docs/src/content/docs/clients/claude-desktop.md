---
title: Claude Desktop
description: Connect Claude Desktop to a central Portuni server with a device token and search your team's files from chat.
---

Claude Desktop speaks MCP, but it cannot attach a bearer header to a remote server itself. The bridge is [`mcp-remote`](https://github.com/geelen/mcp-remote), which runs as a local stdio server and forwards every call to `https://<server>/mcp` with your device token.

## What you need

1. A central Portuni server (see [Team Setup](/getting-started/team-setup/)) and a Google account in one of its allowed domains.
2. A **device token**: in the desktop app open Settings → Účet → Device tokeny and create one. It is shown once; it inherits your current role and can be revoked from the same place.
3. Node.js on the machine running Claude Desktop (`npx` is used to start `mcp-remote`).

## Configuration

Add Portuni to `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "portuni": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://api.yourcompany.com/mcp",
        "--header",
        "Authorization:${PORTUNI_AUTH}"
      ],
      "env": {
        "PORTUNI_AUTH": "Bearer ptk_..."
      }
    }
  }
}
```

The `${PORTUNI_AUTH}` indirection (with no space after `Authorization:`) works around Claude Desktop splitting arguments on spaces; `mcp-remote` substitutes the variable from `env`. Restart Claude Desktop afterwards; the Portuni tools appear under the hammer icon.

## What works from here

There is no local mirror on this machine, so the tools behave like a remote agent's:

- **Graph**: `portuni_get_context`, `portuni_get_node`, `portuni_list_nodes`, actors, responsibilities, events — everything your role allows, filtered by node visibility.
- **Files**: `portuni_list_files` lists a node's files; `portuni_read_file(node_id, path)` reads the content straight from the remote (Google Drive) when no mirror exists; `portuni_search_files(query)` searches file **contents** through the remote's own full-text search and returns only files of nodes you can see. Open a hit with `portuni_read_file`.
- **Writes** that need a disk (`portuni_store`, `portuni_pull`, `portuni_mirror`, `portuni_adopt_files`) do not apply here; `portuni_snapshot` works — the server exports the document and registers the file remote-direct.

## Scope

A Claude Desktop session starts outside any mirror, so its read scope is empty. Start with `portuni_session_init` naming the node you work on (an organization seeds all its projects, processes and areas at depth 1), or let the tools' `scope_expansion_required` answers guide you to `portuni_expand_scope`. A global `portuni_search_files` without `node_id` is refused in the default `strict` scope mode; the server can run `PORTUNI_SCOPE_MODE=balanced` (one confirmation per session, then global queries over the session scope set pass) or `permissive`. See [Scope Enforcement](/concepts/scope-enforcement/).
