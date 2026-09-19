#!/usr/bin/env bash
# Copy to <repo>/.sandcastle/bootstrap.sh, commit it, and drive the loop with
# one command from a clean clone:
#   ssh -t <host> 'cd <repo> && ./.sandcastle/bootstrap.sh start'
# It installs the pinned harness when .sandcastle/node_modules is missing and
# hands over to sandcastle-loop, which builds the Docker image itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# nvm is not on PATH in non-interactive shells (ssh, tmux): pick the newest
# installed node, otherwise npm is not found.
if ! command -v node >/dev/null 2>&1; then
  # Without nvm the ls fails: under `set -e -o pipefail` both the assignment
  # and a bare `[[ ... ]] && export` would end the script with no message.
  NVM_NODE="$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | sort -V | tail -1)" || NVM_NODE=""
  if [[ -n "$NVM_NODE" ]]; then export PATH="$NVM_NODE:$PATH"; fi
fi
# ssh sessions get a minimal PATH: Homebrew (tmux, docker CLI) and the Docker
# CLI shipped inside Docker.app are missing.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"

if ! command -v npm >/dev/null 2>&1; then
  echo "No node/npm found (PATH and ~/.nvm/versions/node/*/bin); install node 22+ on this machine." >&2
  exit 1
fi

LAUNCHER="$HERE/node_modules/.bin/sandcastle-loop"
if [[ ! -x "$LAUNCHER" ]]; then
  # npm ci needs the lockfile; a repo that has not committed one yet installs
  # from package.json and writes the lockfile for the next time.
  if [[ -f "$HERE/package-lock.json" ]]; then
    npm ci --prefix "$HERE"
  else
    npm install --prefix "$HERE"
  fi
fi
if [[ ! -x "$LAUNCHER" ]]; then
  echo "Harness install did not produce $LAUNCHER; check .sandcastle/package.json and the git credentials for the harness repo." >&2
  exit 1
fi

# After a pin bump run (cd .sandcastle && npm ci) once: this script only
# installs when nothing is installed at all.
exec "$LAUNCHER" "$@"
