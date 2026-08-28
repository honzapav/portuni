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
| `.env` | Variable names only (empty values); `start-loop.sh` fills them from the Keychain |
| `logs/` | `loop.log` (supervisor) + per-run agent logs |
| `worktrees/` | Agent git worktree (bind-mounted into the container) |

## Prerequisites

1. Docker Desktop running.
2. Keychain entries on the old Mac (values never on disk). Its login keychain
   is locked in ssh sessions, so unlock it in the same `ssh -t` command:
   ```bash
   ssh -t honzas-macbook-pro 'security unlock-keychain ~/Library/Keychains/login.keychain-db && \
     security add-generic-password -U -s sandcastle.claude-code.oauth-token -a "$USER" -w && \
     security add-generic-password -U -s sandcastle.portuni.github-pat -a "$USER" -w'
   ```
   Each `-w` without a value prompts for it hidden. Claude token: `claude setup-token`
   (personal profile). GitHub: PAT with Issues, Pull requests, Contents (RW),
   Metadata on `honzapav/portuni`.
3. `(cd .sandcastle && npm ci)`.
4. Image built: `./.sandcastle/node_modules/.bin/sandcastle docker build-image --image-name sandcastle:portuni --dockerfile .sandcastle/Dockerfile`
5. Main working tree on `main` and clean; the launcher fast-forwards it to `origin/main` and refuses to start when local commits are ahead (e.g. an `udrzba/` branch left by the AIQ maintenance lane).

## Run

```bash
ssh -t honzas-macbook-pro 'cd ~/Dev/projekty/portuni && ./.sandcastle/start-loop.sh'
```

`-t` is required: the launcher runs `security unlock-keychain`, which prompts
for the old Mac's login password, then reads the tokens.

Watch: `ssh -t honzas-macbook-pro 'tmux attach -t sandcastle-portuni'` (detach Ctrl-b d).
Stop: `ssh honzas-macbook-pro 'tmux kill-session -t sandcastle-portuni'`.
Deploy harness changes: merge to `main`, then `ssh honzas-macbook-pro 'cd ~/Dev/projekty/portuni && git pull --ff-only'`
(the image needs a rebuild only when the Dockerfile changes).

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
