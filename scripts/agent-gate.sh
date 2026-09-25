#!/usr/bin/env bash
# The full verification gate, identical to what CI runs. Agents run this
# before every commit; a red gate is never committed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== server: lint, typecheck, test, build"
npm run qa

# The PGlite run of the same suite (npm run test:pglite, ~10 min under the
# container's concurrency cap) is CI's job on every PR; a schema or query
# change still runs it here by hand before the PR claims both drivers.

echo "== i18n: catalog types, status, unused keys (extract and lint report only)"
npm run i18n:check

echo "== web: typecheck, build"
npx --prefix apps/web tsc -b apps/web --noEmit
npm --prefix apps/web run build

echo "== desktop: cargo test, clippy"
scripts/desktop-dev-placeholders.sh
( cd apps/desktop && cargo test && cargo clippy --all-targets -- -D warnings )

echo "== docs site: build"
npm --prefix sites/docs run build

echo "== gate green"
