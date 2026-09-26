#!/usr/bin/env bash
# The i18n part of the gate (spec: docs/superpowers/specs/2026-09-25-
# localization-design.md, "Tooling and the gate"). The catalog test
# (test/i18n-catalog.test.ts) runs with `npm test`.
set -euo pipefail
cd "$(dirname "$0")/.."

cli() { npx --no-install i18next-cli "$@"; }

echo "-- i18n: key types match the English catalog"
cli types --ci --quiet

echo "-- i18n: every Czech value present, plural forms included"
cli status cs

echo "-- i18n: no unused key"
cli status --unused

echo "-- i18n: source keys match the English catalog"
cli extract --ci --dry-run --quiet

echo "-- i18n: no hardcoded UI string, no concatenated translation"
cli lint

echo "-- i18n: no Czech text outside the catalog"
node scripts/check-ui-text.mjs
