---
title: Codex CLI
description: Connecting Codex CLI to Portuni and granting sandbox access to mirror folders.
---

OpenAI's [Codex CLI](https://github.com/openai/codex) takes a stricter approach to filesystem safety than most agents. Rather than checking permissions in the app, it runs every command inside an operating-system sandbox – on macOS via Seatbelt, on Linux via Landlock plus seccomp. The practical upshot: if you don't hand Codex the path to your Portuni mirror, it genuinely cannot write there. Even if the model really wants to.

This page walks you through connecting Codex to Portuni and granting it the access it needs – without opening the door wider than you meant to.

## Connecting to Portuni

If you run the desktop app, use **Settings → MCP Server → the Codex install button**: it writes one `[mcp_servers.portuni-<workspace-id>]` block per workspace into `~/.codex/config.toml`, pointing at that workspace's sidecar port (allocated from `47011` up) with the token referenced via `bearer_token_env_var = "PORTUNI_MCP_TOKEN_<ID>"`. A workspace migrated from a single-workspace install keeps the historical name `portuni`.

For a standalone CLI server, add Portuni to `~/.codex/config.toml` yourself:

```toml
[mcp_servers.portuni]
url = "http://localhost:4011/mcp"
bearer_token_env_var = "PORTUNI_MCP_TOKEN"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

The `url` key tells Codex this is a Streamable HTTP server. Don't mix `url` with the stdio-style `command` key in the same block – one or the other. The token has to come through env-var indirection: Codex's Streamable HTTP transport rejects a literal `bearer_token` field (the whole config fails to load). Export `PORTUNI_MCP_TOKEN` in your shell, or launch Codex from a terminal the desktop app spawned – those get the token variables injected. The standalone server requires the bearer header whenever `PORTUNI_AUTH_TOKEN` is set; the desktop sidecar always requires it.

For the full list of options, see OpenAI's [configuration reference](https://developers.openai.com/codex/config-reference).

## How the sandbox works

Codex runs every model-initiated command inside one of three sandbox modes, set by `sandbox_mode` in `config.toml`:

| Mode | What files it can write | What network it can reach |
|------|-------------------------|----------------------------|
| `read-only` | Nothing | Off |
| `workspace-write` (default) | The directory you launched from, plus `$TMPDIR` and `/tmp` | Off |
| `danger-full-access` | Everything | On |

For everyday Portuni work, `workspace-write` is the one that matters.

## Letting Codex into your mirror folder

Here's the situation that trips people up. You launch Codex from, say, `~/code/acme-marketing`, but a Portuni mirror lives at `~/Workspaces/portuni/q2-rebrand`. In `workspace-write` mode, that mirror is outside Codex's reach. It'll fail to write there – silently, if you're not watching.

Three ways to fix that:

**At launch (recommended).** Pass `--add-dir` with the mirror root:

```bash
codex --add-dir ~/Workspaces/portuni
```

Or the longer, config-override form:

```bash
codex --config sandbox_workspace_write.writable_roots='["/Users/me/Workspaces/portuni"]'
```

Stick the flag in a shell alias or a project README, and everyone opening a Portuni project on this machine gets it for free.

**Mid-session.** Not an option here. Because the sandbox is enforced by the kernel, Codex can't stretch it wider after it's started. If you realise mid-flight that you need another path, you'll have to exit and relaunch with a wider `--add-dir`. (There's a command called `/sandbox-add-read-dir` in some builds, but it's Windows-only and read-only – not much help for writing back to a mirror.)

**Persistent.** You can add the path to `~/.codex/config.toml` once and forget about it:

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = ["/Users/me/Workspaces/portuni"]
network_access = false
```

Just be aware: every Codex session on this machine now has access to that path, whether or not it's doing Portuni work. That's usually fine on a dedicated workstation, and worth thinking twice about on anything shared.

:::note
Heads-up: a known issue ([openai/codex#8029](https://github.com/openai/codex/issues/8029)) has the VS Code extension occasionally overwriting `writable_roots` with the active project path. The CLI respects `config.toml` the way you'd expect.
:::

## A quick word on network access

Portuni is reached through `localhost`, which Codex allows even with `network_access = false` – because the connection is initiated by the host process, not by a sandboxed tool call. Nothing to change here for Portuni itself.

What _is_ blocked by default is outbound HTTP from inside tool calls – things like `curl` or `npm install`. If you need that too, flip it on:

```toml
[sandbox_workspace_write]
network_access = true
```

## When Codex asks before running something

Alongside the sandbox, Codex has an `approval_policy` that decides when it pauses to check with you before running a command:

- `untrusted` – only known-safe read-only commands auto-run; everything else prompts
- `on-request` (default) – the model decides when to ask
- `never` – never prompts (worth thinking twice before picking this)
- granular allow/deny rules per category, if you want fine control

The default `on-request` is a reasonable middle ground. Only change it if you have a specific reason.

## Running more than one Portuni instance

With the desktop app this is the normal state, and the Codex install button handles it: every enabled workspace runs its own sidecar (loopback ports from `47011` up), and the button writes one `[mcp_servers.portuni-<workspace-id>]` block per workspace, each referencing its own `PORTUNI_MCP_TOKEN_<ID>` env var. Terminals spawned inside the app carry all of those variables (plus plain `PORTUNI_MCP_TOKEN` as an alias for the active workspace).

If you're running several standalone CLI servers instead (say, personal and team), register each in `~/.codex/config.toml` under its own name:

```toml
[mcp_servers.portuni]
url = "http://localhost:4011/mcp"
bearer_token_env_var = "PORTUNI_MCP_TOKEN"

[mcp_servers.portuni-alt]
url = "http://localhost:3002/mcp"
bearer_token_env_var = "PORTUNI_ALT_MCP_TOKEN"
```

One thing Codex does **not** get: per-mirror MCP wiring. The `.codex/config.toml` that `portuni_mirror` writes into a mirror carries only sandbox config (`writable_roots`) – the MCP connection lives in the user-scoped `~/.codex/config.toml`, which is node-agnostic. That means a Codex session never auto-seeds its scope from `?home_node_id` the way Claude Code and Vibe do: start with `portuni_session_init`, as the scope hint in `AGENTS.md` / `PORTUNI_SCOPE.md` reminds the agent.

## Further reading

- [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing)
- [Configuration reference](https://developers.openai.com/codex/config-reference)
- [CLI slash commands](https://developers.openai.com/codex/cli/slash-commands)
