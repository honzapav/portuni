---
title: Custom Connector (OAuth)
description: Connect claude.ai, Claude Desktop, Claude mobile, and Claude Code to a central Portuni server with one URL and a Google login — no device token, no config file.
---

A central Portuni server running in `google` auth mode with `PORTUNI_PUBLIC_URL` set is itself an OAuth 2.1 authorization server. Claude's chat clients (claude.ai web, Claude Desktop's chat, mobile) and Claude Code can add it as a **custom connector**: paste one URL, log in with Google, approve a consent screen. There is no config file to write and no token to copy anywhere.

This is the connector path. If your server still runs `PORTUNI_AUTH_MODE=env` (solo/legacy), or you need a client that doesn't support OAuth connectors, use a [device token](/clients/claude-desktop/) with `mcp-remote` instead — that path keeps working unchanged alongside this one.

## What you need

1. A central Portuni server in `google` auth mode, reachable over HTTPS, with `PORTUNI_PUBLIC_URL` set to its public base URL (admin setup — see `docs/env-vars.md` in the repo).
2. A Google account in one of the server's allowed Workspace domains.

Nothing else — no device token, no `mcp-remote`, no local Node.js.

## claude.ai, Claude Desktop, Claude mobile

These all share the same connector UI:

1. Settings → Connectors → **Add custom connector**.
2. Paste your server's MCP URL: `https://<your-server>/mcp`.
3. Claude opens a browser tab to log in with Google. Pick the account in the server's allowed domain.
4. A consent screen shows who you're signing in as and which client is asking (Claude) — **Allow**.
5. Claude reconnects with a token it now holds itself; the Portuni tools appear like any other connector.

You'll see this consent screen again roughly every 180 days (or sooner if an admin revokes the connection) — it is never silently remembered, by design.

## Claude Code

```bash
claude mcp add --transport http portuni-central https://<your-server>/mcp
```

Claude Code opens the same browser-based login + consent flow on a loopback redirect. Once it completes, the connector behaves like any `http` MCP server in `~/.claude.json` — no token env var to export.

## What works from here

Same as any client with no local mirror — see the "What works from here" and "Scope" sections on the [Claude Desktop](/clients/claude-desktop/) page. Observable scope behavior (empty read scope at start, edge-reachable auto-expansion, disconnected jumps and hard floors needing confirmation, discovery search never gated) is identical. One difference under the hood: an OAuth connector session is the `interactive_chat` [session type](/concepts/scope-enforcement/#session-types) rather than `interactive_task` — irrelevant here since both start with no home node, but it means the write-scope set stays empty for the whole session (every write elicits) rather than potentially widening around a task anchor.

## Revoking access

Settings → Účet → **Připojené aplikace** in the desktop app (or ask an admin) lists every connected client with its connect date and last-used time, and an **Odpojit** button. Revoking invalidates that client's access immediately — it has to log in and consent again to reconnect.

## Why not `mcp-remote` here

`mcp-remote` bridges a bearer device token into an MCP session — it has no notion of Google login or consent, and nothing to gain from OAuth once a token already exists. The connector path exists precisely to skip minting and copying that token by hand; use whichever one matches how your server is configured.
