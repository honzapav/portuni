---
title: Codex CLI
description: Connecting Codex CLI to Portuni and granting sandbox access to mirror folders.
---

OpenAI's [Codex CLI](https://github.com/openai/codex) enforces filesystem access in a **kernel sandbox** (macOS Seatbelt, Linux Landlock + seccomp). If you do not explicitly grant access to a mirror folder, the process cannot write to it – even if the model tries.

## Register the MCP server

Add Portuni to `~/.codex/config.toml`:

```toml
[mcp_servers.portuni]
url = "http://localhost:3001/mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Use `url` for Streamable HTTP. Do not combine `url` with the stdio-style `command` key in the same block.

Reference: [developers.openai.com/codex/config-reference](https://developers.openai.com/codex/config-reference).

## Sandbox modes

Codex runs every model-initiated command inside a sandbox. The mode is set by `sandbox_mode` in `config.toml`:

| Mode | Filesystem | Network |
|------|------------|---------|
| `read-only` | No writes anywhere | Off |
| `workspace-write` (default) | Write within `cwd`, `$TMPDIR`, `/tmp` | Off |
| `danger-full-access` | No restrictions | On |

`workspace-write` is the mode that matters for Portuni.

## Accessing mirror folders

A mirror like `~/Workspaces/portuni/q2-rebrand` is outside `cwd` when you launch Codex from a project folder. In `workspace-write` mode, Codex cannot write to it.

**At launch (recommended).** Use `--add-dir`:

```bash
codex --add-dir ~/Workspaces/portuni
```

Equivalent, more explicit form via `--config`:

```bash
codex --config sandbox_workspace_write.writable_roots='["/Users/me/Workspaces/portuni"]'
```

Put the flag in a project alias or README so every session that touches Portuni mirrors gets the right root.

**Mid-session.** Not supported. Because the sandbox is enforced by the OS kernel, there is no slash command to widen `writable_roots` once the session has started – you would need to exit and relaunch with `--add-dir`. A related command `/sandbox-add-read-dir` exists in some Codex builds but only grants **read-only** access, and only on Windows.

**Persistent (use with care).** In `~/.codex/config.toml`:

```toml
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
writable_roots = ["/Users/me/Workspaces/portuni"]
network_access = false
```

Every Codex session on the machine inherits this root, whether you launched it for Portuni or not. Prefer the launch flag unless the machine is dedicated to Portuni work.

:::note
Known issue [openai/codex#8029](https://github.com/openai/codex/issues/8029): the VS Code extension sometimes overwrites `writable_roots` with the active project path. The CLI respects `config.toml` as expected.
:::

## Network access

Portuni is reached over `localhost`. Codex allows the MCP transport even with `network_access = false`, because the connection is initiated by the host process, not by a sandboxed tool call. External HTTP calls from tools (e.g. `curl`) stay blocked unless you enable network explicitly:

```toml
[sandbox_workspace_write]
network_access = true
```

## Approval policy

Independent of the sandbox, `approval_policy` controls when Codex asks before running a command:

- `untrusted` – auto-run only known-safe read-only commands
- `on-request` (default) – model decides
- `never` – never ask
- granular allow/deny rules per category

Leave `on-request` on unless you have a reason not to.

## Multiple Portuni instances

Register each instance as its own MCP server in `~/.codex/config.toml`:

```toml
[mcp_servers.portuni]
url = "http://localhost:3001/mcp"

[mcp_servers.portuni-alt]
url = "http://localhost:3002/mcp"
```

Codex CLI does not ship a context-bootstrapping hook equivalent to Claude Code's `SessionStart`. Query graph context manually with a Portuni tool call at the start of the session.

## Reference

- [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing)
- [Configuration reference](https://developers.openai.com/codex/config-reference)
- [CLI slash commands](https://developers.openai.com/codex/cli/slash-commands)
