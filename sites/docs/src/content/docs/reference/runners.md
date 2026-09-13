---
title: Runners
description: The adapter registry and provider instances behind a session's task — GET /runners, GET/POST/PATCH/DELETE /runners/instances.
---

A **runner** is a foreign coding agent (Claude Code today; Codex/OpenCode are a later step) the server spawns and drives through a canonical event model. This page documents the REST surface for detecting installed runners and managing **provider instances**, the server-side successor to the desktop's CLI spawn profiles.

## GET /runners

Lists every registered adapter and its detected availability. Detection is cached for 60 seconds per adapter.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Adapter id, e.g. `claude` |
| `availability.installed` | boolean | Whether the underlying CLI is installed on this host |
| `availability.version` | string \| null | Installed CLI version, when known |
| `availability.logged_in` | boolean | Whether the CLI has its own valid login |
| `availability.instances_supported` | boolean | Whether this runner can select a provider instance (e.g. `CLAUDE_CONFIG_DIR`) |

Requires `read` scope.

## Provider instances

An **instance** is a named set of environment variables (and which runner they apply to) a task can be started under — most commonly `CLAUDE_CONFIG_DIR`, to run a task under a different Claude Code account. Instances are persisted in `<dataDir>/runners.json` on the sidecar (`PORTUNI_DATA_DIR`; the standalone server keeps it next to its database). The file is device-local: in central mode the desktop routes every `/runners*` call to this device's own sync agent, never to the central server, so the Runnery tab always describes the machine a task would actually run on. This replaces the desktop's old `config.json` profiles registry (`apps/desktop/src/workspace.rs`), which is removed in a later step of the runner batch.

Env values are never returned to any client — every response below carries `env_keys` (names only), not the values. A secret-shaped key (matching `*_TOKEN`, `*_KEY`, `*_SECRET`, or containing `PASSWORD`, case-insensitive) or any `PORTUNI_*` key is refused outright on create/update with a 400 and `code: "INSTANCE_ENV_KEY_REFUSED"` — secrets belong in the OS keychain, not this registry. A leading `~` in a value expands to the server process's home directory when the env is actually read (server-side only), never on disk.

### GET /runners/instances

Returns `{ instances: RunnerInstanceSummary[] }`, each `{ id, name, runner, env_keys, org_defaults }`. `org_defaults` lists the organization node ids this instance is the default for. Requires `read` scope.

### POST /runners/instances

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Display name |
| `runner` | string | yes | Adapter id this instance applies to |
| `env` | object | no | Environment variables merged into a run started under this instance |

Returns the created `RunnerInstanceSummary` (201). Requires `write` scope.

### PATCH /runners/instances/:id

Same body shape as create, every field optional. An **empty string** submitted for an env key that already exists means "leave unchanged" — the client never receives values back to resubmit them verbatim, so a form pre-filled with blank fields for existing keys can still be saved without clobbering them. A key omitted from `env` entirely is dropped from the instance. Requires `write` scope; 404 for an unknown id.

### DELETE /runners/instances/:id

Requires `admin` scope, same tier as deleting any other entity in this API (actors, nodes, responsibilities, tools, data sources).

### PUT /runners/instances/:id/org-default

Body: `{ org_id: string }`. Sets this instance as the given organization's default — membership is exclusive, so the org is removed from every other instance's `org_defaults` first. Requires `write` scope; 404 for an unknown instance id.

### DELETE /runners/org-defaults/:orgId

Clears the given organization's default instance (no instance is the default for it afterwards). Requires `write` scope.
