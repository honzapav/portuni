#!/usr/bin/env bash
# Fallow gate on the code a change introduces, measured against a base ref.
# Unused code and new duplication fail; complexity is reported as a warning
# (the complexity-* rules in .fallowrc.jsonc are set to warn). Fallow's own
# verdict treats duplication as a warning, so the duplication count is
# checked here from the JSON attribution.
set -euo pipefail
cd "$(dirname "$0")/.."

base="${1:-origin/main}"
fallow=(npx -y fallow@3.28.0)

# Human-readable report for the log; its exit code is judged below.
"${fallow[@]}" audit --base "$base" || true

report="$(mktemp)"
trap 'rm -f "$report"' EXIT
"${fallow[@]}" audit --base "$base" --format json --quiet >"$report" 2>/dev/null && status=0 || status=$?
if [ "$status" -ge 2 ]; then
  echo "fallow audit failed to run (exit $status)" >&2
  exit "$status"
fi

node -e '
  const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).attribution;
  const dead = a.dead_code_introduced, dup = a.duplication_introduced;
  console.log(`fallow gate: unused code ${dead}, duplication ${dup}, complexity ${a.complexity_introduced} (warning only)`);
  if (dead > 0 || dup > 0) {
    console.error("fallow gate: remove the unused code and the duplication this change introduces");
    process.exit(1);
  }
' "$report"
