#!/usr/bin/env bash
# The full verification gate, identical to what CI runs. Agents run this
# before every commit; a red gate is never committed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== server: lint, typecheck, test, build"
npm run qa

echo "== web: typecheck, build"
npx --prefix apps/web tsc -b apps/web --noEmit
npm --prefix apps/web run build

echo "== desktop: cargo test, clippy"
scripts/desktop-dev-placeholders.sh
( cd apps/desktop && cargo test && cargo clippy --all-targets -- -D warnings )

echo "== docs site: build"
npm --prefix sites/docs run build

echo "== gate green"
