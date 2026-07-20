#!/usr/bin/env bash
# Content smoke test of a built Portuni.app -- catches the "runtime needs a
# file the bundle doesn't carry" class of bug (the guard hook shipped broken
# for weeks because nothing ever checked the .app itself; dev servers run
# from repo dist/ where the repo layout hides the gap).
#
# Signature checks live in build-signed.sh; this script checks CONTENT only,
# so it also runs in CI against the release artifact.
#
# Accepts either a .app bundle or a .dmg. The DMG form matters in CI: with
# `--bundles dmg` Tauri deletes the intermediate .app once the DMG is built
# ("Cleaning .../Portuni.app"), so the DMG is the only artifact left -- and
# it is what users actually download.
#
# Usage:
#   scripts/verify-app-bundle.sh /path/to/Portuni.app
#   scripts/verify-app-bundle.sh /path/to/Portuni_0.7.0_aarch64.dmg
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:?usage: verify-app-bundle.sh /path/to/Portuni.app|.dmg}"

MOUNTPOINT=""
cleanup() {
  if [[ -n "$MOUNTPOINT" ]]; then
    hdiutil detach "$MOUNTPOINT" -quiet || true
    rmdir "$MOUNTPOINT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$TARGET" == *.dmg ]]; then
  [[ -f "$TARGET" ]] || { echo "no such dmg: $TARGET" >&2; exit 1; }
  MOUNTPOINT="$(mktemp -d /tmp/portuni-verify.XXXXXX)"
  hdiutil attach "$TARGET" -nobrowse -readonly -mountpoint "$MOUNTPOINT" -quiet
  # Exactly one .app is expected at the top level of the image.
  APP="$(find "$MOUNTPOINT" -maxdepth 1 -type d -name "*.app" | head -1)"
  [[ -n "$APP" ]] || { echo "no .app inside $TARGET" >&2; exit 1; }
  echo "verifying $(basename "$APP") inside $(basename "$TARGET")"
else
  APP="$TARGET"
fi

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
