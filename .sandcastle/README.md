# Sandcastle loop (Portuni)

Autonomous agent (Claude Code, personal account) that works through GitHub
issues labelled `ready-for-agent` and commits to a batch branch
`ralph/backlog-YYYY-MM-DD`, PR only. The launcher, supervisor and prompt core
come from [`honzapav/sandcastle-harness`](https://github.com/honzapav/sandcastle-harness)
(pinned by tag in `package.json`); this directory holds only what is Portuni
specific.

## Files

| File | Purpose |
|---|---|
| `config.json` | Project id, image, Keychain entries, model, sandbox setup commands (harness README: Config) |
| `prompt.project.md` | Project section of the prompt: gate, tests, docs, repo rules |
| `Dockerfile` | node:22 + gh + claude-code + Rust toolchain + Tauri Linux deps |
| `package.json` | Pins the harness version |
| `logs/`, `worktrees/`, `prompt.generated.md` | Runtime state, gitignored |

## Prerequisites (old Mac)

1. Docker Desktop running.
2. Keychain entries `sandcastle.claude-code.oauth-token` and
   `sandcastle.portuni.github-pat` (values never on disk; the login keychain is
   locked over ssh, unlock it in the same `ssh -t` command):
   ```bash
   ssh -t honzas-macbook-pro 'security unlock-keychain ~/Library/Keychains/login.keychain-db && \
     security add-generic-password -U -s sandcastle.claude-code.oauth-token -a "$USER" -w && \
     security add-generic-password -U -s sandcastle.portuni.github-pat -a "$USER" -w'
   ```
   Claude token: `claude setup-token` (personal profile). GitHub: fine-grained
   PAT with `honzapav/portuni` selected and Contents, Issues, Pull requests:
   read and write. One PAT per repo.
3. `(cd .sandcastle && npm ci)`.
4. Image: `./.sandcastle/node_modules/.bin/sandcastle docker build-image --image-name sandcastle:portuni --dockerfile .sandcastle/Dockerfile`
5. Main working tree on `main` and clean; the launcher fast-forwards it to
   `origin/main` and refuses to start when local commits are ahead.

## Run

```bash
ssh -t honzas-macbook-pro 'cd ~/Dev/projekty/portuni && ./.sandcastle/node_modules/.bin/sandcastle-loop start'
ssh -t honzas-macbook-pro 'cd ~/Dev/projekty/portuni && ./.sandcastle/node_modules/.bin/sandcastle-loop watch'    # detach Ctrl-b d
ssh    honzas-macbook-pro 'cd ~/Dev/projekty/portuni && ./.sandcastle/node_modules/.bin/sandcastle-loop status'
ssh    honzas-macbook-pro 'cd ~/Dev/projekty/portuni && ./.sandcastle/node_modules/.bin/sandcastle-loop stop'
```

`-t` is required: the launcher may prompt for the old Mac's login password to
unlock the keychain. Knobs: `SANDCASTLE_MODEL`, `SANDCASTLE_BRANCH`,
`SANDCASTLE_SCOPE` (e.g. `"only issue #84"`), `SANDCASTLE_MAX_ITERATIONS`,
`SANDCASTLE_MAX_RUNS`.

Deploy harness or config changes: merge to `main`, then
`ssh honzas-macbook-pro 'cd ~/Dev/projekty/portuni && git pull --ff-only && (cd .sandcastle && npm ci)'`
(the image needs a rebuild only when the Dockerfile changes).

## Portuni specifics

- The gate is `scripts/agent-gate.sh`, the same checks CI runs. The container
  carries the Rust toolchain and Tauri Linux dependencies for that.
- `scripts/desktop-dev-placeholders.sh` stands in for the sidecar binary
  tauri-build expects; the real sidecar and the DMG are built by `release.yml`.
- No production credentials in the container: no Turso, Apple, Google or Drive
  secrets. macOS-only work (updater signing key, `.app` end-to-end tests,
  release publishing) is not filed as issues: issues are the agent's backlog.
  Human steps live in the spec (Verification) and the PR review.
- The agent opens or updates one PR per batch branch and never merges it.
  PR title must be a Conventional Commit (`pr-title.yml`, release-please).
