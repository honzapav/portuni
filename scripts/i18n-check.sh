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

# Report-only until the web texts are in the catalog (#541 turns these into
# failures): source keys vs. the English catalog, and hardcoded UI strings /
# concatenated translations.
echo "-- i18n (report only): extract --ci --dry-run"
if ! cli extract --ci --dry-run --quiet; then
  echo "i18n: extract reports differences (not failing yet, see #541)"
fi

echo "-- i18n (report only): lint"
lint_log="$(mktemp)"
if ! npx --no-install i18next-cli lint > "$lint_log" 2>&1; then
  echo "i18n: lint reports $(grep -c 'Error:' "$lint_log" || true) findings (not failing yet, see #541); first ones:"
  grep 'Error:' "$lint_log" | head -5 || true
fi
rm -f "$lint_log"
