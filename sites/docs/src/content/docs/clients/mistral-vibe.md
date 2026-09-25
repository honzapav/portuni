---
title: Mistral Vibe
description: Connecting Mistral Vibe to Portuni, how its layered config merges, and why a mirror needs --trust.
---

Mistral's [Vibe](https://github.com/mistralai/mistral-vibe) is a terminal coding agent that speaks MCP. Connecting it to Portuni works the same way as the other clients: one entry in `~/.vibe/config.toml`, written for you by the desktop app.

:::note
Portuni no longer writes a per-mirror `.vibe/config.toml`. That writer existed for the embedded terminal the desktop app used to launch Vibe from, which is gone — an agent runs as a task now, and a Vibe session is something you start yourself. Vibe therefore connects through the user-scoped `~/.vibe/config.toml`, without `?home_node_id=…`: a session starts **unscoped** and seeds its scope with `portuni_session_init` (or `portuni_expand_scope`). If you want auto-seed, write a project `.vibe/config.toml` yourself — the shape is below — and start Vibe with `--trust`. A file the old writer left in a mirror (it carries a `# portuni-managed` marker) is removed the next time the sidecar materializes that mirror; one you wrote yourself is never touched.
:::

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

The bearer token is read from an environment variable (`api_key_env`), never written to the file. The example above is the standalone-server shape, with plain `PORTUNI_MCP_TOKEN`; configs written by a desktop workspace point at that workspace's sidecar port (allocated from `47011` up) and reference the workspace-suffixed `PORTUNI_MCP_TOKEN_<WORKSPACE_ID>` instead. Export the token once in the shell you run Vibe from (Settings → MCP server → Copy token). An unset or empty variable means an empty bearer, and the server answers 401.

In the desktop app, **Settings → MCP server → "Přidat do Vibu (~/.vibe/config.toml)"** writes this for you — one entry per enabled workspace, named `portuni-<workspace-id>` (a workspace migrated from a single-workspace install keeps the historical name `portuni`) — merging the Portuni servers into your existing config without disturbing your models or providers.

## Auto-seed, if you want it: a hand-written project config

Appending `?home_node_id=<node id>` to the server URL is what makes a session seed its own read scope on connect — the same mechanism Claude Code gets from the per-mirror `.mcp.json` Portuni does still write. Vibe has no equivalent Portuni-managed file any more, so write one yourself in the mirror (`./.vibe/config.toml`, the block above with `?home_node_id=<id>` on the `url`).

## Why `--trust` matters for a project config

Vibe loads a project-level `./.vibe/config.toml` **only when the working directory is trusted**. If a folder isn't on Vibe's trust list (or you declined the trust prompt once — it then sits in `~/.vibe/trusted_folders.toml` under `untrusted` and is never asked about again), Vibe silently ignores the project config and falls back to `~/.vibe/config.toml`.

The fix is to launch with `--trust`, which trusts the working directory **for that session only** (it is *not* persisted to `trusted_folders.toml`):

```bash
vibe --trust
```

(Session trust overrides an `untrusted` entry, so you don't have to clean that file up.)

## How the config merges

Vibe layers config: the project file is merged **over** the user file rather than replacing it. Lists like `mcp_servers` use a union merge keyed by `name`, so:

- Your `~/.vibe/config.toml` keeps your models, providers, API key, and tool settings.
- A mirror's own `.vibe/config.toml` only needs the single `portuni` server entry.
- When both define `portuni`, the project entry (with `home_node_id`) wins.

So a project file can stay minimal and never clobbers your global setup. It is a dot-path, so Portuni's sync walker ignores it and the device-specific URL/port never propagates to teammates.

## Filesystem access

Trusting a folder (via `--trust` or Vibe's trust prompt) is also what lets Vibe read and write there. For directories outside the working tree, pass `--add-dir <path>` (implicitly trusted for the session).

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
