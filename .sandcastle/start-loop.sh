#!/usr/bin/env bash
# Starts the sandcastle loop in a background tmux session (with caffeinate).
# Watch:  tmux attach -t sandcastle-portuni   (detach Ctrl-b d)
# Stop:   tmux kill-session -t sandcastle-portuni
set -euo pipefail

cd "$(dirname "$0")/.."

# nvm is not on PATH in non-interactive shells (ssh, tmux): pick the newest
# installed node, otherwise npx and tsx fail.
if ! command -v node >/dev/null 2>&1; then
  NVM_NODE="$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -1)"
  [[ -n "$NVM_NODE" ]] && export PATH="$NVM_NODE:$PATH"
fi

# Docker credential helper lives in /usr/local/bin (symlink into Docker.app);
# non-interactive PATH lacks it and image pulls fail with "error getting credentials".
if ! command -v docker-credential-desktop >/dev/null 2>&1; then
  export PATH="$PATH:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"
fi

if [[ ! -f .sandcastle/.env ]]; then
  echo "Missing .sandcastle/.env: create it from .sandcastle/env.example." >&2
  exit 1
fi
for key in CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN; do
  if ! grep -qE "^${key}=.+" .sandcastle/.env && [[ -z "${!key:-}" ]]; then
    echo "${key} has no value in .sandcastle/.env or the environment." >&2
    exit 1
  fi
done

# Never start from a stale branch: the agent branches off HEAD.
git fetch origin main --quiet
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "HEAD is not a fast-forward of origin/main. Run: git merge --ff-only origin/main, then start again." >&2
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

if tmux has-session -t sandcastle-portuni 2>/dev/null; then
  echo "Session sandcastle-portuni is already running: tmux attach -t sandcastle-portuni" >&2
  exit 1
fi

mkdir -p .sandcastle/logs
tmux new-session -d -s sandcastle-portuni \
  'caffeinate -is ./.sandcastle/node_modules/.bin/tsx .sandcastle/main.mts 2>&1 | tee -a .sandcastle/logs/loop.log'
echo "Loop running in tmux session sandcastle-portuni. Log: .sandcastle/logs/loop.log"
