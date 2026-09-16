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

Returns `{ instances: RunnerInstanceSummary[] }`, each `{ id, name, runner, env_keys, org_defaults, defaults }`. `org_defaults` lists the organization node ids this instance is the default for. `defaults` (`{ model?, effort? }`) is this instance's own model/reasoning-effort default, used by any thread started under it that doesn't override them itself — see [model and effort resolution](#model-and-reasoning-effort) below. Requires `read` scope.

### POST /runners/instances

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Display name |
| `runner` | string | yes | Adapter id this instance applies to |
| `env` | object | no | Environment variables merged into a run started under this instance |
| `defaults` | object | no | `{ model?: string, effort?: "low"\|"medium"\|"high"\|"xhigh"\|"max" }` -- an unknown key or an invalid `effort` value is refused with 400 `INSTANCE_DEFAULTS_KEY_REFUSED` |

Returns the created `RunnerInstanceSummary` (201). Requires `write` scope.

### PATCH /runners/instances/:id

Same body shape as create, every field optional. An **empty string** submitted for an env key that already exists means "leave unchanged" — the client never receives values back to resubmit them verbatim, so a form pre-filled with blank fields for existing keys can still be saved without clobbering them. A key omitted from `env` entirely is dropped from the instance. `defaults`, when given, replaces the instance's defaults wholesale (not merged key-by-key like `env`). Requires `write` scope; 404 for an unknown id.

### DELETE /runners/instances/:id

Requires `admin` scope, same tier as deleting any other entity in this API (actors, nodes, responsibilities, tools, data sources).

### PUT /runners/instances/:id/org-default

Body: `{ org_id: string }`. Sets this instance as the given organization's default — membership is exclusive, so the org is removed from every other instance's `org_defaults` first. Requires `write` scope; 404 for an unknown instance id.

### DELETE /runners/org-defaults/:orgId

Clears the given organization's default instance (no instance is the default for it afterwards). Requires `write` scope.

## Model and reasoning effort

`POST /sessions` and `PATCH /sessions/:id` both accept `model` (a runner-defined model id/alias, free text) and `effort` (`"low" | "medium" | "high" | "xhigh" | "max"`), and `SessionSummary` carries both back. Either is a per-thread override; when unset, the value resolves at the start of every run, first match wins:

1. The thread's own `sessions.model` / `sessions.effort` (set at creation or by a later `PATCH`).
2. The runner instance's own `defaults`, when the thread has one.
3. Unset — the runner's own default (for Claude Code, whatever the `claude` binary defaults to).

Setting `model` on a thread with a live run also switches that run's live process immediately, no restart — the Claude adapter forwards it to the SDK's `Query.setModel`. Reasoning effort has no equivalent: the SDK only accepts it when a run starts, so a change there applies from the *next* run, never the current one. The task chat's composer has a picker for both (see below); either can also be set directly through this REST surface or an instance's `defaults`.

### GET /runners/:runner/models

Returns `{ models: RunnerModel[] }`, each `{ id, displayName, description, supportsEffort, effortLevels }` — `id` is what a caller sends back as `model`. Requires `read` scope; 404 `UNKNOWN_RUNNER` for an unregistered runner id.

The Claude adapter never starts a process just to answer this: before this server process has run any task under this runner, it returns the three documented aliases (`sonnet`, `opus`, `haiku` — the SDK accepts any of these as a bare `model` string) with `supportsEffort: false`, since the real per-model answer isn't known yet. The first live run fills a process-wide cache from the SDK's own `Query.supportedModels()`, and every call after — for any session, on this device — serves that cached list instead. A model not in the list can still be sent as free text; the picker in the app doesn't restrict to it.

The task chat's composer (Práce) shows this list in a model selector, preselecting the thread's own `session.model` (blank means "use the resolved default" above). A reasoning-effort selector appears next to it only when the currently-selected model's `supportsEffort` is true, offering that model's own `effortLevels`; it's labelled as applying from the next run, matching the REST behavior above.
