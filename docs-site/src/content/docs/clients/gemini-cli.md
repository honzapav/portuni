---
title: Gemini CLI
description: Connecting Gemini CLI to Portuni and including mirror folders in its workspace.
---

Google's [Gemini CLI](https://github.com/google-gemini/gemini-cli) uses an approval-based permission model similar to Claude Code, with an optional OS-level sandbox on top (macOS Seatbelt, or Docker/Podman on Linux).

## Register the MCP server

Add Portuni to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "portuni": {
      "httpUrl": "http://localhost:3001/mcp",
      "timeout": 5000
    }
  }
}
```

:::caution
Use `httpUrl` for Streamable HTTP, not `url` – the `url` key is reserved for SSE transport, which Portuni does not serve.
:::

Optional keys on the same object: `headers` (for auth), `trust` (skip per-tool approval), `timeout` (ms).

Reference: [docs/tools/mcp-server.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md).

## Accessing mirror folders

By default Gemini CLI treats `cwd` as the workspace root and ignores everything outside. Mirror folders therefore need to be included explicitly.

**At launch (recommended).** Pass `--include-directories` (max 5, comma-separated):

```bash
gemini --include-directories /Users/me/Workspaces/portuni
```

Scope is the current session only. Put the flag in a shell alias if you open Portuni mirrors regularly.

**Mid-session.** Inside a running session:

```
/directory add ~/Workspaces/portuni/q2-rebrand
/directory show
```

Adds the directory for the current session. The command is disabled under restrictive sandbox profiles – use `--include-directories` at launch in that case.

**Persistent (use with care).**

```json
{
  "context": {
    "includeDirectories": ["/Users/me/Workspaces/portuni"],
    "loadMemoryFromIncludeDirectories": true
  }
}
```

Every `gemini` session on the machine inherits the directory. Prefer the launch flag or slash command unless the machine is dedicated to Portuni.

:::caution
Open upstream issues ([#5512](https://github.com/google-gemini/gemini-cli/issues/5512), [#7365](https://github.com/google-gemini/gemini-cli/issues/7365)) report that `includeDirectories` in `settings.json` is sometimes ignored. `--include-directories` is more reliable today.
:::

## Approval modes

| Mode | Flag | Behaviour |
|------|------|-----------|
| `default` | none | Prompt on every tool call |
| `auto_edit` | `--approval-mode=auto_edit` | Auto-approve edits, ask for the rest |
| `plan` | `--approval-mode=plan` | Read-only planning mode |
| `yolo` | `--yolo` or `Ctrl+Y` | Auto-approve everything |

`--yolo` automatically turns on the sandbox.

## Sandbox

Enable with `--sandbox` / `-s`, `GEMINI_SANDBOX=true`, or `tools.sandbox: true` in settings.

- **macOS** – `sandbox-exec` with the `permissive-open` profile (writes restricted outside the project directory, most other operations allowed).
- **Linux / cross-platform** – Docker or Podman image `gemini-cli-sandbox`, customisable via `.gemini/sandbox.Dockerfile`.

Pair the sandbox with `--include-directories` so it picks up mirror folders. Directories added at runtime via `/directory add` are blocked under restrictive profiles.

## Multiple Portuni instances

Register each instance as its own MCP server in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "portuni": {
      "httpUrl": "http://localhost:3001/mcp"
    },
    "portuni-alt": {
      "httpUrl": "http://localhost:3002/mcp"
    }
  }
}
```

Gemini CLI does not ship a `SessionStart` equivalent. Bootstrap graph context by calling a Portuni tool at the start of the session.

## Reference

- [Configuration reference](https://geminicli.com/docs/reference/configuration/)
- [Sandboxing](https://geminicli.com/docs/cli/sandbox/)
- [MCP server configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
