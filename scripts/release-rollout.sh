#!/usr/bin/env bash
# Promote a built release to users, or roll one back.
#
# A GitHub release carries TWO independent flags, and the rollout needs both:
#
#   prerelease   eligibility. A pre-release can never be "Latest".
#   make_latest  the pin. `releases/latest` resolves to whatever this points
#                at -- and that is what every user-facing URL goes through:
#                  updater  tauri.conf.json -> releases/latest/download/latest.json
#                  website  sites/marketing  -> releases/latest/download/Portuni-macos-aarch64.dmg
#
# `gh release edit <tag> --prerelease=false` sends no make_latest at all (the
# flag is only added to the PATCH body when --latest is passed explicitly --
# cli/cli, pkg/cmd/release/edit/edit.go). It therefore clears the pre-release
# flag WITHOUT moving the pin: the release page says published, and nobody
# gets anything. Verified on v0.13.3.
#
# So this script always sets both, and then checks the endpoint users actually
# read rather than trusting the API response.
#
# Usage:
#   scripts/release-rollout.sh status
#   scripts/release-rollout.sh promote  v0.13.3
#   scripts/release-rollout.sh rollback v0.13.3 v0.13.2
set -euo pipefail

REPO="${PORTUNI_RELEASE_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
LATEST_JSON_URL="https://github.com/$REPO/releases/latest/download/latest.json"

die() { echo "error: $*" >&2; exit 1; }

usage() {
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

# The tag `releases/latest` currently resolves to, or empty when the
# repository has no full release at all (the endpoint 404s).
current_latest() {
  gh api "repos/$REPO/releases/latest" --jq '.tag_name' 2>/dev/null || true
}

require_release() {
  local tag="$1"
  gh api "repos/$REPO/releases/tags/$tag" --jq '.tag_name' > /dev/null 2>&1 \
    || die "no release for tag $tag in $REPO"
}

# Everything a user could be handed must be attached before the pin moves --
# a promoted release missing an asset is a 404 on the download button or a
# silently dead updater.
require_assets() {
  local tag="$1"
  local names
  names="$(gh api "repos/$REPO/releases/tags/$tag" --jq '.assets[].name')"
  local missing=()
  grep -q '^latest\.json$'                  <<< "$names" || missing+=("latest.json")
  grep -q '^Portuni-macos-aarch64\.dmg$'    <<< "$names" || missing+=("Portuni-macos-aarch64.dmg")
  grep -q '\.app\.tar\.gz$'                 <<< "$names" || missing+=("*.app.tar.gz")
  grep -q '\.app\.tar\.gz\.sig$'            <<< "$names" || missing+=("*.app.tar.gz.sig")
  grep -qE '^Portuni_.*\.dmg$'              <<< "$names" || missing+=("Portuni_<version>_aarch64.dmg")
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "$tag is missing release asset(s): ${missing[*]}"
  fi
  echo "ok: $tag carries all five release assets"
}

# The API can report the pin moved while the CDN still serves the old file,
# so poll the real URL rather than declaring success off the PATCH response.
verify_serving() {
  local expected_version="$1"
  local served=""
  for _ in 1 2 3 4 5 6; do
    served="$(curl -fsSL --max-time 30 "$LATEST_JSON_URL" | jq -r '.version' 2>/dev/null || true)"
    [[ "$served" == "$expected_version" ]] && { echo "ok: $LATEST_JSON_URL serves $served"; return 0; }
    sleep 5
  done
  die "$LATEST_JSON_URL still serves '${served:-<nothing>}', expected $expected_version"
}

cmd_status() {
  local latest
  latest="$(current_latest)"
  echo "repo:            $REPO"
  echo "latest pin:      ${latest:-<none>}"
  echo "updater serves:  $(curl -fsSL --max-time 30 "$LATEST_JSON_URL" | jq -r '.version' 2>/dev/null || echo '<unreachable>')"
  gh release list --repo "$REPO" --limit 5
}

cmd_promote() {
  local tag="${1:-}"
  [[ -n "$tag" ]] || usage
  require_release "$tag"
  require_assets "$tag"

  local expected_version="${tag#v}"
  local asset_version
  asset_version="$(gh release download "$tag" --repo "$REPO" --pattern latest.json --output - | jq -r '.version')"
  [[ "$asset_version" == "$expected_version" ]] \
    || die "$tag carries latest.json for version $asset_version, not $expected_version"
  echo "ok: latest.json in $tag is version $asset_version"

  echo "promoting $tag: prerelease=false, latest pin -> $tag"
  gh release edit "$tag" --repo "$REPO" --prerelease=false --latest > /dev/null

  local pinned
  pinned="$(current_latest)"
  [[ "$pinned" == "$tag" ]] \
    || die "releases/latest resolves to '${pinned:-<none>}', not $tag -- the pin did not move"
  echo "ok: releases/latest resolves to $tag"
  verify_serving "$expected_version"
  echo
  echo "$tag is live: installed apps will offer it on their next update check,"
  echo "and the website download button now serves it."
}

cmd_rollback() {
  local bad="${1:-}" good="${2:-}"
  [[ -n "$bad" && -n "$good" ]] || usage
  require_release "$bad"
  require_release "$good"
  require_assets "$good"

  # Both halves are explicit on purpose: what GitHub does with the pin when
  # the release it points at is turned back into a pre-release is not
  # documented anywhere, so we never leave it to be inferred.
  echo "rolling back: $bad -> pre-release, latest pin -> $good"
  gh release edit "$bad"  --repo "$REPO" --prerelease=true > /dev/null
  gh release edit "$good" --repo "$REPO" --prerelease=false --latest > /dev/null

  local pinned
  pinned="$(current_latest)"
  [[ "$pinned" == "$good" ]] \
    || die "releases/latest resolves to '${pinned:-<none>}', not $good -- rollback incomplete"
  echo "ok: releases/latest resolves to $good"
  verify_serving "${good#v}"
  echo
  echo "$bad is withdrawn; $good is what users get."
}

case "${1:-}" in
  status)   shift; cmd_status "$@" ;;
  promote)  shift; cmd_promote "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  -h|--help) usage 0 ;;
  *) usage ;;
esac
