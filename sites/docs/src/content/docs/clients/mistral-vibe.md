---
title: Mistral Vibe
description: Connecting Mistral Vibe to Portuni, why it needs --trust to auto-seed scope, and how its layered config merges.
---

Mistral's [Vibe](https://github.com/mistralai/mistral-vibe) is a terminal coding agent that speaks MCP. Connecting it to Portuni works the same way as the other clients, with one Vibe-specific wrinkle: **Vibe only loads a project's `.vibe/config.toml` when the folder is trusted**, and that's exactly the file Portuni uses to auto-seed your scope. Get the trust step right and Vibe behaves like Claude Code — start in a mirror, and the home node is already in scope.

## Connecting to Portuni

Vibe is configured through `config.toml`, found first in `./.vibe/config.toml` (project) and then `~/.vibe/config.toml` (user). MCP servers live under `mcp_servers`:

```toml
[[mcp_servers]]
name = "portuni"
transport = "streamable-http"
url = "http://localhost:4011/mcp"

[mcp_servers.auth]
type = "static"
api_key_env = "PORTUNI_MCP_TOKEN"
api_key_header = "Authorization"
api_key_format = "Bearer {token}"
```

The bearer token is read from the `PORTUNI_MCP_TOKEN` environment variable (`api_key_env`), never written to the file. The Portuni desktop app injects that variable into terminals it spawns; for shells you open yourself, export it once (Settings → MCP server → Copy token).

In the desktop app, **Settings → MCP server → "Přidat do Vibu (~/.vibe/config.toml)"** writes this block for you, merging the Portuni server into your existing config without disturbing your models or providers.

## Why `--trust` matters

Vibe loads a project-level `./.vibe/config.toml` **only when the working directory is trusted**. If a folder isn't on Vibe's trust list (or you declined the trust prompt once — it then sits in `~/.vibe/trusted_folders.toml` under `untrusted` and is never asked about again), Vibe silently ignores the project config and falls back to `~/.vibe/config.toml`.

That fallback connection has no `?home_node_id=…`, so the session starts **unscoped** — and the agent has to call `portuni_expand_scope` (and confirm) before it can read its own node.

The fix is to launch with `--trust`, which trusts the working directory **for that session only** (it is *not* persisted to `trusted_folders.toml`):

```bash
vibe --trust
```

The desktop app's "Mistral Vibe" agent preset is `vibe --trust {prompt}` precisely for this reason, so every terminal it spawns inside a mirror loads the project config and auto-seeds. (Session trust overrides an `untrusted` entry, so you don't have to clean that file up.)

## Auto-seed, the same as Claude Code

When `portuni_mirror` materialises a mirror, it writes a `.vibe/config.toml` whose Portuni server URL carries `?home_node_id=<id>` — the same mechanism Claude Code gets from `.mcp.json`. The first time Vibe opens an MCP session inside that mirror (with `--trust`), the Portuni server reads the param and seeds the read scope with the home node plus its depth-1 neighbors. No opening tool call, no expand-scope prompt — scope is just ready.

## How the config merges

Vibe layers config: the project file is merged **over** the user file rather than replacing it. Lists like `mcp_servers` use a union merge keyed by `name`, so:

- Your `~/.vibe/config.toml` keeps your models, providers, API key, and tool settings.
- The mirror's `.vibe/config.toml` only needs the single `portuni` server entry.
- When both define `portuni`, the project entry (with `home_node_id`) wins.

That's why the per-mirror file Portuni writes is minimal and safe — it never clobbers your global setup. The mirror file is a dot-path, so Portuni's sync walker ignores it and the device-specific URL/port never propagates to teammates.

## Filesystem access

Trusting a folder (via `--trust` or Vibe's trust prompt) is also what lets Vibe read and write there. For directories outside the working tree, pass `--add-dir <path>` (implicitly trusted for the session). When Vibe runs inside a terminal the desktop app spawned, the OS-level Seatbelt sandbox still scopes writes to the node's mirror regardless of Vibe's own tool permissions.

## Tool permissions

Vibe gates MCP tools with a per-tool `permission` (`ask` / `always`), stored in `config.toml` as `[tools.<server>_<tool>]`. Choosing "Always allow" for a Portuni tool writes e.g.:

```toml
[tools.portuni_portuni_expand_scope]
permission = "always"
```

To revert, delete that section (or set `permission = "ask"`).

## Further reading

- [Vibe configuration](https://docs.mistral.ai/vibe/code/cli/configuration)
- [Vibe MCP servers](https://docs.mistral.ai/vibe/code/cli/mcp-servers)
