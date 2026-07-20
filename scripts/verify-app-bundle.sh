#!/usr/bin/env bash
# Content smoke test of a built Portuni.app -- catches the "runtime needs a
# file the bundle doesn't carry" class of bug (the guard hook shipped broken
# for weeks because nothing ever checked the .app itself; dev servers run
# from repo dist/ where the repo layout hides the gap).
#
# Signature checks live in build-signed.sh; this script checks CONTENT only,
# so it also runs in CI against the tauri-action output.
#
# Usage: scripts/verify-app-bundle.sh /path/to/Portuni.app
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:?usage: verify-app-bundle.sh /path/to/Portuni.app}"

[[ -d "$APP" ]] || { echo "not a bundle: $APP" >&2; exit 1; }

FAIL=0
fail() { echo "MISSING: $1" >&2; FAIL=1; }
ok() { echo "ok: $1"; }

SIDECAR="$APP/Contents/MacOS/portuni-sidecar"
if [[ -x "$SIDECAR" ]]; then ok "sidecar binary"; else fail "sidecar binary ($SIDECAR)"; fi

# Guard hook: must be present AND identical to the repo copy -- a stale
# staged copy would enforce yesterday's write-scope rules.
GUARD="$APP/Contents/Resources/sidecar-deps/portuni-guard.sh"
if [[ -f "$GUARD" ]]; then
  if cmp -s "$GUARD" "$REPO/scripts/portuni-guard.sh"; then
    ok "guard script (identical to repo copy)"
  else
    echo "STALE: $GUARD differs from scripts/portuni-guard.sh" >&2
    FAIL=1
  fi
else
  fail "guard script ($GUARD) -- tier-3 write guard would be silently unenforced"
fi

# libsql native binding: the compiled sidecar require()s it at runtime; the
# Tauri host points cwd at sidecar-deps so Bun's ancestor walk finds it.
if compgen -G "$APP/Contents/Resources/sidecar-deps/node_modules/@libsql/darwin-*/*.node" > /dev/null; then
  ok "libsql native binding"
else
  fail "libsql native binding (Resources/sidecar-deps/node_modules/@libsql/darwin-*/*.node)"
fi

if [[ $FAIL -eq 1 ]]; then
  echo "bundle content verification FAILED" >&2
  exit 1
fi
echo "bundle content verification passed"
