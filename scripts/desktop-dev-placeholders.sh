#!/usr/bin/env bash
# Creates the gitignored inputs tauri-build validates at compile time when
# they are absent: the sidecar binary for the host triple (externalBin) and
# the sidecar-deps resource dir. Lets `cargo check|test|clippy` run in
# apps/desktop without building the sidecar (CI, agent containers). Never
# overwrites a real sidecar.
set -euo pipefail
cd "$(dirname "$0")/../apps/desktop"
triple="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p binaries sidecar-deps
bin="binaries/portuni-sidecar-${triple}"
if [[ ! -e "$bin" ]]; then
  printf '#!/bin/sh\nexit 1\n' > "$bin"
  chmod +x "$bin"
  echo "created placeholder $bin"
fi
