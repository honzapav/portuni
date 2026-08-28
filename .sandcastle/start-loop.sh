#!/usr/bin/env bash
# Starts the sandcastle loop in a background tmux session (with caffeinate).
# Watch:  tmux -L sandcastle attach -t sandcastle-portuni   (detach Ctrl-b d)
# Stop:   tmux -L sandcastle kill-session -t sandcastle-portuni
set -euo pipefail

# Own tmux socket, not the user's default server. A session created on an
# already-running server inherits that server's global environment (captured
# when the server started), not this shell's: only `update-environment` keys
# (DISPLAY, SSH_AUTH_SOCK, ...) are copied from the client. The tokens
# exported below would be dropped. A server started by this script takes its
# global environment from this process, so the session sees them.
TMUX_SOCKET=sandcastle
SESSION=sandcastle-portuni

cd "$(dirname "$0")/.."

# nvm is not on PATH in non-interactive shells (ssh, tmux): pick the newest
# installed node, otherwise npx and tsx fail.
if ! command -v node >/dev/null 2>&1; then
  NVM_NODE="$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -1)"
  [[ -n "$NVM_NODE" ]] && export PATH="$NVM_NODE:$PATH"
fi

# ssh sessions get a minimal PATH: Homebrew (tmux, docker CLI) and the Docker
# credential helper (/usr/local/bin, symlink into Docker.app) are missing.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"
for tool in tmux docker caffeinate; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing $tool on PATH." >&2; exit 1; }
done

# Secrets live in the macOS Keychain, never on disk. The committed
# .sandcastle/.env lists the variable names with empty values; sandcastle
# fills each listed key from this process's environment. A non-empty value in
# .env would be a plaintext secret, so refuse it.
if grep -qE "^[A-Z_]+=.+" .sandcastle/.env; then
  echo ".sandcastle/.env must not carry values; put secrets in the Keychain (see README)." >&2
  exit 1
fi
keychain_read() {
  security find-generic-password -s "$1" -w 2>/dev/null || true
}
CLAUDE_CODE_OAUTH_TOKEN="$(keychain_read sandcastle.claude-code.oauth-token)"
GH_TOKEN="$(keychain_read sandcastle.portuni.github-pat)"
if [[ -z "$CLAUDE_CODE_OAUTH_TOKEN" || -z "$GH_TOKEN" ]]; then
  # Over ssh the login keychain is locked; unlocking prompts for the login
  # password (needs a TTY: ssh -t).
  security unlock-keychain "$HOME/Library/Keychains/login.keychain-db" || true
  CLAUDE_CODE_OAUTH_TOKEN="$(keychain_read sandcastle.claude-code.oauth-token)"
  GH_TOKEN="$(keychain_read sandcastle.portuni.github-pat)"
fi
if [[ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]]; then
  echo "Keychain entry sandcastle.claude-code.oauth-token is missing or unreadable. Add it:" >&2
  echo "  claude setup-token   # personal profile, then:" >&2
  echo "  security add-generic-password -U -s sandcastle.claude-code.oauth-token -a \"\$USER\" -w" >&2
  exit 1
fi
if [[ -z "$GH_TOKEN" ]]; then
  echo "Keychain entry sandcastle.portuni.github-pat is missing or unreadable. Add it:" >&2
  echo "  security add-generic-password -U -s sandcastle.portuni.github-pat -a \"\$USER\" -w" >&2
  exit 1
fi
export CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN

# The agent branches off HEAD of this clone, so HEAD must be exactly
# origin/main: on main, clean, fast-forwarded. A stale clone is pulled
# forward here; a clone that is AHEAD (local commits, e.g. an udrzba/ branch
# left checked out by the AIQ maintenance lane) is refused, otherwise those
# commits would leak into the agent's batch PR.
if [[ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "Main working tree must have 'main' checked out (is on $(git rev-parse --abbrev-ref HEAD))." >&2
  exit 1
fi
# Untracked files never reach the agent's worktree; modified tracked files
# would block the fast-forward below.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Main working tree has uncommitted changes to tracked files; commit, stash or discard them first." >&2
  exit 1
fi
git fetch origin main --quiet
git merge --ff-only origin/main --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "HEAD is ahead of origin/main ($(git log --oneline origin/main..HEAD | wc -l | tr -d ' ') local commits). Push or drop them first." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running: start Docker Desktop and retry." >&2
  exit 1
fi

if [[ ! -x .sandcastle/node_modules/.bin/tsx ]]; then
  echo "Harness has no dependencies: run (cd .sandcastle && npm ci)" >&2
  exit 1
fi

# The agent image must exist before the loop starts. Build over SSH needs
# `docker logout` first (the credential helper fails on a locked keychain).
if ! docker image inspect sandcastle:portuni >/dev/null 2>&1; then
  echo "Missing Docker image sandcastle:portuni. Build it:" >&2
  echo "  ./.sandcastle/node_modules/.bin/sandcastle docker build-image \\" >&2
  echo "    --image-name sandcastle:portuni --dockerfile .sandcastle/Dockerfile" >&2
  exit 1
fi

if tmux -L "$TMUX_SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  echo "Session $SESSION is already running: tmux -L $TMUX_SOCKET attach -t $SESSION" >&2
  exit 1
fi

mkdir -p .sandcastle/logs
tmux -L "$TMUX_SOCKET" new-session -d -s "$SESSION" \
  'caffeinate -is ./.sandcastle/node_modules/.bin/tsx .sandcastle/main.mts 2>&1 | tee -a .sandcastle/logs/loop.log'

# Fail loudly instead of letting the agent run without credentials: without
# them every run dies on `gh auth setup-git`. Values stay unprinted.
# The check reads the server's global environment (-g), which is what child
# processes inherit; `show-environment -t <session>` does not list variables
# that only arrived with the server's environment.
for var in CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN; do
  if ! tmux -L "$TMUX_SOCKET" show-environment -g "$var" >/dev/null 2>&1; then
    tmux -L "$TMUX_SOCKET" kill-session -t "$SESSION" 2>/dev/null || true
    echo "$var did not reach the tmux session; the loop would fail on every run." >&2
    exit 1
  fi
done

echo "Loop running in tmux session $SESSION (socket $TMUX_SOCKET). Log: .sandcastle/logs/loop.log"
echo "Watch: tmux -L $TMUX_SOCKET attach -t $SESSION"
