#!/usr/bin/env bash
# Local Developer ID signed (and optionally notarized) build of Portuni.app.
#
# Prerequisites:
#   - "Developer ID Application" certificate in the login Keychain
#     (Xcode -> Settings -> Accounts -> Manage Certificates).
#   - Env vars (values live in Bitwarden, item "Portuni Apple signing"):
#       APPLE_SIGNING_IDENTITY  "Developer ID Application: <name> (<team id>)"
#     and for notarization additionally:
#       APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
#
# Usage:
#   scripts/build-signed.sh                # sign + notarize + staple
#   scripts/build-signed.sh --no-notarize  # sign only (fast iteration on
#                                          # entitlement/signing problems)
#
# Notarization is performed by Tauri itself during `cargo tauri build`
# whenever APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID are present; --no-notarize
# just unsets them for the child process. After a successful full run the
# DMG in target/release/bundle/dmg/ is what a teammate downloads.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$REPO/apps/desktop/target/release/bundle/macos/Portuni.app"

: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is not set (see header)}"

NOTARIZE=1
if [[ "${1:-}" == "--no-notarize" ]]; then
  NOTARIZE=0
fi

if [[ $NOTARIZE -eq 1 ]]; then
  : "${APPLE_ID:?APPLE_ID is not set (or use --no-notarize)}"
  : "${APPLE_PASSWORD:?APPLE_PASSWORD is not set (or use --no-notarize)}"
  : "${APPLE_TEAM_ID:?APPLE_TEAM_ID is not set (or use --no-notarize)}"
  ( cd "$REPO/apps/desktop" && cargo tauri build )
else
  ( cd "$REPO/apps/desktop" && env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID cargo tauri build )
fi

echo
echo "=== verification: $APP"

echo "--- bundle content (guard script, native bindings, sidecar)"
"$REPO/scripts/verify-app-bundle.sh" "$APP"

echo "--- codesign deep verify"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "--- Gatekeeper assessment (spctl)"
# Fails with "Unnotarized Developer ID" on --no-notarize runs; that's expected.
spctl -a -t exec -vv "$APP" || [[ $NOTARIZE -eq 0 ]]

echo "--- sidecar signature + entitlements"
SIDECAR="$APP/Contents/MacOS/portuni-sidecar"
codesign --verify --strict --verbose=2 "$SIDECAR"
codesign -d --entitlements - "$SIDECAR"

echo "--- unsigned or ad-hoc signed Mach-O files in the bundle (must be empty)"
BAD=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q "Mach-O" || continue
  if ! codesign --verify "$f" 2>/dev/null; then
    echo "UNSIGNED: $f"
    BAD=1
  elif codesign -dv "$f" 2>&1 | grep -q "Signature=adhoc"; then
    echo "ADHOC: $f"
    BAD=1
  fi
done < <(find "$APP" -type f -print0)
if [[ $BAD -eq 1 ]]; then
  echo "Notarization rejects unsigned and ad-hoc signed Mach-O files." >&2
  exit 1
fi

if [[ $NOTARIZE -eq 1 ]]; then
  # Tauri notarizes and staples the .app only; notarize the DMG too so
  # the download artifact verifies offline without the online ticket
  # lookup. (No && chains here: `a && b` never trips set -e when a fails.)
  echo "--- notarize + staple DMG"
  for dmg in "$REPO"/apps/desktop/target/release/bundle/dmg/*.dmg; do
    xcrun notarytool submit "$dmg" --wait \
      --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"
    xcrun stapler staple "$dmg"
  done
  echo "--- stapled notarization tickets"
  xcrun stapler validate "$APP"
  for dmg in "$REPO"/apps/desktop/target/release/bundle/dmg/*.dmg; do
    xcrun stapler validate "$dmg"
  done
fi

echo
echo "All checks passed."
