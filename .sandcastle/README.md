# Sandcastle loop (Portuni)

Autonomous agent (Claude Code, personal account, model from `SANDCASTLE_MODEL`,
default Sonnet 5) that works through GitHub issues labelled `ready-for-agent`
and commits to a batch branch `ralph/backlog-YYYY-MM-DD`. Orchestrated by
[`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle): the agent
runs in a Docker container over a bind-mounted git worktree, survives Claude
usage limits (waits for the reset, resumes). Harness derived from
`workflow-account-manager/.sandcastle`.

## Files

| File | Purpose |
|---|---|
| `main.mts` | Supervisor: `run()` in a limit-survival loop with backoff |
| `limit.mts` (+ test) | Limit message detection and reset-wait computation |
| `prompt.md` | RALPH prompt: issue selection, gate, publish rules, `{{SCOPE}}` |
| `start-loop.sh` | Launcher: fail-fast checks + tmux + caffeinate |
| `Dockerfile` | node:22 + gh + claude-code + Rust toolchain + Tauri Linux deps |
| `env.example` | Template for `.env` (gitignored): Claude token + GitHub PAT |
| `logs/` | `loop.log` (supervisor) + per-run agent logs |
| `worktrees/` | Agent git worktree (bind-mounted into the container) |

## Prerequisites

1. Docker Desktop running.
2. `.sandcastle/.env` filled from `env.example`.
3. `(cd .sandcastle && npm ci)`.
4. Image built: `./.sandcastle/node_modules/.bin/sandcastle docker build-image --image-name sandcastle:portuni --dockerfile .sandcastle/Dockerfile`
5. Main working tree not on the batch branch (`git checkout main`), fast-forward of `origin/main`.

## Run (from another Mac)

```bash
ssh honzas-macbook-pro 'cd ~/Dev/projekty/portuni && ./.sandcastle/start-loop.sh'
```

Watch: `ssh -t honzas-macbook-pro 'tmux attach -t sandcastle-portuni'` (detach Ctrl-b d).
Stop: `ssh honzas-macbook-pro 'tmux kill-session -t sandcastle-portuni'`.

Environment knobs: `SANDCASTLE_MODEL`, `SANDCASTLE_BRANCH`, `SANDCASTLE_SCOPE`
(e.g. `"only issue #84"`), `SANDCASTLE_MAX_ITERATIONS`, `SANDCASTLE_MAX_RUNS`.

## Portuni specifics

- The gate is `scripts/agent-gate.sh`, the same checks CI runs (server qa,
  web typecheck + build, `cargo test` + clippy, docs site build). The container
  carries the Rust toolchain and Tauri Linux dependencies for that; the first
  `cargo` run in a fresh worktree takes ~10 min, later runs are incremental
  (`target/` lives in the worktree).
- `scripts/desktop-dev-placeholders.sh` stands in for the sidecar binary
  tauri-build expects; the real sidecar and the DMG are built by `release.yml`.
- No production credentials in the container: no Turso, Apple, Google or Drive
  secrets. macOS-only work (updater signing key, `.app` end-to-end tests,
  release publishing) is filed as `human-only` issues.
- The agent opens or updates one PR per batch branch and never merges it.
  PR title must be a Conventional Commit (`pr-title.yml`, release-please).
