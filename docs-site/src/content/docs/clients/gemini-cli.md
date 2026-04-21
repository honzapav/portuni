---
title: Gemini CLI
description: Connecting Gemini CLI to Portuni and including your mirror folders in its workspace.
---

Google's [Gemini CLI](https://github.com/google-gemini/gemini-cli) works similarly to Claude Code in spirit – permissions are checked by the agent harness rather than the kernel – with an optional operating-system sandbox layer you can turn on if you want stricter isolation (macOS Seatbelt, or Docker/Podman elsewhere).

## Connect to Portuni

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
Use `httpUrl` for Streamable HTTP, not `url` – in Gemini CLI the `url` key is reserved for SSE transport, which Portuni doesn't serve. Easy to mix up, hard to notice.
:::

Other useful keys on the same object: `headers` (for auth), `trust` (skip per-tool approval prompts), `timeout` (in milliseconds).

For the full picture, see the [Gemini MCP server docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md).

## Letting Gemini into your mirror folders

Out of the box, Gemini CLI treats the directory you launched it from as its workspace and ignores everything else. Mirror folders living in a separate workspace root need to be included on purpose.

Three ways to do it:

**At launch (recommended).** Pass `--include-directories` – up to five, comma-separated:

```bash
gemini --include-directories /Users/me/Workspaces/portuni
```

Scope is the current session only. Bake it into a shell alias if you open Portuni mirrors often.

**Mid-session.** If you realise later that you need another folder:

```
/directory add ~/Workspaces/portuni/q2-rebrand
/directory show
```

Heads up: the slash command is disabled when running under a restrictive sandbox profile. In that case, use `--include-directories` at launch instead.

**Persistent (use with care).**

```json
{
  "context": {
    "includeDirectories": ["/Users/me/Workspaces/portuni"],
    "loadMemoryFromIncludeDirectories": true
  }
}
```

Every Gemini session on the machine now sees the folder. Useful on a dedicated workstation; otherwise the launch flag stays cleaner.

:::caution
A couple of upstream issues ([#5512](https://github.com/google-gemini/gemini-cli/issues/5512), [#7365](https://github.com/google-gemini/gemini-cli/issues/7365)) report that `includeDirectories` in `settings.json` is sometimes ignored. `--include-directories` on the command line is more reliable today.
:::

## Approval modes

Gemini CLI has a few different personalities when it comes to asking for confirmation:

| Mode | How to enable | What it does |
|------|---------------|--------------|
| `default` | no flag | Asks before every tool call |
| `auto_edit` | `--approval-mode=auto_edit` | Auto-approves edits; still asks for the rest |
| `plan` | `--approval-mode=plan` | Read-only planning – no writes execute |
| `yolo` | `--yolo` or `Ctrl+Y` | Auto-approves everything |

`--yolo` automatically turns the sandbox on, which is a sensible safety net when you're letting the agent act freely.

## The optional sandbox

If you'd like stronger isolation, Gemini can run the agent process inside a sandbox. Turn it on with `--sandbox` / `-s`, the `GEMINI_SANDBOX=true` env var, or `tools.sandbox: true` in settings.

- **macOS** – uses `sandbox-exec` with the `permissive-open` profile: writes outside the project directory are restricted, most other operations are allowed.
- **Linux / cross-platform** – uses a Docker or Podman image called `gemini-cli-sandbox`, which you can customise via `.gemini/sandbox.Dockerfile`.

Pair the sandbox with `--include-directories` so the sandbox image picks up your mirror folders at start-up. Runtime additions through `/directory add` are blocked under restrictive profiles.

## Running more than one Portuni instance

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

Gemini CLI doesn't ship a `SessionStart`-equivalent hook, so when you start a session, just call a Portuni tool (like `portuni_get_context`) as your first move to bootstrap context.

## Further reading

- [Configuration reference](https://geminicli.com/docs/reference/configuration/)
- [Sandboxing](https://geminicli.com/docs/cli/sandbox/)
- [MCP server configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
